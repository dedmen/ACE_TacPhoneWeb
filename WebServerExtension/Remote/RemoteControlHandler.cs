using System.Text.Json.Nodes;

namespace ArmaServerSide.Remote
{
    internal sealed partial class RemoteAccessService
    {
        void OnControl(JsonObject frame)
        {
            switch (frame.String("t"))
            {
                case "auth-ok":
                {
                    var hostId = frame.String("hostId");
                    var secret = frame["secret"]?.GetValue<string>();
                    var identityChanged = false;

                    lock (_gate)
                    {
                        _hostId = hostId;
                        if (!string.IsNullOrEmpty(secret))
                        {
                            _hostSecret = secret;
                            identityChanged = true;
                        }

                        _state = "online";
                        _error = "";
                    }

                    if (identityChanged)
                        NotifyIdentity();

                    var connection = CurrentConnection();
                    if (connection is not null)
                        _ = SendFileManifestAsync(connection);
                    break;
                }

                case "peer-joined":
                {
                    var peerId = frame.String("peerId");
                    if (peerId.Length == 0)
                        break;

                    _peers[peerId] = new PeerInfo(
                        peerId,
                        frame.String("label"),
                        frame.String("via"),
                        frame.String("connectedAt"),
                        frame.String("firstSeenAt"));

                    var connection = CurrentConnection();
                    if (connection is not null)
                        _ = _connections.AddConnectionAsync(peerId, new RelayPeerTransport(connection, peerId));

                    break;
                }

                case "peer-left":
                {
                    var peerId = frame.String("peerId");
                    if (peerId.Length == 0)
                        break;

                    _peers.TryRemove(peerId, out _);
                    _ = _connections.RemoveConnectionAsync(peerId, notifyGame: true, closeTransport: false);
                    break;
                }

                case "code":
                {
                    var expiresIn = Math.Max(0, frame.Int("expiresIn"));
                    lock (_gate)
                    {
                        _code = frame.String("code");
                        _codeTtlSeconds = expiresIn;
                        _codeExpiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresIn);
                    }

                    break;
                }

                case "code-used":
                    // The server consumed the one-time code for a successful attach.
                    lock (_gate)
                    {
                        _code = "";
                        _codeExpiresAt = default;
                        _codeTtlSeconds = 0;
                    }

                    break;

                case "share":
                {
                    var key = frame.String("key");
                    var expiresIn = Math.Max(0, frame.Int("expiresIn"));
                    lock (_gate)
                    {
                        _shareKey = key;
                        _shareExpiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresIn);
                    }

                    break;
                }

                case "share-revoked":
                    lock (_gate)
                    {
                        _shareKey = "";
                        _shareExpiresAt = default;
                    }

                    break;

                case "error":
                    ExtensionLog.Error($"Relay error {frame.String("code")}: {frame.String("message")}");
                    SetError(frame.String("message"));
                    break;

                case "pong":
                    break;

                case "ping":
                {
                    // The relay drops peers that do not answer its keepalive.
                    var connection = CurrentConnection();
                    if (connection is not null)
                        _ = connection.SendControlAsync(new JsonObject { ["t"] = "pong" });
                    break;
                }
            }
        }
    }
}
