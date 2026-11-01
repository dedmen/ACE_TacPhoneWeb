using Microsoft.Extensions.Logging.Abstractions;
using TacPhone.RemoteServer.Configuration;
using TacPhone.RemoteServer.Realtime;

namespace TacPhone.RemoteServer.Tests.Realtime;

public sealed class FileCacheTests
{
    private const long DefaultMaxTotalBytes = 1024 * 1024;
    private const int DefaultMaxEntries = 128;
    private const long DefaultMaxEntryBytes = 1024 * 1024;

    [Fact]
    public void Store_ThenTryGetPinned_Hits()
    {
        var cache = Create();
        var hash = cache.Store("host1", @"a\b.js", "console.log(1);", null);

        Assert.Equal(FileCache.ComputeHash("console.log(1);"), hash);
        Assert.True(cache.TryGetPinned("host1", @"a\b.js", out var payload));
        Assert.Equal("console.log(1);", payload);

        var stats = cache.Snapshot();
        Assert.Equal(1, stats.Entries);
        Assert.Equal(1, stats.Hits);
        Assert.Equal(0, stats.Misses);
        Assert.Equal(1, stats.Pinned);
    }

    [Fact]
    public void TryGetPinned_MissesAnUnknownPath()
    {
        var cache = Create();
        cache.Store("host1", @"a\b.js", "payload", null);

        Assert.False(cache.TryGetPinned("host1", @"c\d.js", out var payload));
        Assert.Equal(string.Empty, payload);
        Assert.Equal(1, cache.Snapshot().Misses);
    }

    [Fact]
    public void TryGetPinned_NormalizesThePath()
    {
        var cache = Create();
        cache.Store("host1", @"\A\B.JS", "payload", null);

        Assert.True(cache.TryGetPinned("host1", "a/b.js", out var payload));
        Assert.Equal("payload", payload);
        Assert.Equal(1, cache.Snapshot().Pinned);
    }

    [Fact]
    public void NormalizePath_MatchesTheTextureConvention()
    {
        Assert.Equal(@"a\b.js", FileCache.NormalizePath(@"\a\b.js"));
        Assert.Equal(@"a\b.js", FileCache.NormalizePath("a/b.js"));
        Assert.Equal(@"a\b.js", FileCache.NormalizePath(@"A\B.JS"));
    }

    [Fact]
    public void IdenticalContentFromTwoHostsSharesOneEntryAndTwoPins()
    {
        var cache = Create();

        cache.Store("host1", @"a\b.js", "shared payload", null);
        cache.Store("host2", @"x\y.js", "shared payload", null);

        var stats = cache.Snapshot();
        Assert.Equal(1, stats.Entries);
        Assert.Equal(2, stats.Pinned);

        Assert.True(cache.TryGetPinned("host1", @"a\b.js", out var first));
        Assert.True(cache.TryGetPinned("host2", @"x\y.js", out var second));
        Assert.Equal("shared payload", first);
        Assert.Equal("shared payload", second);
    }

    [Fact]
    public void UnpinHost_KeepsContentAndALaterHostPinHits()
    {
        var cache = Create();
        cache.Store("host1", @"a\b.js", "sticky payload", null);

        cache.UnpinHost("host1");

        var afterUnpin = cache.Snapshot();
        Assert.Equal(1, afterUnpin.Entries);
        Assert.Equal(0, afterUnpin.Pinned);
        Assert.False(cache.TryGetPinned("host1", @"a\b.js", out _));

        cache.Pin("host2", @"c\d.js", FileCache.ComputeHash("sticky payload"));

        Assert.True(cache.TryGetPinned("host2", @"c\d.js", out var payload));
        Assert.Equal("sticky payload", payload);
        Assert.Equal(1, cache.Snapshot().Entries);
    }

    [Fact]
    public void ObserveManifest_WithoutContentSetsExpectedButStoresNothing()
    {
        var cache = Create();
        var hash = FileCache.ComputeHash("never observed");

        cache.ObserveManifest("host1", [(@"a\b.js", hash)]);

        var stats = cache.Snapshot();
        Assert.Equal(0, stats.Entries);
        Assert.Equal(1, stats.Expected);
        Assert.Equal(0, stats.Pinned);
        Assert.False(cache.TryGetPinned("host1", @"a\b.js", out _));

        Assert.True(cache.TryGetExpected("host1", @"a\b.js", out var expected));
        Assert.Equal(hash, expected);
    }

    [Fact]
    public void ObserveManifest_PinsContentThatIsAlreadyPooled()
    {
        var cache = Create();
        cache.Store("host1", @"a\b.js", "payload", null);
        cache.UnpinHost("host1");

        cache.ObserveManifest("host2", [(@"x\y.js", FileCache.ComputeHash("payload"))]);

        Assert.True(cache.TryGetPinned("host2", @"x\y.js", out var payload));
        Assert.Equal("payload", payload);
        Assert.Equal(1, cache.Snapshot().Entries);
    }

