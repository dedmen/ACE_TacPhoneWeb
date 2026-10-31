using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using TacPhone.RemoteServer.Configuration;
using TacPhone.RemoteServer.Realtime;

namespace TacPhone.RemoteServer.Tests.Realtime;

public sealed class TerrainCacheTests
{
    private const long DefaultMaxBytes = 64L * 1024 * 1024;
    private const string ConfigHashA = "config-a";
    private const string ConfigHashB = "config-b";

    // -------------------------------------------------------------- config hash

    [Fact]
    public void ComputeConfigHash_IsStableAcrossPropertyOrder()
    {
        using var first = JsonDocument.Parse("""{"world":"altis","size":2048,"nested":{"b":2,"a":1}}""");
        using var second = JsonDocument.Parse("""{"nested":{"a":1,"b":2},"size":2048,"world":"altis"}""");

        var hash = TerrainCache.ComputeConfigHash(first.RootElement);

        Assert.NotNull(hash);
        Assert.Equal(64, hash!.Length);
        Assert.Equal(hash, TerrainCache.ComputeConfigHash(second.RootElement));
    }

    [Fact]
    public void ComputeConfigHash_KeepsArrayOrderAndValues()
    {
        using var ascending = JsonDocument.Parse("""{"z":[1,2]}""");
        using var descending = JsonDocument.Parse("""{"z":[2,1]}""");
        using var otherValue = JsonDocument.Parse("""{"z":[1,3]}""");

        var hash = TerrainCache.ComputeConfigHash(ascending.RootElement);

        Assert.NotEqual(hash, TerrainCache.ComputeConfigHash(descending.RootElement));
        Assert.NotEqual(hash, TerrainCache.ComputeConfigHash(otherValue.RootElement));
    }

    [Fact]
    public void ComputeConfigHash_ReturnsNullForNonObjectConfig()
    {
        using var array = JsonDocument.Parse("""[1,2]""");
        using var text = JsonDocument.Parse("\"altis\"");
        using var number = JsonDocument.Parse("42");

        Assert.Null(TerrainCache.ComputeConfigHash(array.RootElement));
        Assert.Null(TerrainCache.ComputeConfigHash(text.RootElement));
        Assert.Null(TerrainCache.ComputeConfigHash(number.RootElement));
    }

    [Fact]
    public void ComputeContentHash_IsStableAndDistinguishesContent()
    {
        var first = TerrainCache.ComputeContentHash("H4sIAAAA");
        var second = TerrainCache.ComputeContentHash("H4sIAAAA");
        var other = TerrainCache.ComputeContentHash("H4sIAAAB");

        Assert.Equal(64, first.Length);
        Assert.Equal(first, second);
        Assert.NotEqual(first, other);
    }

    // ------------------------------------------------------------ pins / hits

    [Fact]
    public void Pin_ThenTryGetPin_HitsForTheSameConfig()
    {
        var cache = Create();

        cache.Pin("host-a", ConfigHashA, TerrainCache.ComputeContentHash("payload"), "payload");

        Assert.True(cache.TryGetPin("host-a", ConfigHashA, out var payload));
        Assert.Equal("payload", payload);

        var stats = cache.Snapshot();
        Assert.Equal(1, stats.Entries);
        Assert.Equal(1, stats.Pins);
        Assert.Equal("payload".Length, stats.Bytes);
        Assert.Equal(1, stats.Hits);
        Assert.Equal(0, stats.Misses);
    }

    [Fact]
    public void TryGetPin_MissesOnADifferentConfig()
    {
        var cache = Create();
        cache.Pin("host-a", ConfigHashA, TerrainCache.ComputeContentHash("payload"), "payload");

        Assert.False(cache.TryGetPin("host-a", ConfigHashB, out var payload));
        Assert.Equal(string.Empty, payload);
        Assert.Equal(1, cache.Snapshot().Misses);
    }

    [Fact]
    public void TryGetPin_MissesForAnotherHostAndUnknownHosts()
    {
        var cache = Create();
        cache.Pin("host-a", ConfigHashA, TerrainCache.ComputeContentHash("payload"), "payload");

        Assert.False(cache.TryGetPin("host-b", ConfigHashA, out _));
        Assert.False(cache.TryGetPin("host-unknown", ConfigHashA, out _));

        // host-a's pin survives the other hosts' misses.
        Assert.True(cache.TryGetPin("host-a", ConfigHashA, out _));
    }

