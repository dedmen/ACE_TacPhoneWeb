namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// One attached browser. A socket maps 1:1 to a peer; the peer id is generated
/// by the server and never by the game or the browser.
/// </summary>
public sealed class ClientSession
{
    public ClientSession(
        string peerId,
        RelaySocket socket,
        string via,
        string? shareId,
        byte[]? deviceTokenHash,
        string? label,
        DateTimeOffset connectedAt,
        DateTimeOffset firstSeenAt)
    {
        ArgumentException.ThrowIfNullOrEmpty(peerId);
        ArgumentNullException.ThrowIfNull(socket);
        ArgumentException.ThrowIfNullOrEmpty(via);

        PeerId = peerId;
        Socket = socket;
        Via = via;
        ShareId = shareId;
        DeviceTokenHash = deviceTokenHash;
        Label = label;
        ConnectedAt = connectedAt;
        FirstSeenAt = firstSeenAt;
    }

    public string PeerId { get; }

    public RelaySocket Socket { get; }

    /// <summary><c>owner</c> for a paired owner device, <c>share</c> for a share link.</summary>
    public string Via { get; }

    /// <summary>Share id for share-scoped devices, otherwise <c>null</c>.</summary>
    public string? ShareId { get; }

    /// <summary>SHA-256 of the device token, so the row can be touched without keeping the token.</summary>
    public byte[]? DeviceTokenHash { get; }

    public string? Label { get; }

    public DateTimeOffset ConnectedAt { get; }

    /// <summary>First-ever connection of this device, from <c>devices.created_utc</c>.</summary>
    public DateTimeOffset FirstSeenAt { get; }

    public bool IsShareDevice => !string.IsNullOrEmpty(ShareId);
}
