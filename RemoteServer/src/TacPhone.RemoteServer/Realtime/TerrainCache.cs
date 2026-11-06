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
    private readonly Dictionary<string, List<string>> _pendingPeers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<string>> _pendingHosts = new(StringComparer.Ordinal);
    private DateTimeOffset _oldestPendingCreatedAt;
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

        lock (_pendingGate)
        {
            if (_pendingHosts.TryGetValue(hostId, out var keys))
            {
                _pendingHosts.Remove(hostId);

                foreach (var key in keys)
                {
                    RemovePendingLocked(key);
                }
            }
        }
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
            SetPendingLocked(
                PendingKey(peerId, requestKey),
                new PendingTransfer(peerId, hostId, configHash, DateTimeOffset.UtcNow));
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

        lock (_pendingGate)
        {
            if (!RemovePendingLocked(PendingKey(peerId, requestKey), out var pending))
            {
                return false;
            }

            hostId = pending.HostId;
            configHash = pending.ConfigHash;
            return true;
        }
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
                RemovePendingLocked(key);
                return ChunkResult.Failed;
            }

            hostId = transfer.HostId;
            configHash = transfer.ConfigHash;

            if (!transfer.Matches(chunk))
            {
                RemovePendingLocked(key);
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
                RemovePendingLocked(key);
                return ChunkResult.Failed;
            }

            if (!transfer.IsComplete())
            {
                return ChunkResult.Buffered;
            }

            var layers = transfer.BuildLayers();
            var payload = TerrainRequest.BuildCombinedPayload(transfer.Width, transfer.Height, layers);
            RemovePendingLocked(key);
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

        lock (_pendingGate)
        {
            if (_pendingPeers.TryGetValue(peerId, out var keys))
            {
                _pendingPeers.Remove(peerId);

                foreach (var key in keys)
                {
                    RemovePendingLocked(key);
                }
            }
        }
    }

    /// <summary>
    /// Forgets forwarded requests that never got a reply (the game dropped them or
    /// the mission ended). Called lazily and from the maintenance sweep.
    /// </summary>
    public void SweepPending(TimeSpan age)
    {
        lock (_pendingGate)
        {
            if (_pending.Count == 0)
            {
                return;
            }

            var now = DateTimeOffset.UtcNow;

            // Fast path: the oldest transfer is still fresh, so nothing can
            // be expired; the sweep stays O(1) while nothing times out.
            if (now - _oldestPendingCreatedAt < age)
            {
                return;
            }

            List<string>? doomed = null;
            var oldest = now;
            foreach (var (key, transfer) in _pending)
            {
                if (now - transfer.CreatedAt >= age)
                {
                    (doomed ??= []).Add(key);
                }
                else if (transfer.CreatedAt < oldest)
                {
                    oldest = transfer.CreatedAt;
                }
            }

            if (doomed is null)
            {
                // The age hint had gone stale; nothing expired after all.
                _oldestPendingCreatedAt = oldest;
                return;
            }

            foreach (var key in doomed)
            {
                RemovePendingLocked(key);
            }

            _oldestPendingCreatedAt = _pending.Count == 0 ? now : oldest;
        }
    }

    private void SetPendingLocked(string key, PendingTransfer transfer)
    {
        if (_pending.TryGetValue(key, out var previous))
        {
            // A reused key replaces the transfer; move the key to the new
            // peer/host buckets.
            UntrackPendingLocked(previous.PeerId, previous.HostId, key);
        }

        _pending[key] = transfer;

        TrackPendingLocked(_pendingPeers, transfer.PeerId, key);
        TrackPendingLocked(_pendingHosts, transfer.HostId, key);

        if (_pending.Count == 1 || transfer.CreatedAt < _oldestPendingCreatedAt)
        {
            _oldestPendingCreatedAt = transfer.CreatedAt;
        }
    }

    private bool RemovePendingLocked(string key, out PendingTransfer transfer)
    {
        if (!_pending.Remove(key, out transfer!))
        {
            return false;
        }

        _pendingBytes -= transfer.Bytes;
        UntrackPendingLocked(transfer.PeerId, transfer.HostId, key);
        return true;
    }

    private void RemovePendingLocked(string key)
    {
        RemovePendingLocked(key, out _);
    }

    private static void TrackPendingLocked(Dictionary<string, List<string>> buckets, string id, string key)
    {
        if (buckets.TryGetValue(id, out var keys))
        {
            keys.Add(key);
        }
        else
        {
            buckets[id] = [key];
        }
    }

    private static void UntrackPendingLocked(
        Dictionary<string, List<string>> buckets,
        string id,
        string key)
    {
        if (buckets.TryGetValue(id, out var keys))
        {
            keys.Remove(key);
            if (keys.Count == 0)
            {
                buckets.Remove(id);
            }
        }
    }

    private void UntrackPendingLocked(string peerId, string hostId, string key)
    {
        UntrackPendingLocked(_pendingPeers, peerId, key);
        UntrackPendingLocked(_pendingHosts, hostId, key);
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