    [Fact]
    public void TryGetPin_MissesForEmptyArguments()
    {
        var cache = Create();
        cache.Pin("host-a", ConfigHashA, TerrainCache.ComputeContentHash("payload"), "payload");

        Assert.False(cache.TryGetPin(string.Empty, ConfigHashA, out _));
        Assert.False(cache.TryGetPin("host-a", string.Empty, out _));
    }

    [Fact]
    public void Pin_IgnoresEmptyArguments()
    {
        var cache = Create();

        cache.Pin(string.Empty, ConfigHashA, "hash", "payload");
        cache.Pin("host-a", string.Empty, "hash", "payload");
        cache.Pin("host-a", ConfigHashA, string.Empty, "payload");
        cache.Pin("host-a", ConfigHashA, "hash", string.Empty);

        var stats = cache.Snapshot();
        Assert.Equal(0, stats.Entries);
        Assert.Equal(0, stats.Pins);
        Assert.Equal(0, stats.Bytes);
    }

    // -------------------------------------------------------- content dedupe

    [Fact]
    public void TwoHostsWithTheSamePayloadShareOneEntry()
    {
        var cache = Create();
        var contentHash = TerrainCache.ComputeContentHash("payload");

        cache.Pin("host-a", ConfigHashA, contentHash, "payload");
        cache.Pin("host-b", ConfigHashB, contentHash, "payload");

        var stats = cache.Snapshot();
        Assert.Equal(1, stats.Entries);
        Assert.Equal(2, stats.Pins);
        Assert.Equal("payload".Length, stats.Bytes);

        cache.Unpin("host-a");
        Assert.Equal(1, cache.Snapshot().Entries);
        Assert.True(cache.TryGetPin("host-b", ConfigHashB, out var payload));
        Assert.Equal("payload", payload);

        cache.Unpin("host-b");
        Assert.Equal(0, cache.Snapshot().Entries);
        Assert.Equal(0, cache.Snapshot().Bytes);
        Assert.Equal(0, cache.Snapshot().Pins);
    }

    [Fact]
    public void RepinningADifferentPayloadReleasesTheOldOne()
    {
        var cache = Create();
        var first = TerrainCache.ComputeContentHash("first");
        var second = TerrainCache.ComputeContentHash("second");

        cache.Pin("host-a", ConfigHashA, first, "first");
        cache.Pin("host-a", ConfigHashA, second, "second");

        var stats = cache.Snapshot();
        Assert.Equal(1, stats.Entries);
        Assert.Equal(1, stats.Pins);
        Assert.Equal("second".Length, stats.Bytes);
        Assert.True(cache.TryGetPin("host-a", ConfigHashA, out var payload));
        Assert.Equal("second", payload);
    }

    [Fact]
    public void RepinningTheSameContentOnlyRefreshesTheConfigHash()
    {
        var cache = Create();
        var contentHash = TerrainCache.ComputeContentHash("payload");

        cache.Pin("host-a", ConfigHashA, contentHash, "payload");
        cache.Pin("host-a", ConfigHashB, contentHash, "payload");

        Assert.Equal(1, cache.Snapshot().Entries);
        Assert.Equal("payload".Length, cache.Snapshot().Bytes);
        Assert.False(cache.TryGetPin("host-a", ConfigHashA, out _));
        Assert.True(cache.TryGetPin("host-a", ConfigHashB, out var payload));
        Assert.Equal("payload", payload);
    }

    [Fact]
    public void Unpin_UnknownHostIsANoOp()
    {
        var cache = Create();
        cache.Pin("host-a", ConfigHashA, TerrainCache.ComputeContentHash("payload"), "payload");

        cache.Unpin("host-b");
        cache.Unpin(string.Empty);

        var stats = cache.Snapshot();
        Assert.Equal(1, stats.Entries);
        Assert.Equal(1, stats.Pins);
        Assert.True(cache.TryGetPin("host-a", ConfigHashA, out _));
    }

    // ------------------------------------------------------------------- cap

    [Fact]
    public void MaxTotalBytes_PreventsPinningANewPayload()
    {
        var cache = Create(maxBytes: 4);

        cache.Pin("host-a", ConfigHashA, TerrainCache.ComputeContentHash("payload"), "payload");

        var stats = cache.Snapshot();
        Assert.Equal(0, stats.Entries);
        Assert.Equal(0, stats.Pins);
        Assert.Equal(0, stats.Bytes);
        Assert.False(cache.TryGetPin("host-a", ConfigHashA, out _));
    }

