using System.Buffers;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using TacPhone.RemoteServer.Configuration;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// A process-local cache for the script and stringtable files a game host
/// serves for apps, their runtime module dependencies and localization.
/// </summary>
/// <remarks>
/// <para>
/// Unlike <see cref="TextureCache"/> an entry is pinned per
/// <c>(hostId, normalized path)</c>, while the payload itself is pooled globally
/// by the SHA-256 of its content. Frequently observed content therefore stays
/// resident after the host disconnects: only the pin and the expected-hash entry
/// go away.
/// </para>
/// <para>
/// Plain ESM payloads are stored Brotli-compressed and decompressed on a hit; an
/// already-compressed <c>TACPHONE-BUNDLE:</c> payload is stored verbatim.
/// Payloads are never logged; only counters and sizes appear in logs and
/// <c>/health</c>.
/// </para>
/// </remarks>
public sealed class FileCache
{
    private const string BundlePrefix = "TACPHONE-BUNDLE:";

    private readonly object _gate = new();
    private readonly Dictionary<string, ContentEntry> _content = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _pins = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _expected = new(StringComparer.Ordinal);
    private readonly Dictionary<string, PendingFile> _pending = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _observations = new(StringComparer.Ordinal);

    // Normalized paths per host, so UnpinHost drops a host's entries without a
    // prefix scan over every pin and expected hash.
    private readonly Dictionary<string, List<string>> _pathsByHost = new(StringComparer.Ordinal);

    private readonly ILogger<FileCache> _logger;
    private readonly long _maxTotalBytes;
    private readonly int _maxEntries;
    private readonly long _maxEntryBytes;

    private long _bytes;
    private long _hits;
    private long _misses;
    private long _evictions;

    public FileCache(TacPhoneOptions options, ILogger<FileCache> logger)
    {
        ArgumentNullException.ThrowIfNull(options);
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        var files = options.FileCache ?? new FileCacheOptions();
        Enabled = files.Enabled;
        _maxTotalBytes = Math.Max(0, files.MaxTotalBytes);
        _maxEntries = Math.Max(0, files.MaxEntries);
        _maxEntryBytes = Math.Max(0, files.MaxEntryBytes);
    }

    /// <summary>The <c>TacPhone:FileCache:Enabled</c> switch.</summary>
    public bool Enabled { get; }

    /// <summary>True while at least one forwarded file request awaits its reply.</summary>
    public bool HasPending
    {
        get
        {
            lock (_gate)
            {
                return _pending.Count > 0;
            }
        }
    }

    /// <summary>True when this peer already has a forwarded request under the key.</summary>
    public bool IsPending(string peerId, string requestKey)
    {
        if (!Enabled || string.IsNullOrEmpty(peerId) || string.IsNullOrEmpty(requestKey))
        {
            return false;
        }

        lock (_gate)
        {
            return _pending.ContainsKey(PendingKey(peerId, requestKey));
        }
    }

    /// <summary>
    /// Returns the original UTF-8 text pinned to <c>(hostId, path)</c> and
    /// refreshes its LRU position. Counts a hit or a miss.
    /// </summary>
    public bool TryGetPinned(string hostId, string path, out string payload)
    {
        payload = string.Empty;

        if (!Enabled || string.IsNullOrEmpty(hostId) || string.IsNullOrEmpty(path))
        {
            return false;
        }

        var normalized = NormalizePath(path);

        lock (_gate)
        {
            if (!_pins.TryGetValue(PinKey(hostId, normalized), out var hash) ||
                !_content.TryGetValue(hash, out var entry))
            {
                _misses++;
                return false;
            }

            entry.LastAccess = DateTimeOffset.UtcNow;
            _hits++;
            payload = Decode(entry);
            return true;
        }
    }

    /// <summary>Pins <paramref name="hash"/> to <c>(hostId, path)</c>.</summary>
    public void Pin(string hostId, string path, string hash)
    {
        if (!Enabled ||
            string.IsNullOrEmpty(hostId) ||
            string.IsNullOrEmpty(path) ||
            string.IsNullOrEmpty(hash))
        {
            return;
        }

        lock (_gate)
        {
            PinLocked(hostId, NormalizePath(path), hash);
        }
    }

