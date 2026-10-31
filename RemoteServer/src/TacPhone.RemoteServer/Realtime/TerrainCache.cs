using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TacPhone.RemoteServer.Configuration;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// Relay-side memory for the game's <c>RequestTerrainSVG</c> reply.
/// </summary>
/// <remarks>
/// <para>
/// The request config is <b>not</b> a terrain identity: the same config can
/// produce different terrain for players in different missions. Instead each
/// game host pins at most one terrain result — the last payload the game returned
/// for that host session — and a global payload pool stores each unique
/// gzip+base64 string once, keyed by the SHA-256 of its content. The content hash
/// is a memory-dedupe key only; a host never reads another host's pin.
/// </para>
/// <para>
/// A host pin also records the config hash that produced it, which is compared to
/// decide whether a request matches the pinned result. On disconnect the pin is
/// removed and the payload's reference count drops; evicted at zero. A
/// reconnecting host starts without a pin, so its first request goes to the game.
/// </para>
/// <para>
/// Payloads and config contents are never logged; only sizes appear in warnings.
/// </para>
/// </remarks>
public sealed class TerrainCache
{
    private readonly object _gate = new();
    private readonly Dictionary<string, PayloadEntry> _payloads = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HostPin> _pins = new(StringComparer.Ordinal);

    private readonly object _pendingGate = new();
    private readonly Dictionary<string, PendingTransfer> _pending = new(StringComparer.Ordinal);
    private long _pendingBytes;

    private readonly ILogger<TerrainCache> _logger;
    private readonly long _maxBytes;

    private long _bytes;
    private long _hits;
    private long _misses;

    public TerrainCache(TacPhoneOptions options, ILogger<TerrainCache> logger)
    {
        ArgumentNullException.ThrowIfNull(options);
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        var terrain = options.TerrainCache ?? new TerrainCacheOptions();
        Enabled = terrain.Enabled;
        _maxBytes = Math.Max(0, terrain.MaxTotalBytes);
    }

    /// <summary>The <c>TacPhone:TerrainCache:Enabled</c> switch.</summary>
    public bool Enabled { get; }

    /// <summary>True while at least one forwarded terrain request awaits its reply.</summary>
    public bool HasPending
    {
        get
        {
            lock (_pendingGate)
            {
                return _pending.Count > 0;
            }
        }
    }

    // ---------------------------------------------------------------- hashes

