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
    private readonly ConcurrentDictionary<string, Pending> _pending = new(StringComparer.Ordinal);

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
    public bool HasPending => !_pending.IsEmpty;

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

        if (!Enabled || string.IsNullOrEmpty(hostId) || string.IsNullOrEmpty(configHash))
        {
            return false;
        }

        lock (_gate)
        {
            if (_pins.TryGetValue(hostId, out var pin) &&
                string.Equals(pin.ConfigHash, configHash, StringComparison.Ordinal) &&
                _payloads.TryGetValue(pin.ContentHash, out var entry))
            {
                _hits++;
                payload = entry.Payload;
                return true;
            }

            _misses++;
            return false;
        }
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

        foreach (var (key, pending) in _pending)
        {
            if (string.Equals(pending.HostId, hostId, StringComparison.Ordinal))
            {
                _pending.TryRemove(key, out _);
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

        _pending[PendingKey(peerId, requestKey)] = new Pending(hostId, configHash, DateTimeOffset.UtcNow);
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

        if (!_pending.TryRemove(PendingKey(peerId, requestKey), out var pending))
        {
            return false;
        }

        hostId = pending.HostId;
        configHash = pending.ConfigHash;
        return true;
    }

    /// <summary>
    /// Forgets forwarded requests that never got a reply (the game dropped them or
    /// the mission ended). Called lazily at the start of terrain-request handling.
    /// </summary>
    public void SweepPending(TimeSpan age)
    {
        var now = DateTimeOffset.UtcNow;

        foreach (var (key, pending) in _pending)
        {
            if (now - pending.CreatedAt >= age)
            {
                _pending.TryRemove(key, out _);
            }
        }
    }

    // ----------------------------------------------------------------- stats

    /// <summary>Counters for <c>/health</c>; taken atomically.</summary>
    public TerrainCacheStats Snapshot()
    {
        lock (_gate)
        {
            return new TerrainCacheStats(_payloads.Count, _bytes, _pins.Count, _hits, _misses);
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

    private readonly record struct Pending(string HostId, string ConfigHash, DateTimeOffset CreatedAt);
}

/// <summary>A point-in-time view of the terrain cache.</summary>
public readonly record struct TerrainCacheStats(int Entries, long Bytes, int Pins, long Hits, long Misses);

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
    public static byte[] BuildReply(string requestKey, string payload)
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

    private static bool TryParseObject(ReadOnlySpan<byte> payload, out JsonDocument document)
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

    private static string? GetString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
