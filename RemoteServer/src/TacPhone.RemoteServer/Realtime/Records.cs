using TacPhone.RemoteServer.Storage;

namespace TacPhone.RemoteServer.Realtime;

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

/// <summary>A point-in-time view of the texture cache.</summary>
public readonly record struct TextureCacheStats(
    int Entries,
    long Bytes,
    long Hits,
    long Misses,
    long Evictions,
    int Pending);

/// <summary>A point-in-time view of the file cache.</summary>
public readonly record struct FileCacheStats(
    int Entries,
    long Bytes,
    long Hits,
    long Misses,
    long Evictions,
    int Pending,
    int Pinned,
    int Sticky,
    int Expected);

/// <summary>The kind of first control frame a new socket presents.</summary>
internal enum AttachStatus
{
    Attached,
    Rejected,
    HostOffline,
}

/// <summary>The first control frame of a relay socket (auth or attach).</summary>
internal sealed record FirstFrame(
    string Type,
    int? Proto,
    string? Role,
    string? HostId,
    string? Secret,
    string? DeviceToken,
    string? Code,
    string? Share,
    string? Label);

/// <summary>
/// Result of resolving a browser attach: which host it belongs to, the device it
/// bound to, a freshly issued token (code or share attach) and how it arrived.
/// </summary>
internal sealed record AttachResult(
    AttachStatus Status,
    HostSession? Host = null,
    DeviceRecord? Device = null,
    string? NewToken = null,
    string Via = "owner",
    string? Reason = null)
{
    public static AttachResult Attached(HostSession host, DeviceRecord device, string? newToken, string via) =>
        new(AttachStatus.Attached, host, device, newToken, via);

    public static AttachResult Rejected(string reason) =>
        new(AttachStatus.Rejected, Reason: reason);

    public static AttachResult HostOffline() => new(AttachStatus.HostOffline);
}
