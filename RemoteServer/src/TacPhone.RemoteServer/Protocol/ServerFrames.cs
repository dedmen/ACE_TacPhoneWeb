using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TacPhone.RemoteServer.Protocol;

/// <summary>
/// Builders for every control frame the server sends. All of them are small,
/// explicit JSON objects so the wire shape cannot drift from the plan.
/// </summary>
public static class ServerFrames
{
    private static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string Pong() => Build(ControlTypes.Pong);

    public static string Ping() => Build(ControlTypes.Ping);

    public static string AuthOk(string hostId, string? issuedSecret) =>
        Build(ControlTypes.AuthOk, ("proto", ProtocolConstants.Version), ("hostId", hostId), ("secret", issuedSecret));

    public static string PeerJoined(string peerId, string? label, string via, DateTimeOffset connectedAt, DateTimeOffset firstSeenAt) =>
        Build(
            ControlTypes.PeerJoined,
            ("peerId", peerId),
            ("label", label),
            ("via", via),
            ("connectedAt", Iso(connectedAt)),
            ("firstSeenAt", Iso(firstSeenAt)));

    public static string PeerLeft(string peerId, string reason) =>
        Build(ControlTypes.PeerLeft, ("peerId", peerId), ("reason", reason));

    public static string Code(string code, int expiresInSeconds) =>
        Build(ControlTypes.Code, ("code", code), ("expiresIn", expiresInSeconds));

    public static string Share(string key, string? url, int expiresInSeconds) =>
        Build(ControlTypes.Share, ("key", key), ("url", url), ("expiresIn", expiresInSeconds));

    public static string ShareRevoked() => Build(ControlTypes.ShareRevoked);

    public static string Error(string code, string message) =>
        Build(ControlTypes.Error, ("code", code), ("message", message));

    public static string AttachOk(string hostId, string peerId, string? deviceToken) =>
        Build(ControlTypes.AttachOk, ("hostId", hostId), ("peerId", peerId), ("deviceToken", deviceToken));

    public static string HostOffline() => Build(ControlTypes.HostOffline);

    public static string Rejected(string reason) => Build(ControlTypes.Rejected, ("reason", reason));

    public static string PeerKicked(string reason) => Build(ControlTypes.PeerKicked, ("reason", reason));

    /// <summary>ISO 8601 UTC with second precision, e.g. <c>2026-10-30T14:02:11Z</c>.</summary>
    public static string Iso(DateTimeOffset value) =>
        value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    private static string Build(string type, params (string Name, object? Value)[] fields)
    {
        // A dictionary keeps insertion order, so "t" always serializes first.
        var values = new Dictionary<string, object?>(fields.Length + 1, StringComparer.Ordinal)
        {
            ["t"] = type,
        };

        foreach (var (name, value) in fields)
        {
            if (value is not null)
            {
                values[name] = value;
            }
        }

        return JsonSerializer.Serialize(values, Options);
    }
}