    [Fact]
    public void Eviction_PrefersAnUnpinnedEntryOverAPinnedOne()
    {
        var cache = Create(maxEntries: 2);

        cache.Store("host1", @"a.js", "A", null);
        cache.Store("host1", @"b.js", "B", null);
        cache.UnpinHost("host1");

        // "a.js" is observed again and pinned; "b.js" stays unpinned.
        cache.Store("host1", @"a.js", "A", null);
        cache.Store("host2", @"c.js", "C", null);

        var stats = cache.Snapshot();
        Assert.Equal(2, stats.Entries);
        Assert.Equal(1, stats.Evictions);

        // The unpinned "b.js" content is gone; the two pinned paths still answer.
        Assert.True(cache.TryGetPinned("host1", @"a.js", out var a));
        Assert.True(cache.TryGetPinned("host2", @"c.js", out var c));
        Assert.Equal("A", a);
        Assert.Equal("C", c);
    }

    [Fact]
    public void MaxEntryBytes_SkipsStorageButKeepsThePinAndExpectedHash()
    {
        var cache = Create(maxEntryBytes: 1);
        var text = new string('x', 4096);

        var hash = cache.Store("host1", @"a.js", text, null);

        Assert.Equal(FileCache.ComputeHash(text), hash);
        Assert.Equal(0, cache.Snapshot().Entries);
        Assert.False(cache.TryGetPinned("host1", @"a.js", out _));
        Assert.True(cache.TryGetExpected("host1", @"a.js", out _));
        Assert.Equal(1, cache.Snapshot().Pinned);
    }

    [Fact]
    public void PlainTextIsCompressedAndRoundTrips()
    {
        var cache = Create();
        var text = string.Concat(Enumerable.Repeat("export const value = 42;\n", 200));

        cache.Store("host1", @"a\b.js", text, null);

        Assert.True(cache.TryGetPinned("host1", @"a\b.js", out var payload));
        Assert.Equal(text, payload);
        Assert.True(cache.Snapshot().Bytes < text.Length);
    }

    [Fact]
    public void ACompressedBundleIsStoredVerbatimAndRoundTrips()
    {
        var cache = Create();
        var text = "TACPHONE-BUNDLE:pretend-this-is-brotli-base64";

        cache.Store("host1", @"a\b.js", text, null);

        Assert.True(cache.TryGetPinned("host1", @"a\b.js", out var payload));
        Assert.Equal(text, payload);
        Assert.Equal(System.Text.Encoding.UTF8.GetByteCount(text), cache.Snapshot().Bytes);
    }

    [Fact]
    public void Snapshot_ReportsCounters()
    {
        var cache = Create();
        cache.Store("host1", @"a.js", "payload", null);
        cache.TryGetPinned("host1", @"a.js", out _);
        cache.TryGetPinned("host1", @"missing.js", out _);
        cache.AddPending("peer1", "nr1", "host1", @"a.js");
        cache.ObserveManifest("host1", [(@"b.js", FileCache.ComputeHash("other"))]);

        var stats = cache.Snapshot();
        Assert.Equal(1, stats.Entries);
        Assert.Equal(1, stats.Hits);
        Assert.Equal(1, stats.Misses);
        Assert.Equal(0, stats.Evictions);
        Assert.Equal(1, stats.Pending);
        Assert.Equal(1, stats.Pinned);
        Assert.Equal(2, stats.Expected);
        Assert.Equal(0, stats.Sticky);
    }

    [Fact]
    public void Pending_RoundTripsAndDropsWithItsPeer()
    {
        var cache = Create();

        cache.AddPending("peer1", "nr1", "host1", @"a\b.js");

        Assert.True(cache.HasPending);
        Assert.True(cache.IsPending("peer1", "nr1"));
        Assert.True(cache.TakePending("peer1", "nr1", out var hostId, out var path));
        Assert.Equal("host1", hostId);
        Assert.Equal(@"a\b.js", path);
        Assert.False(cache.HasPending);

        cache.AddPending("peer1", "nr2", "host1", @"a.js");
        cache.AddPending("peer2", "nr3", "host1", @"b.js");
        cache.DropPeer("peer1");

        Assert.False(cache.IsPending("peer1", "nr2"));
        Assert.True(cache.IsPending("peer2", "nr3"));
    }

    [Fact]
    public void DisabledCache_NeverStoresOrHits()
    {
        var cache = Create(enabled: false);

        cache.Store("host1", @"a.js", "payload", null);
        cache.AddPending("peer1", "nr1", "host1", @"a.js");

        Assert.False(cache.Enabled);
        Assert.False(cache.TryGetPinned("host1", @"a.js", out _));
        Assert.False(cache.HasPending);

        var stats = cache.Snapshot();
        Assert.Equal(0, stats.Entries);
        Assert.Equal(0, stats.Hits);
        Assert.Equal(0, stats.Misses);
    }

    [Fact]
    public void ComputeHash_IsLowercaseSha256OfUtf8()
    {
        var hash = FileCache.ComputeHash("abc");

        Assert.Equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", hash);
    }

    private static FileCache Create(
        bool enabled = true,
        long maxTotalBytes = DefaultMaxTotalBytes,
        int maxEntries = DefaultMaxEntries,
        long maxEntryBytes = DefaultMaxEntryBytes) =>
        new(
            new TacPhoneOptions
            {
                FileCache = new FileCacheOptions
                {
                    Enabled = enabled,
                    MaxTotalBytes = maxTotalBytes,
                    MaxEntries = maxEntries,
                    MaxEntryBytes = maxEntryBytes,
                    PendingTimeoutSeconds = 60,
                },
            },
            NullLogger<FileCache>.Instance);
}
