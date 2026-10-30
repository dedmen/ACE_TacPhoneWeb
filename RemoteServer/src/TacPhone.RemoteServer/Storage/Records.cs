namespace TacPhone.RemoteServer.Storage;

/// <summary>A registered game host. Only the SHA-256 hash of its secret is stored.</summary>
public sealed record HostRecord(
    string HostId,
    byte[] SecretHash,
    string? Label,
    long CreatedUtc,
    long? LastSeenUtc);

/// <summary>
/// An authenticated browser client. Owner devices have no <see cref="ShareId"/>
/// and no <see cref="ExpiresUtc"/>; share-scoped devices have both.
/// </summary>
public sealed record DeviceRecord(
    byte[] TokenHash,
    string HostId,
    string? ShareId,
    string? Label,
    long? ExpiresUtc,
    long CreatedUtc,
    long? LastSeenUtc);

/// <summary>A share link issued by a host. Only the key hash is stored.</summary>
public sealed record ShareRecord(
    string ShareId,
    byte[] KeyHash,
    string HostId,
    long CreatedUtc,
    long ExpiresUtc,
    long? RevokedUtc);

/// <summary>
/// Result of a host authentication. <see cref="IssuedSecret"/> is only set when a
/// brand new identity had to be created.
/// </summary>
public sealed record HostAuthResult(string HostId, string? IssuedSecret);

/// <summary>A freshly issued device token together with its stored record.</summary>
public sealed record IssuedDevice(string Token, DeviceRecord Record);

/// <summary>
/// A new share key (shown once) and the ids of the shares it replaced, so the
/// caller can close their sockets.
/// </summary>
public sealed record ShareCreation(
    string ShareId,
    string Key,
    long ExpiresUtc,
    IReadOnlyList<string> ReplacedShareIds);

/// <summary>The ids of the shares that were revoked.</summary>
public sealed record ShareRevocation(IReadOnlyList<string> RevokedShareIds);