    /// <summary>
    /// Records the manifest a host advertises: every entry counts as an
    /// observation and becomes the expected hash for its path. Content that is
    /// already pooled is pinned immediately.
    /// </summary>
    public void ObserveManifest(string hostId, IReadOnlyList<(string Path, string Hash)> files)
    {
        if (!Enabled || string.IsNullOrEmpty(hostId) || files is null)
        {
            return;
        }

        lock (_gate)
        {
            foreach (var (rawPath, hash) in files)
            {
                if (string.IsNullOrEmpty(rawPath) || string.IsNullOrEmpty(hash))
                {
                    continue;
                }

                var path = NormalizePath(rawPath);
                var key = PinKey(hostId, path);

                IncrementObservationsLocked(hash);
                _expected[key] = hash;
                RememberPathLocked(hostId, path);

                if (_content.ContainsKey(hash))
                {
                    PinLocked(hostId, path, hash);
                }
            }
        }
    }

    /// <summary>Returns the manifest hash a host advertised for <c>(hostId, path)</c>.</summary>
    public bool TryGetExpected(string hostId, string path, out string hash)
    {
        hash = string.Empty;

        if (!Enabled || string.IsNullOrEmpty(hostId) || string.IsNullOrEmpty(path))
        {
            return false;
        }

        lock (_gate)
        {
            return _expected.TryGetValue(PinKey(hostId, NormalizePath(path)), out hash!);
        }
    }

    /// <summary>Correlates a forwarded request with the host path its reply fills.</summary>
    public void AddPending(string peerId, string requestKey, string hostId, string path)
    {
        if (!Enabled ||
            string.IsNullOrEmpty(peerId) ||
            string.IsNullOrEmpty(requestKey) ||
            string.IsNullOrEmpty(hostId) ||
            string.IsNullOrEmpty(path))
        {
            return;
        }

        lock (_gate)
        {
            _pending[PendingKey(peerId, requestKey)] = new PendingFile(
                hostId,
                NormalizePath(path),
                DateTimeOffset.UtcNow,
                peerId);
        }
    }

    /// <summary>Removes and returns the host path a reply belongs to.</summary>
    public bool TakePending(string peerId, string requestKey, out string hostId, out string path)
    {
        hostId = string.Empty;
        path = string.Empty;

        if (!Enabled || string.IsNullOrEmpty(peerId) || string.IsNullOrEmpty(requestKey))
        {
            return false;
        }

        lock (_gate)
        {
            if (!_pending.Remove(PendingKey(peerId, requestKey), out var pending))
            {
                return false;
            }

            hostId = pending.HostId;
            path = pending.Path;
            return true;
        }
    }

    /// <summary>
    /// Pools <paramref name="originalText"/> by content hash, pins it to
    /// <c>(hostId, path)</c> and evicts until the caps hold. Always returns the
    /// content hash, even when the payload was not stored.
    /// </summary>
    public string Store(string hostId, string path, string originalText, string? expectedHash)
    {
        ArgumentNullException.ThrowIfNull(originalText);

        var hash = ComputeHash(originalText);

        if (!Enabled || originalText.Length == 0 || string.IsNullOrEmpty(hostId) || string.IsNullOrEmpty(path))
        {
            return hash;
        }

        // The manifest hash the host advertised is advisory: a stale manifest or a
        // file replaced without a manifest refresh must not keep a working file
        // out of the cache. Mismatches are logged for diagnosis, never with
        // payload contents.
        if (!string.IsNullOrEmpty(expectedHash) &&
            !string.Equals(hash, expectedHash, StringComparison.Ordinal))
        {
            _logger.LogWarning(
                "A file reply did not match the manifest hash on host {HostId}",
                hostId);
        }

        byte[] bytes;
        bool brotli;
        long originalLength;

        if (originalText.StartsWith(BundlePrefix, StringComparison.Ordinal))
        {
            // Already a compressed bundle: store it verbatim.
            bytes = Encoding.UTF8.GetBytes(originalText);
            brotli = false;
            originalLength = bytes.Length;
        }
        else
        {
            bytes = Compress(originalText);
            brotli = true;
            originalLength = Encoding.UTF8.GetByteCount(originalText);
        }

        lock (_gate)
        {
            var storable = bytes.Length <= _maxEntryBytes &&
                           bytes.Length <= _maxTotalBytes &&
                           _maxEntries > 0;

            if (storable)
            {
                if (_content.TryGetValue(hash, out var existing))
                {
                    existing.LastAccess = DateTimeOffset.UtcNow;
                }
                else
                {
                    var entry = new ContentEntry
                    {
                        Bytes = bytes,
                        Brotli = brotli,
                        OriginalLength = originalLength,
                        LastAccess = DateTimeOffset.UtcNow,
                    };

                    _content[hash] = entry;
                    _bytes += bytes.Length;
                }
            }
            else
            {
                _logger.LogDebug(
                    "A file reply ({Bytes} bytes) exceeds FileCache:MaxEntryBytes/MaxTotalBytes/MaxEntries and was not cached",
                    bytes.Length);
            }

            PinLocked(hostId, NormalizePath(path), hash);
            IncrementObservationsLocked(hash);
            EvictLocked();
        }

        return hash;
    }