    /// <summary>
    /// Canonical JSON of <paramref name="config"/> hashed with SHA-256, as
    /// lowercase hex. Object keys are sorted recursively; array order is kept.
    /// Returns <c>null</c> when the config is missing or not a JSON object.
    /// </summary>
    public static string? ComputeConfigHash(JsonElement config)
    {
        if (config.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        byte[] canonical;
        using (var buffer = new MemoryStream())
        {
            using (var writer = new Utf8JsonWriter(buffer))
            {
                WriteCanonical(writer, config);
            }

            canonical = buffer.ToArray();
        }

        return Convert.ToHexString(SHA256.HashData(canonical)).ToLowerInvariant();
    }

    /// <summary>
    /// SHA-256 of the UTF-8 payload string, as lowercase hex. Identical terrain
    /// from different hosts maps to one pooled payload.
    /// </summary>
    public static string ComputeContentHash(string payload)
    {
        ArgumentNullException.ThrowIfNull(payload);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payload))).ToLowerInvariant();
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();

                // Ordinal sorting makes the output independent of property order.
                // Duplicate names keep their relative order (OrderBy is stable).
                foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(writer, property.Value);
                }

                writer.WriteEndObject();
                break;

            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray())
                {
                    WriteCanonical(writer, item);
                }

                writer.WriteEndArray();
                break;

            case JsonValueKind.String:
                writer.WriteStringValue(element.GetString());
                break;

            case JsonValueKind.Number:
                // Keep the original representation: a round-trip through double
                // would lose precision and could split otherwise identical configs.
                writer.WriteRawValue(element.GetRawText(), skipInputValidation: true);
                break;

            case JsonValueKind.True:
                writer.WriteBooleanValue(true);
                break;

            case JsonValueKind.False:
                writer.WriteBooleanValue(false);
                break;

            default:
                writer.WriteNullValue();
                break;
        }
    }

    // -------------------------------------------------------------- host pins

    /// <summary>
    /// Returns the payload pinned for <paramref name="hostId"/> when it was
    /// produced by the same config. A different config, or a host without a pin,
    /// is a miss so the request is forwarded and the host re-pinned.
    /// </summary>
    public bool TryGetPin(string hostId, string configHash, out string payload)
    {
        payload = string.Empty;

        if (!Enabled)
        {
            _logger.LogInformation(
                "Terrain cache miss for host {HostId}: TacPhone:TerrainCache:Enabled is false",
                hostId);
            return false;
        }

        if (string.IsNullOrEmpty(hostId))
        {
            _logger.LogInformation("Terrain cache miss: the request has no host id");
            return false;
        }

        if (string.IsNullOrEmpty(configHash))
        {
            _logger.LogInformation(
                "Terrain cache miss for host {HostId}: the request has no config hash",
                hostId);
            return false;
        }

        var hit = false;
        var hitBytes = 0;
        string? missReason = null;

        lock (_gate)
        {
            if (!_pins.TryGetValue(hostId, out var pin))
            {
                _misses++;
                missReason = "the host has no pinned terrain for this session";
            }
            else if (!string.Equals(pin.ConfigHash, configHash, StringComparison.Ordinal))
            {
                _misses++;
                missReason = "the request config does not match the host's pinned terrain";
            }
            else if (!_payloads.TryGetValue(pin.ContentHash, out var entry))
            {
                _misses++;
                missReason = "the pinned payload is no longer in the pool";
            }
            else
            {
                _hits++;
                payload = entry.Payload;
                hitBytes = payload.Length;
                hit = true;
            }
        }

        if (hit)
        {
            _logger.LogInformation(
                "Terrain cache hit for host {HostId}: {Bytes} payload bytes",
                hostId,
                hitBytes);
        }
        else
        {
            _logger.LogInformation(
                "Terrain cache miss for host {HostId}: {Reason}",
                hostId,
                missReason);
        }

        return hit;
    }

    /// <summary>
    /// Pins <paramref name="payload"/> to <paramref name="hostId"/>, replacing (and
    /// decrementing) any previous pin with different content. A payload that
    /// would push the pool over <c>MaxTotalBytes</c> is not pinned; the host keeps
    /// its previous pin, if any. Identical content is always pinned because it
    /// adds no bytes.
    /// </summary>
    public void Pin(string hostId, string configHash, string contentHash, string payload)
    {
        if (!Enabled ||
            string.IsNullOrEmpty(hostId) ||
            string.IsNullOrEmpty(configHash) ||
            string.IsNullOrEmpty(contentHash) ||
            string.IsNullOrEmpty(payload))
        {
            return;
        }

        lock (_gate)
        {
            _pins.TryGetValue(hostId, out var previous);

            if (previous is not null && string.Equals(previous.ContentHash, contentHash, StringComparison.Ordinal))
            {
                // Same terrain: only the config hash needs refreshing.
                previous.ConfigHash = configHash;
                return;
            }

            if (!_payloads.TryGetValue(contentHash, out var entry))
            {
                if (_bytes + payload.Length > _maxBytes)
                {
                    _logger.LogWarning(
                        "A terrain payload ({Bytes} bytes) would exceed TerrainCache:MaxTotalBytes and was not cached",
                        payload.Length);
                    return;
                }

                entry = new PayloadEntry(payload, 0);
                _payloads[contentHash] = entry;
                _bytes += payload.Length;
            }

            entry.RefCount++;

            if (previous is not null)
            {
                ReleaseLocked(previous.ContentHash);
            }

            _pins[hostId] = new HostPin(configHash, contentHash);
        }
    }

    /// <summary>
    /// Drops the host's pin, decrements its payload and forgets that host's
    /// pending round-trips. Unknown hosts are a no-op.
    /// </summary>
    public void Unpin(string hostId)
    {
        if (string.IsNullOrEmpty(hostId))
        {
            return;
        }

        lock (_gate)
        {
            if (_pins.Remove(hostId, out var pin))
            {
                ReleaseLocked(pin.ContentHash);
            }
        }

        DropWhere(transfer => string.Equals(transfer.HostId, hostId, StringComparison.Ordinal));
    }

    private void ReleaseLocked(string contentHash)
    {
        if (!_payloads.TryGetValue(contentHash, out var entry))
        {
            return;
        }

        if (--entry.RefCount > 0)
        {
            return;
        }

        _payloads.Remove(contentHash);
        _bytes -= entry.Payload.Length;
    }

    // --------------------------------------------------------------- pending

    /// <summary>Records a forwarded request so its reply can be pinned.</summary>
    public void AddPending(string peerId, string requestKey, string hostId, string configHash)
    {
        if (!Enabled ||
            string.IsNullOrEmpty(peerId) ||
            string.IsNullOrEmpty(requestKey) ||
            string.IsNullOrEmpty(hostId) ||
            string.IsNullOrEmpty(configHash))
        {
            return;
        }

        lock (_pendingGate)
        {
            _pending[PendingKey(peerId, requestKey)] =
                new PendingTransfer(peerId, hostId, configHash, DateTimeOffset.UtcNow);
        }
    }

    /// <summary>True when the peer already has a forwarded request under this key.</summary>
    public bool IsPending(string peerId, string requestKey)
    {
        if (!Enabled || string.IsNullOrEmpty(peerId) || string.IsNullOrEmpty(requestKey))
        {
            return false;
        }

        lock (_pendingGate)
        {
            return _pending.ContainsKey(PendingKey(peerId, requestKey));
        }
    }

    /// <summary>Removes and returns the host/config a forwarded request belongs to.</summary>
    public bool TakePending(string peerId, string requestKey, out string hostId, out string configHash)
    {
        hostId = string.Empty;
        configHash = string.Empty;

        if (!Enabled || string.IsNullOrEmpty(peerId) || string.IsNullOrEmpty(requestKey))
        {
            return false;
        }

        PendingTransfer? pending;
        lock (_pendingGate)
        {
            if (!_pending.Remove(PendingKey(peerId, requestKey), out pending))
            {
                return false;
            }

            _pendingBytes -= pending.Bytes;
        }

        hostId = pending.HostId;
        configHash = pending.ConfigHash;
        return true;
    }

    /// <summary>
    /// Adds one layer part of a chunked terrain reply. Chunks may arrive in any
    /// order; duplicates replace an existing part.
    /// </summary>
    /// <returns>
    /// <see cref="ChunkResult.NotPending"/> or <see cref="ChunkResult.Failed"/> when
    /// the caller must forward the frame untouched (there is no transfer, the
    /// chunk is an error, or it does not match the transfer); otherwise
    /// <see cref="ChunkResult.Buffered"/> for an incomplete transfer or
    /// <see cref="ChunkResult.Completed"/> with the combined payload.
    /// </returns>
    public ChunkResult TryAddChunk(
        string peerId,
        string requestKey,
        TerrainChunk chunk,
        out TerrainPayload? completed,
        out string hostId,
        out string configHash)
    {
        completed = null;
        hostId = string.Empty;
        configHash = string.Empty;

        if (!Enabled || string.IsNullOrEmpty(peerId) || string.IsNullOrEmpty(requestKey))
        {
            return ChunkResult.NotPending;
        }

        var key = PendingKey(peerId, requestKey);

        lock (_pendingGate)
        {
            if (!_pending.TryGetValue(key, out var transfer))
            {
                return ChunkResult.NotPending;
            }

            if (chunk.Error is not null)
            {
                RemoveLocked(key, transfer);
                return ChunkResult.Failed;
            }

            hostId = transfer.HostId;
            configHash = transfer.ConfigHash;

            if (!transfer.Matches(chunk))
            {
                RemoveLocked(key, transfer);
                return ChunkResult.Failed;
            }

            var added = transfer.AddPart(chunk);
            _pendingBytes += added;

            if (Volatile.Read(ref _bytes) + _pendingBytes > _maxBytes)
            {
                // The transfer cannot be assembled within the cache budget. Drop it
                // and let the relay forward the chunks unbuffered.
                _logger.LogWarning(
                    "A chunked terrain transfer ({Bytes} buffered bytes) would exceed TerrainCache:MaxTotalBytes and was not buffered",
                    transfer.Bytes);
                RemoveLocked(key, transfer);
                return ChunkResult.Failed;
            }

            if (!transfer.IsComplete())
            {
                return ChunkResult.Buffered;
            }

            var layers = transfer.BuildLayers();
            var payload = TerrainRequest.BuildCombinedPayload(transfer.Width, transfer.Height, layers);
            RemoveLocked(key, transfer);
            completed = new TerrainPayload(transfer.Width, transfer.Height, layers, payload);
            return ChunkResult.Completed;
        }
    }

    /// <summary>Drops every buffered transfer belonging to a disconnected browser.</summary>
    public void DropPeer(string peerId)
    {
        if (string.IsNullOrEmpty(peerId))
        {
            return;
        }

        DropWhere(transfer => string.Equals(transfer.PeerId, peerId, StringComparison.Ordinal));
    }

    /// <summary>
    /// Forgets forwarded requests that never got a reply (the game dropped them or
    /// the mission ended). Called lazily and from the maintenance sweep.
    /// </summary>
    public void SweepPending(TimeSpan age)
    {
        DropWhere(transfer => DateTimeOffset.UtcNow - transfer.CreatedAt >= age);
    }

    private void DropWhere(Func<PendingTransfer, bool> predicate)
    {
        lock (_pendingGate)
        {
            List<string>? doomed = null;
            foreach (var (key, transfer) in _pending)
            {
                if (predicate(transfer))
                {
                    (doomed ??= []).Add(key);
                }
            }

            if (doomed is null)
            {
                return;
            }

            foreach (var key in doomed)
            {
                if (_pending.Remove(key, out var transfer))
                {
                    _pendingBytes -= transfer.Bytes;
                }
            }
        }
    }

    private void RemoveLocked(string key, PendingTransfer transfer)
    {
        if (_pending.Remove(key))
        {
            _pendingBytes -= transfer.Bytes;
        }
    }

    // ----------------------------------------------------------------- stats

    /// <summary>Counters for <c>/health</c>; taken atomically.</summary>
    public TerrainCacheStats Snapshot()
    {
        lock (_gate)
        {
            lock (_pendingGate)
            {
                return new TerrainCacheStats(
                    _payloads.Count,
                    _bytes,
                    _pins.Count,
                    _hits,
                    _misses,
                    _pending.Count,
                    _pendingBytes);
            }
        }
    }

    private static string PendingKey(string peerId, string requestKey) => peerId + "\u0000" + requestKey;

    private sealed class PayloadEntry(string payload, int refCount)
    {
        public string Payload { get; } = payload;

        public int RefCount { get; set; } = refCount;
    }

    private sealed class HostPin(string configHash, string contentHash)
    {
        public string ConfigHash { get; set; } = configHash;

        public string ContentHash { get; } = contentHash;
    }

    private sealed class PendingTransfer(string peerId, string hostId, string configHash, DateTimeOffset createdAt)
    {
        public string PeerId { get; } = peerId;

        public string HostId { get; } = hostId;

        public string ConfigHash { get; } = configHash;

        public DateTimeOffset CreatedAt { get; } = createdAt;

        public int Count { get; private set; } = -1;

        public int Width { get; private set; }

        public int Height { get; private set; }

        public Dictionary<int, LayerParts> Layers { get; } = new();

        public long Bytes => _bytes;

        private long _bytes;

        public bool Matches(TerrainChunk chunk)
        {
            if (Count < 0)
            {
                Count = chunk.Count;
                Width = chunk.Width;
                Height = chunk.Height;
                return true;
            }

            if (chunk.Count != Count || chunk.Width != Width || chunk.Height != Height)
            {
                return false;
            }

            return !Layers.TryGetValue(chunk.Index, out var layer) || layer.Parts == chunk.Parts;
        }

        public long AddPart(TerrainChunk chunk)
        {
            if (!Layers.TryGetValue(chunk.Index, out var layer))
            {
                layer = new LayerParts(chunk.Name, chunk.Parts);
                Layers[chunk.Index] = layer;
            }

            var hadPrevious = layer.Data.TryGetValue(chunk.Part, out var previous);
            if (hadPrevious)
            {
                _bytes -= previous!.Length;
            }

            layer.Data[chunk.Part] = chunk.Data!;
            _bytes += chunk.Data!.Length;
            return chunk.Data.Length - (hadPrevious ? previous!.Length : 0);
        }

        public bool IsComplete()
        {
            if (Count < 0 || Layers.Count != Count)
            {
                return false;
            }

            for (var index = 0; index < Count; index++)
            {
                if (!Layers.TryGetValue(index, out var layer) || layer.Data.Count != layer.Parts)
                {
                    return false;
                }
            }

            return true;
        }

        public IReadOnlyList<TerrainLayer> BuildLayers()
        {
            var layers = new List<TerrainLayer>(Count);

            for (var index = 0; index < Count; index++)
            {
                var layer = Layers[index];
                var builder = new StringBuilder();
                for (var part = 0; part < layer.Parts; part++)
                {
                    builder.Append(layer.Data[part]);
                }

                layers.Add(new TerrainLayer(layer.Name, builder.ToString()));
            }

            return layers;
        }
    }

    private sealed class LayerParts(string name, int parts)
    {
        public string Name { get; } = name;

        public int Parts { get; } = parts;

        public Dictionary<int, string> Data { get; } = new();
    }
}

