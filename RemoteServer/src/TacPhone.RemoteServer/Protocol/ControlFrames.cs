namespace TacPhone.RemoteServer.Protocol;

/// <summary>Protocol version spoken by the game client and the browser UI.</summary>
public static class ProtocolConstants
{
    public const int Version = 1;
}

/// <summary>Control frame <c>t</c> values.</summary>
public static class ControlTypes
{
    // game -> server
    public const string Auth = "auth";
    public const string CodeNew = "code-new";
    public const string ShareCreate = "share-create";
    public const string ShareRevoke = "share-revoke";
    public const string Kick = "kick";
    public const string Ping = "ping";

    // browser -> server
    public const string Attach = "attach";

    // server -> game
    public const string AuthOk = "auth-ok";
    public const string PeerJoined = "peer-joined";
    public const string PeerLeft = "peer-left";
    public const string Code = "code";
    public const string CodeUsed = "code-used";
    public const string Share = "share";
    public const string ShareRevoked = "share-revoked";
    public const string Error = "error";

    // server -> browser
    public const string AttachOk = "attach-ok";
    public const string HostOffline = "host-offline";
    public const string Rejected = "rejected";
    public const string PeerKicked = "peer-kicked";

    // both directions
    public const string Pong = "pong";
}

/// <summary>Error codes carried by <c>{"t":"error"}</c>.</summary>
public static class ErrorCodes
{
    /// <summary>
    /// Reserved: a wrong host secret never produces an error, the server issues a
    /// new identity instead. Kept so the vocabulary matches the plan.
    /// </summary>
    public const string BadSecret = "bad-secret";

    public const string BadFrame = "bad-frame";
    public const string Proto = "proto";
    public const string RateLimit = "rate-limit";
    public const string TooLarge = "too-large";
    public const string MaxHosts = "max-hosts";
    public const string UnknownPeer = "unknown-peer";
    public const string Internal = "internal";
}

/// <summary>Rejection reasons carried by <c>{"t":"rejected"}</c>, peer-left and peer-kicked.</summary>
public static class RejectionReasons
{
    public const string BadCode = "bad-code";
    public const string BadShare = "bad-share";
    public const string BadToken = "bad-token";
    public const string Expired = "expired";
    public const string Revoked = "revoked";
    public const string Proto = "proto";
    public const string RateLimit = "rate-limit";
    public const string HostFull = "host-full";
    public const string Closed = "closed";
    public const string Kicked = "kicked";
    public const string Timeout = "timeout";
    public const string HostStop = "host-stop";
    public const string Superseded = "superseded";
}