    /// <summary>Drops pending correlations for a disconnected browser; content stays.</summary>
    public void DropPeer(string peerId)
    {
        if (string.IsNullOrEmpty(peerId))
        {
            return;
        }

        lock (_gate)
        {
            List<string>? doomed = null;
            foreach (var (key, pending) in _pending)
            {
                if (string.Equals(pending.PeerId, peerId, StringComparison.Ordinal))
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
                _pending.Remove(key);
            }
        }
    }

    /// <summary>
    /// Removes every pin and expected hash for a host and decrements the pooled
    /// content's pin counts. Content itself survives for other hosts and for its
    /// observation history.
    /// </summary>
    public void UnpinHost(string hostId)
    {
        if (string.IsNullOrEmpty(hostId))
        {
            return;
        }

        lock (_gate)
        {
            if (!_pathsByHost.TryGetValue(hostId, out var paths))
            {
                return;
            }

            _pathsByHost.Remove(hostId);

            foreach (var path in paths)
            {
                var key = PinKey(hostId, path);

                if (_pins.Remove(key, out var hash) &&
                    _content.TryGetValue(hash, out var entry))
                {
                    entry.PinnedCount = Math.Max(0, entry.PinnedCount - 1);
                }

                _expected.Remove(key);
            }
        }
    }

    /// <summary>Forgets forwarded requests that never got a reply.</summary>
    public void SweepPending(TimeSpan age)
    {
        var now = DateTimeOffset.UtcNow;

        lock (_gate)
        {
            List<string>? doomed = null;
            foreach (var (key, pending) in _pending)
            {
                if (now - pending.CreatedAt >= age)
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
                _pending.Remove(key);
            }
        }
    }

    /// <summary>Counters for <c>/health</c>; taken atomically.</summary>
    public FileCacheStats Snapshot()
    {
        lock (_gate)
        {
            var sticky = 0;
            foreach (var entry in _content.Values)
            {
                if (entry.Observations > 0 && entry.PinnedCount == 0)
                {
                    sticky++;
                }
            }

            return new FileCacheStats(
                _content.Count,
                _bytes,
                _hits,
                _misses,
                _evictions,
                _pending.Count,
                _pins.Count,
                sticky,
                _expected.Count);
        }
    }

    /// <summary>SHA-256 of the UTF-8 bytes, lowercase hex.</summary>
    public static string ComputeHash(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    }

    /// <summary>Normalizes a path the same way the game does.</summary>
    public static string NormalizePath(string path)
    {
        ArgumentException.ThrowIfNullOrEmpty(path);

        return path.Replace('/', '\\').TrimStart('\\').ToLowerInvariant();
    }

    // --------------------------------------------------------------- internals