/// <summary>Outcome of adding one chunk of a chunked terrain reply.</summary>
public enum ChunkResult
{
    /// <summary>No transfer is pending for this peer and request key.</summary>
    NotPending,

    /// <summary>The chunk was buffered; the transfer is still incomplete.</summary>
    Buffered,

    /// <summary>The transfer is complete and <c>completed</c> holds the payload.</summary>
    Completed,

    /// <summary>The chunk is an error or does not match the transfer, which was dropped.</summary>
    Failed,
}

/// <summary>A point-in-time view of the terrain cache.</summary>
public readonly record struct TerrainCacheStats(
    int Entries,
    long Bytes,
    int Pins,
    long Hits,
    long Misses,
    int Pending = 0,
    long PendingBytes = 0);

/// <summary>One decompressed layer of a chunked terrain reply.</summary>
public sealed record TerrainLayer(string Name, string Data);

/// <summary>A completed chunked terrain reply: canonical payload plus its layers.</summary>
public sealed record TerrainPayload(int Width, int Height, IReadOnlyList<TerrainLayer> Layers, string Data);

/// <summary>
/// One frame of a chunked <c>ReplyRequestTerrainSVG</c> reply, or its error frame.
/// </summary>
public readonly record struct TerrainChunk(
    int Index,
    int Count,
    int Part,
    int Parts,
    int Width,
    int Height,
    string Name,
    string? Data,
    string? Error);

