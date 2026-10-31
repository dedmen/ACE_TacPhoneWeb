using Microsoft.Extensions.Logging.Abstractions;
using TacPhone.RemoteServer.Configuration;
using TacPhone.RemoteServer.Realtime;

namespace TacPhone.RemoteServer.Tests.Realtime;

public sealed class TextureCacheTests
{
    private const long DefaultMaxTotalBytes = 1024;

    [Fact]
    public void Store_ThenTryGet_Hits()
    {
        var cache = Create();
        cache.Store("key", "payload");

        Assert.True(cache.TryGet("key", out var payload));
        Assert.Equal("payload", payload);

        var stats = cache.Snapshot();
        Assert.Equal(1, stats.Entries);
        Assert.Equal("payload".Length, stats.Bytes);
        Assert.Equal(1, stats.Hits);
        Assert.Equal(0, stats.Misses);
    }

    [Fact]
    public void TryGet_MissesAnUnknownKey()
    {
        var cache = Create();
        cache.Store("key", "payload");

        Assert.False(cache.TryGet("other", out var payload));
        Assert.Equal(string.Empty, payload);
        Assert.Equal(1, cache.Snapshot().Misses);
    }

    [Fact]
    public void SameTexturePathWithADifferentMaxSizeMisses()
    {
        var cache = Create();
        var small = TextureRequest.ComputeCacheKey(@"a\b.paa", 128);
        var large = TextureRequest.ComputeCacheKey(@"a\b.paa", 256);

        cache.Store(small, "payload");

        Assert.True(cache.TryGet(small, out _));
        Assert.False(cache.TryGet(large, out _));
        Assert.Equal(1, cache.Snapshot().Hits);
        Assert.Equal(1, cache.Snapshot().Misses);
    }

    [Fact]
    public void MaxEntries_EvictsTheLeastRecentlyUsedEntry()
    {
        var cache = Create(maxEntries: 2);

        cache.Store("a", "aaa");
        cache.Store("b", "bbb");
        Assert.True(cache.TryGet("a", out _)); // Refresh a; b is now oldest.
        cache.Store("c", "ccc");

        Assert.True(cache.TryGet("a", out _));
        Assert.False(cache.TryGet("b", out _));
        Assert.True(cache.TryGet("c", out _));

        var stats = cache.Snapshot();
        Assert.Equal(2, stats.Entries);
        Assert.Equal(1, stats.Evictions);
        Assert.Equal(6, stats.Bytes);
    }

    [Fact]
    public void MaxTotalBytes_EvictsUntilThePayloadFits()
    {
        var cache = Create(maxTotalBytes: 6);

        cache.Store("a", "aaa");
        cache.Store("b", "bbb");
        cache.Store("c", "ccc");

        Assert.False(cache.TryGet("a", out _));
        Assert.True(cache.TryGet("b", out _));
        Assert.True(cache.TryGet("c", out _));

        var stats = cache.Snapshot();
        Assert.Equal(2, stats.Entries);
        Assert.Equal(6, stats.Bytes);
        Assert.Equal(1, stats.Evictions);
    }

    [Fact]
    public void APayloadLargerThanTheCacheIsNotStored()
    {
        var cache = Create(maxTotalBytes: 4, maxEntryBytes: 16);

        cache.Store("a", "too-long");

        Assert.False(cache.TryGet("a", out _));
        Assert.Equal(0, cache.Snapshot().Entries);
    }

    [Fact]
    public void APayloadLargerThanMaxEntryBytesIsNotStored()
    {
        var cache = Create(maxEntryBytes: 4);

        cache.Store("a", "too-long");
        cache.Store("b", "ok");

        Assert.False(cache.TryGet("a", out _));
        Assert.True(cache.TryGet("b", out _));
        Assert.Equal(1, cache.Snapshot().Entries);
    }

    [Fact]
    public void ReplacingAKeyAdjustsTheByteCount()
    {
        var cache = Create();

        cache.Store("a", "aaaa");
        cache.Store("a", "bb");

        var stats = cache.Snapshot();
        Assert.Equal(1, stats.Entries);
        Assert.Equal(2, stats.Bytes);
        Assert.True(cache.TryGet("a", out var payload));
        Assert.Equal("bb", payload);
    }

    [Fact]
    public void EmptyKeysAndPayloadsAreIgnored()
    {
        var cache = Create();

        cache.Store(string.Empty, "payload");
        cache.Store("key", string.Empty);

        Assert.Equal(0, cache.Snapshot().Entries);
        Assert.False(cache.HasPending);
    }

