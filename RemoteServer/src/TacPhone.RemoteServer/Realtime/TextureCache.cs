using TacPhone.RemoteServer.Configuration;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// A global, process-local LRU cache for the game's <c>RequestTexture</c> replies.
/// </summary>
/// <remarks>
/// <para>
/// Unlike <see cref="TerrainCache"/> there is no per-host pin: a texture is
/// assumed to be stable for a given normalized file path and requested
/// <c>maxSize</c>, so one entry can answer any peer, browser session or game
/// host until it is evicted or the relay restarts.
/// </para>
/// <para>
/// Entries are not cleared on host disconnect. Only the pending correlations
/// belong to a client and are dropped when that client detaches. Payloads are
/// never logged; only counters and sizes appear in logs and <c>/health</c>.
/// </para>
/// </remarks>
public sealed class TextureCache
{
    private readonly object _gate = new();
    private readonly Dictionary<string, string> _entries = new(StringComparer.Ordinal);
    private readonly LinkedList<string> _lru = new();
    private readonly Dictionary<string, LinkedListNode<string>> _nodes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, PendingTexture> _pending = new(StringComparer.Ordinal);

    private readonly ILogger<TextureCache> _logger;
    private readonly long _maxTotalBytes;
    private readonly int _maxEntries;
    private readonly long _maxEntryBytes;

    private long _bytes;
    private long _hits;
    private long _misses;
    private long _evictions;

    public TextureCache(TacPhoneOptions options, ILogger<TextureCache> logger)
    {
        ArgumentNullException.ThrowIfNull(options);
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        var texture = options.TextureCache ?? new TextureCacheOptions();
        Enabled = texture.Enabled;
        _maxTotalBytes = Math.Max(0, texture.MaxTotalBytes);
        _maxEntries = Math.Max(0, texture.MaxEntries);
        _maxEntryBytes = Math.Max(0, texture.MaxEntryBytes);
    }

    /// <summary>The <c>TacPhone:TextureCache:Enabled</c> switch.</summary>
    public bool Enabled { get; }

    /// <summary>True while at least one forwarded texture request awaits its reply.</summary>
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
    /// Returns the cached payload for <paramref name="cacheKey"/> and refreshes its
    /// LRU position. Counts a hit or a miss.
    /// </summary>
    public bool TryGet(string cacheKey, out string payload)
    {
        payload = string.Empty;

        if (!Enabled || string.IsNullOrEmpty(cacheKey))
        {
            return false;
        }

        lock (_gate)
        {
            if (!_entries.TryGetValue(cacheKey, out var entry))
            {
                _misses++;
                return false;
            }

            if (_nodes.TryGetValue(cacheKey, out var node))
            {
                _lru.Remove(node);
                _lru.AddFirst(node);
            }

            _hits++;
            payload = entry;
            return true;
        }
    }

    /// <summary>
    /// Inserts or replaces <paramref name="cacheKey"/> and evicts least-recently
    /// used entries until the entry-count and byte caps hold. An entry larger than
    /// <c>MaxEntryBytes</c>, or larger than the whole cache, is not stored.
    /// </summary>
    public void Store(string cacheKey, string payload)
    {
        if (!Enabled ||
            string.IsNullOrEmpty(cacheKey) ||
            string.IsNullOrEmpty(payload))
        {
            return;
        }

        if (payload.Length > _maxEntryBytes)
        {
            _logger.LogDebug(
                "A texture reply ({Bytes} bytes) exceeds TextureCache:MaxEntryBytes and was not cached",
                payload.Length);
            return;
        }

        lock (_gate)
        {
            if (_entries.Remove(cacheKey, out var previous))
            {
                _bytes -= previous.Length;
                if (_nodes.Remove(cacheKey, out var previousNode))
                {
                    _lru.Remove(previousNode);
                }
            }

            if (payload.Length > _maxTotalBytes || _maxEntries <= 0)
            {
                _logger.LogDebug(
                    "A texture reply ({Bytes} bytes) cannot fit TextureCache:MaxTotalBytes/MaxEntries and was not cached",
                    payload.Length);
                return;
            }

            _entries[cacheKey] = payload;
            _nodes[cacheKey] = _lru.AddFirst(cacheKey);
            _bytes += payload.Length;

            while ((_entries.Count > _maxEntries || _bytes > _maxTotalBytes) && _lru.Last is { } oldest)
            {
                var evictedKey = oldest.Value;
                _lru.RemoveLast();
                _nodes.Remove(evictedKey);
                if (_entries.Remove(evictedKey, out var evicted))
                {
                    _bytes -= evicted.Length;
                    _evictions++;
                }
            }
        }
    }

    /// <summary>Correlates a forwarded request with the cache key its reply fills.</summary>
    public void AddPending(string peerId, string requestKey, string cacheKey)
    {
        if (!Enabled ||
            string.IsNullOrEmpty(peerId) ||
            string.IsNullOrEmpty(requestKey) ||
            string.IsNullOrEmpty(cacheKey))
        {
            return;
        }

        lock (_gate)
        {
            _pending[PendingKey(peerId, requestKey)] =
                new PendingTexture(cacheKey, DateTimeOffset.UtcNow, peerId);
        }
    }

    /// <summary>Removes and returns the cache key a reply belongs to.</summary>
    public bool TakePending(string peerId, string requestKey, out string cacheKey)
    {
        cacheKey = string.Empty;

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

            cacheKey = pending.CacheKey;
            return true;
        }
    }

    /// <summary>Drops pending correlations for a disconnected browser; entries stay.</summary>
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
    public TextureCacheStats Snapshot()
    {
        lock (_gate)
        {
            return new TextureCacheStats(_entries.Count, _bytes, _hits, _misses, _evictions, _pending.Count);
        }
    }

    private static string PendingKey(string peerId, string requestKey) => peerId + "\u0000" + requestKey;

    private readonly record struct PendingTexture(string CacheKey, DateTimeOffset CreatedAt, string PeerId);
}

/// <summary>A point-in-time view of the texture cache.</summary>
public readonly record struct TextureCacheStats(
    int Entries,
    long Bytes,
    long Hits,
    long Misses,
    long Evictions,
    int Pending);