    private void PinLocked(string hostId, string normalizedPath, string hash)
    {
        RememberPathLocked(hostId, normalizedPath);

        var key = PinKey(hostId, normalizedPath);

        if (_pins.TryGetValue(key, out var existing))
        {
            if (string.Equals(existing, hash, StringComparison.Ordinal))
            {
                _expected[key] = hash;
                if (_content.TryGetValue(hash, out var same))
                {
                    same.LastAccess = DateTimeOffset.UtcNow;
                }

                return;
            }

            if (_content.TryGetValue(existing, out var previous))
            {
                previous.PinnedCount = Math.Max(0, previous.PinnedCount - 1);
            }
        }

        _pins[key] = hash;
        _expected[key] = hash;

        if (_content.TryGetValue(hash, out var entry))
        {
            entry.PinnedCount++;
            entry.LastAccess = DateTimeOffset.UtcNow;
        }
    }

    private void IncrementObservationsLocked(string hash)
    {
        var count = _observations.TryGetValue(hash, out var current) ? current + 1 : 1;
        _observations[hash] = count;

        if (_content.TryGetValue(hash, out var entry))
        {
            entry.Observations = count;
        }
    }

    private void EvictLocked()
    {
        while (_content.Count > 0 && (_content.Count > _maxEntries || _bytes > _maxTotalBytes))
        {
            string? victim = null;
            ContentEntry? victimEntry = null;

            foreach (var (hash, entry) in _content)
            {
                if (victimEntry is null || IsEvictionCandidate(entry, victimEntry))
                {
                    victim = hash;
                    victimEntry = entry;
                }
            }

            if (victim is null || victimEntry is null)
            {
                return;
            }

            _content.Remove(victim);
            _bytes -= victimEntry.Bytes.Length;
            _evictions++;
        }
    }

    private static bool IsEvictionCandidate(ContentEntry candidate, ContentEntry current)
    {
        // Unpinned entries go first; within a group the least observed, then the
        // least recently used entry is evicted.
        var candidatePinned = candidate.PinnedCount > 0;
        var currentPinned = current.PinnedCount > 0;

        if (candidatePinned != currentPinned)
        {
            return !candidatePinned;
        }

        if (candidate.Observations != current.Observations)
        {
            return candidate.Observations < current.Observations;
        }

        return candidate.LastAccess < current.LastAccess;
    }

    private static string Decode(ContentEntry entry)
    {
        if (!entry.Brotli)
        {
            return Encoding.UTF8.GetString(entry.Bytes);
        }

        var buffer = new byte[Math.Max(1, entry.OriginalLength)];
        using var decoder = new BrotliDecoder();
        var status = decoder.Decompress(entry.Bytes, buffer, out _, out var written);

        if (status != OperationStatus.Done)
        {
            // Defensive: the recorded length was wrong, grow once.
            buffer = new byte[Math.Max(1, buffer.Length) * 2];
            using var retry = new BrotliDecoder();
            status = retry.Decompress(entry.Bytes, buffer, out _, out written);
        }

        if (status != OperationStatus.Done)
        {
            throw new InvalidOperationException("Cached file content could not be decompressed.");
        }

        return Encoding.UTF8.GetString(buffer, 0, written);
    }

    private static byte[] Compress(string text)
    {
        var source = Encoding.UTF8.GetBytes(text);
        using var output = new MemoryStream(source.Length / 2 + 16);
        using (var brotli = new BrotliStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
        {
            brotli.Write(source);
        }

        return output.ToArray();
    }

    private static string PinKey(string hostId, string normalizedPath) => hostId + "\u0000" + normalizedPath;

    private static string PendingKey(string peerId, string requestKey) => peerId + "\u0000" + requestKey;

    private void RememberPathLocked(string hostId, string normalizedPath)
    {
        if (_pathsByHost.TryGetValue(hostId, out var paths))
        {
            if (!paths.Contains(normalizedPath))
            {
                paths.Add(normalizedPath);
            }
        }
        else
        {
            _pathsByHost[hostId] = [normalizedPath];
        }
    }

    private sealed class ContentEntry
    {
        public byte[] Bytes = [];
        public bool Brotli;
        public long OriginalLength;
        public int PinnedCount;
        public long Observations;
        public DateTimeOffset LastAccess;
    }

    private readonly record struct PendingFile(
        string HostId,
        string Path,
        DateTimeOffset CreatedAt,
        string PeerId);
}
