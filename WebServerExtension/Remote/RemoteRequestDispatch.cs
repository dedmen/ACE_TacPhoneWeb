using System.Text.Json.Nodes;

namespace ArmaServerSide.Remote
{
    internal sealed partial class RemoteAccessService
    {
        string Start(string host, string identityJson, string manifestJson)
        {
            var manifest = ParseFileManifest(manifestJson);

            // Never send while holding _gate: the send is async and may await.
            RelayConnection? manifestTarget = null;
            string status;

            lock (_gate)
            {
                _fileManifest = manifest;

                if (_armed)
                {
                    // Already armed: keep the new manifest and push it if online.
                    if (_state == "online")
                        manifestTarget = _connection;

                    status = BuildStatusJsonLocked();
                }
                else
                {
                    var uri = BuildRelayUri(host, out var publicBase);
                    if (uri is null)
                        return Error("invalid relay host");

                    var identity = RelayProtocol.ParseObject(identityJson);
                    _host = host.Trim();
                    _publicBase = publicBase;

                    // The RemoteIdentity callback (and the SQF profileNamespace value)
                    // uses "hostId". Accept "id" as a fallback for older stored values.
                    _hostId = identity.String("hostId");
                    if (_hostId.Length == 0)
                        _hostId = identity.String("id");
                    _hostSecret = identity.String("secret");
                    _armed = true;
                    _state = "connecting";
                    _error = "";
                    _code = "";
                    _codeExpiresAt = default;
                    _codeTtlSeconds = 0;
                    _shareKey = "";
                    _shareExpiresAt = default;

                    _cts = new CancellationTokenSource();
                    var token = _cts.Token;
                    _supervisor = Task.Run(() => SuperviseAsync(uri, token));

                    status = BuildStatusJsonLocked();
                }
            }

            if (manifestTarget is not null)
                _ = SendFileManifestAsync(manifestTarget);

            return status;
        }

        string StatusJson()
        {
            lock (_gate)
                return BuildStatusJsonLocked();
        }

        string BuildStatusJsonLocked()
        {
            var now = DateTimeOffset.UtcNow;

            var result = new JsonObject
            {
                ["ok"] = true,
                ["proto"] = RelayProtocol.Proto,
                ["state"] = _state,
                ["hostId"] = _hostId,
                ["webBase"] = _publicBase,
                ["error"] = _error,
                ["code"] = now < _codeExpiresAt ? _code : "",
                ["codeExpiresIn"] = now < _codeExpiresAt
                    ? (int)Math.Max(0, (_codeExpiresAt - now).TotalSeconds)
                    : 0,
                ["codeTtl"] = _codeTtlSeconds,
            };

            if (_shareKey.Length > 0 && now < _shareExpiresAt)
            {
                result["share"] = new JsonObject
                {
                    ["url"] = $"{_publicBase}/#s={_shareKey}",
                    ["key"] = _shareKey,
                    ["expiresIn"] = (int)Math.Max(0, (_shareExpiresAt - now).TotalSeconds),
                };
            }
            else
            {
                result["share"] = null;
            }

            var peers = new JsonArray();
            var allPeers = _peers.Values.OrderBy(p => p.ConnectedAt, StringComparer.Ordinal).ToList();
            result["peerCount"] = allPeers.Count;

            // Keep the status below Arma's callExtension output buffer even with many devices.
            foreach (var peer in allPeers.Take(20))
            {
                peers.Add((JsonNode)new JsonObject
                {
                    ["id"] = peer.PeerId,
                    ["label"] = peer.Label,
                    ["via"] = peer.Via,
                    ["connectedAt"] = peer.ConnectedAt,
                    ["firstSeenAt"] = peer.FirstSeenAt,
                });
            }

            result["peers"] = peers;
            return result.ToJsonString();
        }

        string SendControl(JsonObject frame)
        {
            RelayConnection? connection;
            lock (_gate)
            {
                if (!_armed || _state != "online" || _connection is null)
                    return Error("relay not connected");

                connection = _connection;
            }

            _ = connection.SendControlAsync(frame);
            return Ok();
        }

        string Kick(string peerId)
        {
            RelayConnection? connection;
            lock (_gate)
            {
                if (!_armed || _connection is null)
                    return Error("relay not connected");

                connection = _connection;
            }

            _ = connection.SendControlAsync(new JsonObject { ["t"] = "kick", ["peerId"] = peerId });
            _peers.TryRemove(peerId, out _);
            _ = _connections.RemoveConnectionAsync(peerId, notifyGame: true, closeTransport: false);
            return Ok();
        }
    }
}