    [Fact]
    public void MaxTotalBytes_StillAllowsAnAlreadyPooledPayload()
    {
        var cache = Create(maxBytes: 12);
        var contentHash = TerrainCache.ComputeContentHash("payload");

        cache.Pin("host-a", ConfigHashA, contentHash, "payload");
        cache.Pin("host-b", ConfigHashB, contentHash, "payload");

        var stats = cache.Snapshot();
        Assert.Equal(1, stats.Entries);
        Assert.Equal(2, stats.Pins);
        Assert.Equal("payload".Length, stats.Bytes);
    }

    [Fact]
    public void MaxTotalBytes_DoesNotDropThePreviousPinWhenTheNewPayloadIsRejected()
    {
        var cache = Create(maxBytes: 5);
        var first = TerrainCache.ComputeContentHash("first");

        cache.Pin("host-a", ConfigHashA, first, "first");
        cache.Pin("host-a", ConfigHashB, TerrainCache.ComputeContentHash("second-payload"), "second-payload");

        Assert.Equal(1, cache.Snapshot().Entries);
        Assert.Equal("first".Length, cache.Snapshot().Bytes);
        Assert.True(cache.TryGetPin("host-a", ConfigHashA, out var payload));
        Assert.Equal("first", payload);
    }

    // --------------------------------------------------------------- pending

    [Fact]
    public void AddPending_ThenTakePending_RoundTrips()
    {
        var cache = Create();

        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        Assert.True(cache.HasPending);
        Assert.True(cache.TakePending("p_1", "nr1", out var hostId, out var configHash));
        Assert.Equal("host-a", hostId);
        Assert.Equal(ConfigHashA, configHash);
        Assert.False(cache.HasPending);
        Assert.False(cache.TakePending("p_1", "nr1", out _, out _));
    }

