using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;

namespace TacPhone.RemoteServer.Infrastructure;

/// <summary>
/// Fixed-window, per-key rate limiter. One instance per limit kind
/// (attach attempts per IP, attach attempts per share, ...).
/// </summary>
public sealed class RateLimiter
{
    private readonly ConcurrentDictionary<string, Counter> _counters = new(StringComparer.Ordinal);
    private readonly TimeProvider _time;
    private readonly int _windowSeconds;

    public RateLimiter(TimeProvider time, int windowSeconds = 60)
    {
        ArgumentNullException.ThrowIfNull(time);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(windowSeconds);
        _time = time;
        _windowSeconds = windowSeconds;
    }

    /// <summary>Number of tracked keys; exposed for tests and the health sweep.</summary>
    public int TrackedKeys => _counters.Count;

    /// <summary>
    /// Registers one attempt for <paramref name="key"/> and reports whether it is
    /// allowed. A non-positive <paramref name="limit"/> means "unlimited".
    /// </summary>
    public bool TryAcquire(string key, int limit)
    {
        ArgumentNullException.ThrowIfNull(key);

        if (limit <= 0)
        {
            return true;
        }

        var now = _time.GetUtcNow().ToUnixTimeSeconds();
        var counter = _counters.GetOrAdd(key, static _ => new Counter());

        lock (counter)
        {
            if (now - counter.WindowStart >= _windowSeconds || now < counter.WindowStart)
            {
                counter.WindowStart = now;
                counter.Count = 0;
            }

            if (counter.Count >= limit)
            {
                return false;
            }

            counter.Count++;
            return true;
        }
    }

    /// <summary>Drops counters whose window has expired.</summary>
    public void Sweep()
    {
        var now = _time.GetUtcNow().ToUnixTimeSeconds();
        foreach (var (key, counter) in _counters)
        {
            lock (counter)
            {
                if (now - counter.WindowStart < _windowSeconds && now >= counter.WindowStart)
                {
                    continue;
                }
            }

            // Only remove if nobody replaced the entry in the meantime.
            _counters.TryRemove(new KeyValuePair<string, Counter>(key, counter));
        }
    }

    private sealed class Counter
    {
        public long WindowStart;
        public int Count;
    }
}

/// <summary>
/// The attach rate limiters: one keyed by client IP, one keyed by share id.
/// </summary>
public sealed class AttachRateLimiters
{
    public AttachRateLimiters(TimeProvider time)
    {
        PerIp = new RateLimiter(time);
        PerShare = new RateLimiter(time);
    }

    public RateLimiter PerIp { get; }

    public RateLimiter PerShare { get; }

    public void Sweep()
    {
        PerIp.Sweep();
        PerShare.Sweep();
    }
}