    [Fact]
    public void DisabledCache_NeverStoresOrHits()
    {
        var cache = Create(enabled: false);

        cache.Store("a", "payload");
        cache.AddPending("p_1", "nr1", "a");

        Assert.False(cache.Enabled);
        Assert.False(cache.TryGet("a", out _));
        Assert.False(cache.HasPending);
        Assert.False(cache.IsPending("p_1", "nr1"));
        Assert.False(cache.TakePending("p_1", "nr1", out _));

        var stats = cache.Snapshot();
        Assert.Equal(0, stats.Entries);
        Assert.Equal(0, stats.Bytes);
        Assert.Equal(0, stats.Hits);
        Assert.Equal(0, stats.Misses);
        Assert.Equal(0, stats.Pending);
    }

    // --------------------------------------------------------------- pending

    [Fact]
    public void AddPending_ThenTakePending_RoundTrips()
    {
        var cache = Create();

        cache.AddPending("p_1", "nr1", "texture-key");

        Assert.True(cache.HasPending);
        Assert.True(cache.IsPending("p_1", "nr1"));
        Assert.True(cache.TakePending("p_1", "nr1", out var cacheKey));
        Assert.Equal("texture-key", cacheKey);
        Assert.False(cache.HasPending);
        Assert.False(cache.TakePending("p_1", "nr1", out _));
    }

    [Fact]
    public void TakePending_RequiresTheSamePeerAndKey()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "texture-key");

        Assert.False(cache.TakePending("p_2", "nr1", out _));
        Assert.False(cache.TakePending("p_1", "nr2", out _));
        Assert.True(cache.TakePending("p_1", "nr1", out _));
    }

    [Fact]
    public void AddPending_IgnoresEmptyArguments()
    {
        var cache = Create();

        cache.AddPending(string.Empty, "nr1", "texture-key");
        cache.AddPending("p_1", string.Empty, "texture-key");
        cache.AddPending("p_1", "nr1", string.Empty);

        Assert.False(cache.HasPending);
    }

    [Fact]
    public void SweepPending_RemovesExpiredAndKeepsFreshRequests()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "texture-key");

        cache.SweepPending(TimeSpan.FromHours(1));
        Assert.True(cache.HasPending);

        cache.SweepPending(TimeSpan.Zero);
        Assert.False(cache.HasPending);
    }

    [Fact]
    public void DropPeer_RemovesPendingButKeepsCachedEntries()
    {
        var cache = Create();
        cache.Store("texture-key", "payload");
        cache.AddPending("p_1", "nr1", "texture-key");
        cache.AddPending("p_2", "nr2", "texture-key");

        cache.DropPeer("p_1");

        Assert.False(cache.IsPending("p_1", "nr1"));
        Assert.True(cache.IsPending("p_2", "nr2"));
        Assert.True(cache.TryGet("texture-key", out var payload));
        Assert.Equal("payload", payload);
        Assert.Equal(1, cache.Snapshot().Entries);
    }

    [Fact]
    public void AnErrorReplyDoesNotStoreAnything()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "texture-key");

        Assert.True(TextureRequest.TryReadReply(
            """{"k":"nr1","d":{"ok":false}}"""u8, out var replyKey, out var data));
        Assert.True(cache.TakePending("p_1", replyKey, out var cacheKey));
        Assert.Null(data);

        if (!string.IsNullOrEmpty(data))
        {
            cache.Store(cacheKey, data);
        }

        Assert.False(cache.HasPending);
        Assert.Equal(0, cache.Snapshot().Entries);
    }

    [Fact]
    public void CachedEntriesHaveNoHostConceptAndSurviveHostTeardown()
    {
        var cache = Create();
        cache.Store("texture-key", "payload");

        // The terrain cache unpins per host on disconnect; the texture cache has
        // no equivalent state, so a host session ending cannot drop the entry.
        cache.DropPeer("p_from_the_old_host_session");

        Assert.True(cache.TryGet("texture-key", out var payload));
        Assert.Equal("payload", payload);
    }

    private static TextureCache Create(
        bool enabled = true,
        long maxTotalBytes = DefaultMaxTotalBytes,
        int maxEntries = 128,
        long maxEntryBytes = 512) =>
        new(
            new TacPhoneOptions
            {
                TextureCache = new TextureCacheOptions
                {
                    Enabled = enabled,
                    MaxTotalBytes = maxTotalBytes,
                    MaxEntries = maxEntries,
                    MaxEntryBytes = maxEntryBytes,
                    PendingTimeoutSeconds = 60,
                },
            },
            NullLogger<TextureCache>.Instance);
}