    [Fact]
    public void TakePending_ReturnsFalseForUnknownOrDifferentPeer()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        Assert.False(cache.TakePending("p_2", "nr1", out _, out _));
        Assert.False(cache.TakePending("p_1", "nr2", out _, out _));
        Assert.True(cache.TakePending("p_1", "nr1", out _, out _));
    }

    [Fact]
    public void AddPending_IgnoresEmptyArguments()
    {
        var cache = Create();

        cache.AddPending(string.Empty, "nr1", "host-a", ConfigHashA);
        cache.AddPending("p_1", string.Empty, "host-a", ConfigHashA);
        cache.AddPending("p_1", "nr1", string.Empty, ConfigHashA);
        cache.AddPending("p_1", "nr1", "host-a", string.Empty);

        Assert.False(cache.HasPending);
    }

    [Fact]
    public void SweepPending_RemovesExpiredRequests()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        cache.SweepPending(TimeSpan.Zero);

        Assert.False(cache.HasPending);
        Assert.False(cache.TakePending("p_1", "nr1", out _, out _));
    }

    [Fact]
    public void SweepPending_KeepsFreshRequests()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        cache.SweepPending(TimeSpan.FromHours(1));

        Assert.True(cache.HasPending);
        Assert.True(cache.TakePending("p_1", "nr1", out _, out _));
    }

    [Fact]
    public void Unpin_ForgetsPendingEntriesForThatHostOnly()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);
        cache.AddPending("p_2", "nr2", "host-b", ConfigHashA);

        cache.Unpin("host-a");

        Assert.True(cache.HasPending);
        Assert.False(cache.TakePending("p_1", "nr1", out _, out _));
        Assert.True(cache.TakePending("p_2", "nr2", out var hostId, out _));
        Assert.Equal("host-b", hostId);
    }

    [Fact]
    public void PendingTimeout_ComesFromTheOptions()
    {
        Assert.True(new TacPhoneOptions().TerrainCache.Enabled);
        Assert.Equal(TimeSpan.FromSeconds(60), new TerrainCacheOptions().PendingTimeout());
        Assert.Equal(TimeSpan.FromSeconds(5), new TerrainCacheOptions { PendingTimeoutSeconds = 5 }.PendingTimeout());
    }

    // -------------------------------------------------------------- disabled

    [Fact]
    public void DisabledCache_NeverHitsPinsOrPends()
    {
        var cache = Create(enabled: false);

        cache.Pin("host-a", ConfigHashA, TerrainCache.ComputeContentHash("payload"), "payload");
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        Assert.False(cache.Enabled);
        Assert.False(cache.TryGetPin("host-a", ConfigHashA, out _));
        Assert.False(cache.HasPending);
        Assert.False(cache.TakePending("p_1", "nr1", out _, out _));

        var stats = cache.Snapshot();
        Assert.Equal(0, stats.Entries);
        Assert.Equal(0, stats.Bytes);
        Assert.Equal(0, stats.Pins);
        Assert.Equal(0, stats.Hits);
        Assert.Equal(0, stats.Misses);
    }

    // --------------------------------------------------------- chunk assembly

    [Fact]
    public void TryAddChunk_BuffersThenCompletesOutOfOrder()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        Assert.Equal(
            ChunkResult.Buffered,
            cache.TryAddChunk("p_1", "nr1", Chunk(1, 2, data: "BBBB"), out var incomplete, out _, out _));
        Assert.Null(incomplete);
        Assert.Equal(1, cache.Snapshot().Pending);
        Assert.Equal(4, cache.Snapshot().PendingBytes);

        var result = cache.TryAddChunk(
            "p_1", "nr1", Chunk(0, 2, data: "AAAA"), out var completed, out var hostId, out var configHash);

        Assert.Equal(ChunkResult.Completed, result);
        Assert.NotNull(completed);
        Assert.Equal("host-a", hostId);
        Assert.Equal(ConfigHashA, configHash);
        Assert.Equal(16, completed!.Width);
        Assert.Equal(16, completed.Height);
        Assert.Equal(["Layer 1", "Layer 1"], completed.Layers.Select(layer => layer.Name).ToArray());
        Assert.Equal(["AAAA", "BBBB"], completed.Layers.Select(layer => layer.Data).ToArray());
        Assert.Equal(
            """{"width":16,"height":16,"layers":[{"name":"Layer 1","data":"AAAA"},{"name":"Layer 1","data":"BBBB"}]}""",
            completed.Data);

        var stats = cache.Snapshot();
        Assert.Equal(0, stats.Pending);
        Assert.Equal(0, stats.PendingBytes);
        Assert.False(cache.HasPending);
    }

    [Fact]
    public void TryAddChunk_CombinesLayerPartsInOrder()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        Assert.Equal(ChunkResult.Buffered,
            cache.TryAddChunk("p_1", "nr1", Chunk(0, 1, part: 2, parts: 3, data: "cc"), out _, out _, out _));
        Assert.Equal(ChunkResult.Buffered,
            cache.TryAddChunk("p_1", "nr1", Chunk(0, 1, part: 0, parts: 3, data: "aa"), out _, out _, out _));

        Assert.Equal(ChunkResult.Completed,
            cache.TryAddChunk("p_1", "nr1", Chunk(0, 1, part: 1, parts: 3, data: "bb"), out var completed, out _, out _));
        Assert.Equal("aabbcc", completed!.Layers[0].Data);
    }

    [Fact]
    public void TryAddChunk_DuplicatePartReplacesTheValue()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        Assert.Equal(ChunkResult.Buffered,
            cache.TryAddChunk("p_1", "nr1", Chunk(0, 2, data: "old"), out _, out _, out _));
        Assert.Equal(ChunkResult.Buffered,
            cache.TryAddChunk("p_1", "nr1", Chunk(0, 2, data: "newer"), out _, out _, out _));
        Assert.Equal(5, cache.Snapshot().PendingBytes);

        Assert.Equal(ChunkResult.Completed,
            cache.TryAddChunk("p_1", "nr1", Chunk(1, 2, data: "second"), out var completed, out _, out _));
        Assert.Equal(["newer", "second"], completed!.Layers.Select(layer => layer.Data).ToArray());
    }

    [Fact]
    public void TryAddChunk_WithoutAPendingTransferIsNotPending()
    {
        var cache = Create();

        Assert.Equal(
            ChunkResult.NotPending,
            cache.TryAddChunk("p_1", "nr1", Chunk(0, 1), out _, out _, out _));
    }

    [Fact]
    public void TryAddChunk_CountMismatchDropsTheTransfer()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        Assert.Equal(ChunkResult.Buffered,
            cache.TryAddChunk("p_1", "nr1", Chunk(0, 2), out _, out _, out _));
        Assert.Equal(ChunkResult.Failed,
            cache.TryAddChunk("p_1", "nr1", Chunk(1, 3), out _, out _, out _));

        Assert.False(cache.HasPending);
        Assert.Equal(0, cache.Snapshot().PendingBytes);
    }

    [Fact]
    public void TryAddChunk_DimensionOrPartsMismatchDropsTheTransfer()
    {
        var cache = Create();

        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);
        Assert.Equal(ChunkResult.Buffered,
            cache.TryAddChunk("p_1", "nr1", Chunk(0, 2, width: 16), out _, out _, out _));
        Assert.Equal(ChunkResult.Failed,
            cache.TryAddChunk("p_1", "nr1", Chunk(0, 2, width: 32), out _, out _, out _));

        cache.AddPending("p_2", "nr2", "host-a", ConfigHashA);
        Assert.Equal(ChunkResult.Buffered,
            cache.TryAddChunk("p_2", "nr2", Chunk(0, 2, parts: 1), out _, out _, out _));
        Assert.Equal(ChunkResult.Failed,
            cache.TryAddChunk("p_2", "nr2", Chunk(0, 2, parts: 2), out _, out _, out _));
    }

    [Fact]
    public void TryAddChunk_ErrorDropsTheTransfer()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        Assert.Equal(ChunkResult.Buffered,
            cache.TryAddChunk("p_1", "nr1", Chunk(0, 2), out _, out _, out _));

        var result = cache.TryAddChunk(
            "p_1", "nr1", Chunk(0, 2, data: null, error: "boom"), out _, out _, out _);

        Assert.Equal(ChunkResult.Failed, result);
        Assert.False(cache.HasPending);
    }

    [Fact]
    public void TryAddChunk_ExceedingMaxTotalBytesDropsTheTransfer()
    {
        var cache = Create(maxBytes: 4);
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        var result = cache.TryAddChunk(
            "p_1", "nr1", Chunk(0, 1, data: "too-large"), out var completed, out _, out _);

        Assert.Equal(ChunkResult.Failed, result);
        Assert.Null(completed);
        Assert.False(cache.HasPending);
        Assert.Equal(0, cache.Snapshot().PendingBytes);
    }

    [Fact]
    public void DropPeer_RemovesOnlyThatPeersTransfers()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);
        cache.AddPending("p_2", "nr2", "host-a", ConfigHashA);
        cache.TryAddChunk("p_1", "nr1", Chunk(0, 2), out _, out _, out _);
        cache.TryAddChunk("p_2", "nr2", Chunk(0, 2), out _, out _, out _);

        cache.DropPeer("p_1");

        Assert.True(cache.HasPending);
        Assert.Equal(1, cache.Snapshot().Pending);
        Assert.Equal(ChunkResult.NotPending,
            cache.TryAddChunk("p_1", "nr1", Chunk(1, 2), out _, out _, out _));
        Assert.Equal(ChunkResult.Completed,
            cache.TryAddChunk("p_2", "nr2", Chunk(1, 2), out _, out _, out _));
    }

    [Fact]
    public void Unpin_ClearsThatHostsBufferedTransfers()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);
        cache.AddPending("p_2", "nr2", "host-b", ConfigHashA);
        cache.TryAddChunk("p_1", "nr1", Chunk(0, 2), out _, out _, out _);
        cache.TryAddChunk("p_2", "nr2", Chunk(0, 2), out _, out _, out _);

        cache.Unpin("host-a");

        Assert.Equal(ChunkResult.NotPending,
            cache.TryAddChunk("p_1", "nr1", Chunk(1, 2), out _, out _, out _));
        Assert.Equal(ChunkResult.Completed,
            cache.TryAddChunk("p_2", "nr2", Chunk(1, 2), out _, out _, out _));
    }

    [Fact]
    public void SweepPending_ReleasesBufferedChunks()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);
        cache.TryAddChunk("p_1", "nr1", Chunk(0, 2, data: "AAAA"), out _, out _, out _);

        Assert.Equal(4, cache.Snapshot().PendingBytes);

        cache.SweepPending(TimeSpan.Zero);

        Assert.False(cache.HasPending);
        Assert.Equal(0, cache.Snapshot().Pending);
        Assert.Equal(0, cache.Snapshot().PendingBytes);
    }

    [Fact]
    public void IsPending_SeesATransferUnderTheKeyOnly()
    {
        var cache = Create();
        cache.AddPending("p_1", "nr1", "host-a", ConfigHashA);

        Assert.True(cache.IsPending("p_1", "nr1"));
        Assert.False(cache.IsPending("p_1", "nr2"));
        Assert.False(cache.IsPending("p_2", "nr1"));
    }

    private static TerrainChunk Chunk(
        int index,
        int count,
        int part = 0,
        int parts = 1,
        string? data = "data",
        string? error = null,
        string name = "Layer 1",
        int width = 16,
        int height = 16) =>
        new(index, count, part, parts, width, height, name, data, error);

    private static TerrainCache Create(
        bool enabled = true,
        long maxBytes = DefaultMaxBytes,
        int pendingTimeoutSeconds = 60) =>
        new(
            new TacPhoneOptions
            {
                TerrainCache = new TerrainCacheOptions
                {
                    Enabled = enabled,
                    MaxTotalBytes = maxBytes,
                    PendingTimeoutSeconds = pendingTimeoutSeconds,
                },
            },
            NullLogger<TerrainCache>.Instance);
}