/// <summary>
/// Parses the two application frames the terrain cache cares about: the browser's
/// <c>RequestTerrainSVG</c> request and the game's reply. Both are plain
/// <c>{k, d}</c> frames over the existing protocol; nothing about the wire format
/// changes.
/// </summary>
public static class TerrainRequest
{
    /// <summary>The app name the request must target.</summary>
    public const string App = "main";

    /// <summary>The command the relay intercepts.</summary>
    public const string Command = "RequestTerrainSVG";

    /// <summary>The command of a chunked terrain reply.</summary>
    public const string ReplyCommand = "ReplyRequestTerrainSVG";

    /// <summary>Upper bound for <c>count</c> and <c>parts</c>; larger values are malformed.</summary>
    public const int MaxChunks = 64;

    /// <summary>Maximum base64 characters per emitted layer part.</summary>
    public const int MaxTerrainChunkChars = 6 * 1024 * 1024;

    /// <summary>
    /// Parses <c>{"k":"...","d":{"a":"main","c":"RequestTerrainSVG","config":{...}}}</c>.
    /// Returns false for every other command or a malformed frame, so the relay
    /// forwards it untouched.
    /// </summary>
    public static bool TryParse(ReadOnlySpan<byte> payload, out string requestKey, out string configHash)
    {
        requestKey = string.Empty;
        configHash = string.Empty;

        if (!TryParseObject(payload, out var document))
        {
            return false;
        }

        using (document)
        {
            var root = document.RootElement;

            if (GetString(root, "k") is not { Length: > 0 } key)
            {
                return false;
            }

            if (!root.TryGetProperty("d", out var request) || request.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            if (!string.Equals(GetString(request, "a"), App, StringComparison.Ordinal) ||
                !string.Equals(GetString(request, "c"), Command, StringComparison.Ordinal))
            {
                return false;
            }

            if (!request.TryGetProperty("config", out var config) || config.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            var computed = TerrainCache.ComputeConfigHash(config);
            if (computed is null)
            {
                return false;
            }

            requestKey = key;
            configHash = computed;
            return true;
        }
    }

    /// <summary>
    /// Parses the game's reply <c>{"k":"...","d":"..."}</c>. Only a string payload
    /// counts: errors and objects are never cached. A frame without a string
    /// <c>k</c> is ignored.
    /// </summary>
    public static bool TryReadReply(ReadOnlySpan<byte> payload, out string requestKey, out string? data)
    {
        requestKey = string.Empty;
        data = null;

        if (!TryParseObject(payload, out var document))
        {
            return false;
        }

        using (document)
        {
            var root = document.RootElement;

            if (GetString(root, "k") is not { Length: > 0 } key)
            {
                return false;
            }

            if (!root.TryGetProperty("d", out var value))
            {
                return false;
            }

            requestKey = key;
            data = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            return true;
        }
    }

    /// <summary>Builds the cache-hit reply <c>{"k":"&lt;k&gt;","d":"&lt;payload&gt;"}</c>.</summary>
    public static byte[] BuildReply(string requestKey, string payload) => AppReply.Build(requestKey, payload);

    /// <summary>
    /// Parses one chunk frame of a chunked terrain reply. A chunk either carries a
    /// non-empty <c>data</c> string plus the layer indices, or a non-empty
    /// <c>error</c> string. Bounds are validated here so an assembly cannot be
    /// driven past <c>count</c>/<c>parts</c> = 64.
    /// </summary>
    public static bool TryReadChunk(
        ReadOnlySpan<byte> payload,
        out string requestKey,
        out TerrainChunk chunk)
    {
        requestKey = string.Empty;
        chunk = default;

        if (!AppFrameJson.TryParseObject(payload, out var document))
        {
            return false;
        }

        using (document)
        {
            var root = document.RootElement;

            if (AppFrameJson.GetString(root, "k") is not { Length: > 0 } key)
            {
                return false;
            }

            if (!root.TryGetProperty("d", out var reply) || reply.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            if (!string.Equals(AppFrameJson.GetString(reply, "c"), ReplyCommand, StringComparison.Ordinal))
            {
                return false;
            }

            if (AppFrameJson.GetString(reply, "error") is { Length: > 0 } error)
            {
                requestKey = key;
                chunk = new TerrainChunk(0, 1, 0, 1, 0, 0, string.Empty, null, error);
                return true;
            }

            if (AppFrameJson.GetString(reply, "data") is not { Length: > 0 } data)
            {
                return false;
            }

            var index = AppFrameJson.GetInt(reply, "index");
            var count = AppFrameJson.GetInt(reply, "count");
            if (index is null or < 0 || count is null or < 1 or > MaxChunks || index >= count)
            {
                return false;
            }

            var part = AppFrameJson.GetInt(reply, "part") ?? 0;
            var parts = AppFrameJson.GetInt(reply, "parts") ?? 1;
            if (part < 0 || parts < 1 || parts > MaxChunks || part >= parts)
            {
                return false;
            }

            var width = AppFrameJson.GetInt(reply, "width");
            var height = AppFrameJson.GetInt(reply, "height");
            if (width is null or <= 0 || height is null or <= 0)
            {
                return false;
            }

            var name = AppFrameJson.GetString(reply, "name");
            requestKey = key;
            chunk = new TerrainChunk(
                index.Value,
                count.Value,
                part,
                parts,
                width.Value,
                height.Value,
                string.IsNullOrEmpty(name) ? $"Layer {index.Value + 1}" : name,
                data,
                null);
            return true;
        }
    }

    /// <summary>
    /// Canonical cache entry for a chunked transfer:
    /// <c>{"width":W,"height":H,"layers":[{"name":"...","data":"..."}]}</c>.
    /// </summary>
    public static string BuildCombinedPayload(int width, int height, IReadOnlyList<TerrainLayer> layers)
    {
        ArgumentNullException.ThrowIfNull(layers);

        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("width", width);
            writer.WriteNumber("height", height);
            writer.WriteStartArray("layers");

            foreach (var layer in layers)
            {
                writer.WriteStartObject();
                writer.WriteString("name", layer.Name);
                writer.WriteString("data", layer.Data);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>
    /// Splits a combined payload back into layer frames for a cache hit. Returns
    /// false when <paramref name="payload"/> is not a combined payload (for
    /// example a legacy whole-SVG string), so the caller can emit the old single
    /// frame instead.
    /// </summary>
    public static bool TryBuildLayerFrames(
        string requestKey,
        string payload,
        int maxChars,
        out IReadOnlyList<byte[]> frames)
    {
        frames = Array.Empty<byte[]>();

        if (string.IsNullOrEmpty(requestKey) ||
            string.IsNullOrEmpty(payload) ||
            payload[0] != '{')
        {
            return false;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(payload);
        }
        catch (JsonException)
        {
            return false;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("width", out var widthElement) ||
                !widthElement.TryGetInt32(out var width) ||
                width <= 0 ||
                !root.TryGetProperty("height", out var heightElement) ||
                !heightElement.TryGetInt32(out var height) ||
                height <= 0 ||
                !root.TryGetProperty("layers", out var layersElement) ||
                layersElement.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            var layers = new List<TerrainLayer>();
            foreach (var layer in layersElement.EnumerateArray())
            {
                if (layer.ValueKind != JsonValueKind.Object ||
                    AppFrameJson.GetString(layer, "name") is not { } name ||
                    AppFrameJson.GetString(layer, "data") is not { } data ||
                    data.Length == 0 ||
                    layers.Count >= MaxChunks)
                {
                    return false;
                }

                layers.Add(new TerrainLayer(name, data));
            }

            if (layers.Count == 0)
            {
                return false;
            }

            frames = BuildLayerFrames(requestKey, width, height, layers, maxChars);
            return true;
        }
    }

    /// <summary>Builds one frame per layer part, in index/part order.</summary>
    public static IReadOnlyList<byte[]> BuildLayerFrames(
        string requestKey,
        int width,
        int height,
        IReadOnlyList<TerrainLayer> layers,
        int maxChars)
    {
        ArgumentException.ThrowIfNullOrEmpty(requestKey);
        ArgumentNullException.ThrowIfNull(layers);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxChars, 1);

        var frames = new List<byte[]>();
        var count = layers.Count;

        for (var index = 0; index < count; index++)
        {
            var layer = layers[index];
            var parts = SplitBase64(layer.Data, maxChars);

            for (var part = 0; part < parts.Count; part++)
            {
                frames.Add(BuildChunkFrame(
                    requestKey,
                    index,
                    count,
                    part,
                    parts.Count,
                    width,
                    height,
                    layer.Name,
                    parts[part],
                    last: index == count - 1 && part == parts.Count - 1));
            }
        }

        return frames;
    }

    /// <summary>Builds frames from a completed payload.</summary>
    public static IReadOnlyList<byte[]> BuildLayerFrames(
        string requestKey,
        TerrainPayload payload,
        int maxChars)
    {
        ArgumentNullException.ThrowIfNull(payload);
        return BuildLayerFrames(requestKey, payload.Width, payload.Height, payload.Layers, maxChars);
    }

    private static List<string> SplitBase64(string data, int maxChars)
    {
        if (data.Length == 0)
        {
            return [string.Empty];
        }

        var parts = new List<string>((data.Length / maxChars) + 1);
        for (var offset = 0; offset < data.Length; offset += maxChars)
        {
            parts.Add(data.Substring(offset, Math.Min(maxChars, data.Length - offset)));
        }

        return parts;
    }

    private static byte[] BuildChunkFrame(
        string requestKey,
        int index,
        int count,
        int part,
        int parts,
        int width,
        int height,
        string name,
        string data,
        bool last)
    {
        using var buffer = new MemoryStream(data.Length + 256);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("k", requestKey);
            writer.WriteStartObject("d");
            writer.WriteString("a", App);
            writer.WriteString("c", ReplyCommand);
            writer.WriteNumber("index", index);
            writer.WriteNumber("count", count);
            writer.WriteNumber("part", part);
            writer.WriteNumber("parts", parts);
            writer.WriteString("name", name);
            writer.WriteNumber("width", width);
            writer.WriteNumber("height", height);
            writer.WriteString("data", data);
            writer.WriteBoolean("last", last);
            writer.WriteEndObject();
            writer.WriteEndObject();
        }

        return buffer.ToArray();
    }

    internal static bool TryParseObject(ReadOnlySpan<byte> payload, out JsonDocument document) =>
        AppFrameJson.TryParseObject(payload, out document);

    internal static string? GetString(JsonElement element, string name) =>
        AppFrameJson.GetString(element, name);
}

/// <summary>A <c>{"k":"...","d":"..."}</c> application reply frame.</summary>
internal static class AppReply
{
    public static byte[] Build(string requestKey, string payload)
    {
        ArgumentException.ThrowIfNullOrEmpty(requestKey);
        ArgumentNullException.ThrowIfNull(payload);

        using var buffer = new MemoryStream(payload.Length + requestKey.Length + 16);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("k", requestKey);
            writer.WriteString("d", payload);
            writer.WriteEndObject();
        }

        return buffer.ToArray();
    }
}

/// <summary>Small parsers shared by the terrain and texture frame readers.</summary>
internal static class AppFrameJson
{
    public static bool TryParseObject(ReadOnlySpan<byte> payload, out JsonDocument document)
    {
        document = null!;

        if (payload.IsEmpty)
        {
            return false;
        }

        try
        {
            // Utf8JsonReader works directly on the frame buffer, so no copy is
            // made for the (rare) frames the relay has to look into.
            var reader = new Utf8JsonReader(payload, isFinalBlock: true, state: default);
            var parsed = JsonDocument.ParseValue(ref reader);

            if (parsed.RootElement.ValueKind != JsonValueKind.Object)
            {
                parsed.Dispose();
                return false;
            }

            // Exactly one value per frame; trailing data is not a protocol frame.
            if (reader.Read())
            {
                parsed.Dispose();
                return false;
            }

            document = parsed;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    public static string? GetString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    public static int? GetInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt32(out var number)
            ? number
            : null;
}
