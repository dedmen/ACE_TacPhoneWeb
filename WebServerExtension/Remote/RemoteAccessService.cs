using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using ArmaServerSide.Transports;

namespace ArmaServerSide.Remote
{
    /// <summary>
    /// Arms the outbound relay connection on demand and owns everything that must
    /// not live in SQF: identity, one-time codes, share links, peer bookkeeping and
    /// target routing.
    ///
    /// Every entry point is called from the Arma thread through `callExtension`,
    /// so it only touches in-memory state and never awaits network I/O.
    /// </summary>
    internal sealed class RemoteAccessService
    {
        sealed record PeerInfo(string PeerId, string Label, string Via, string ConnectedAt, string FirstSeenAt);

        readonly WebSocketConnectionManager _connections;
        readonly object _gate = new();
        readonly ConcurrentDictionary<string, PeerInfo> _peers = new(StringComparer.Ordinal);

        bool _armed;
        CancellationTokenSource? _cts;
        Task? _supervisor;
        RelayConnection? _connection;

        string _state = "idle"; // idle | connecting | online | error
        string _error = "";
        string _host = "";
        string _publicBase = "";
        string _hostId = "";
        string _hostSecret = "";
        string _code = "";
        DateTimeOffset _codeExpiresAt;
        int _codeTtlSeconds;
        string _shareKey = "";
        DateTimeOffset _shareExpiresAt;

        public RemoteAccessService(WebSocketConnectionManager connections)
        {
            _connections = connections;
        }

        public string Handle(string subcommand, IReadOnlyList<string> args)
        {
            try
            {
                switch (subcommand)
                {
                    case "Start":
                        return args.Count >= 2
                            ? Start(args[0], args[1])
                            : Error("missing host or identity");

                    case "Stop":
                        Stop();
                        return Ok();

                    case "Status":
                        return StatusJson();

                    case "NewCode":
                        return SendControl(new JsonObject { ["t"] = "code-new" });

                    case "ShareCreate":
                    {
                        var ttl = args.Count >= 1 && int.TryParse(args[0], out var parsed) ? parsed : 3600;
                        ttl = Math.Clamp(ttl, 60, 86400);
                        return SendControl(new JsonObject { ["t"] = "share-create", ["ttlSeconds"] = ttl });
                    }

                    case "ShareRevoke":
                        return SendControl(new JsonObject { ["t"] = "share-revoke" });

                    case "Kick":
                        return args.Count >= 1 ? Kick(args[0]) : Error("missing peer id");

                    default:
                        return Error($"unknown subcommand '{subcommand}'");
                }
            }
            catch (Exception ex)
            {
                return Error($"{ex.GetType().Name}: {ex.Message}");
            }
        }

        string Start(string host, string identityJson)
        {
            lock (_gate)
            {
                if (_armed)
                    return BuildStatusJsonLocked();

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

                return BuildStatusJsonLocked();
            }
        }

        internal void Stop()
        {
            RelayConnection? connection;
            CancellationTokenSource? cts;
            Task? supervisor;

            lock (_gate)
            {
                _armed = false;
                _state = "idle";
                _error = "";
                _code = "";
                _codeTtlSeconds = 0;
                _shareKey = "";
                connection = _connection;
                _connection = null;
                cts = _cts;
                _cts = null;
                supervisor = _supervisor;
                _supervisor = null;
            }

            try { cts?.Cancel(); } catch (Exception) { /* already gone */ }
            if (connection is not null)
                _ = connection.CloseAsync();

            DropAllPeers();

            if (supervisor is not null)
                _ = AwaitAndDisposeAsync(supervisor, cts);
            else
                cts?.Dispose();
        }

        static async Task AwaitAndDisposeAsync(Task supervisor, CancellationTokenSource? cts)
        {
            try { await supervisor.ConfigureAwait(false); }
            catch (Exception) { /* supervisor already logs */ }
            finally { cts?.Dispose(); }
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

        async Task SuperviseAsync(Uri uri, CancellationToken cancellationToken)
        {
            var attempt = 0;

            while (!cancellationToken.IsCancellationRequested && IsArmed)
            {
                RelayConnection? connection = null;

                try
                {
                    connection = new RelayConnection(OnControl, OnData, _ => OnConnectionClosed());

                    lock (_gate)
                    {
                        if (!_armed)
                        {
                            connection.Dispose();
                            return;
                        }

                        _connection = connection;
                    }

                    await connection.ConnectAsync(uri, cancellationToken).ConfigureAwait(false);
                    await connection.SendControlAsync(BuildAuthFrame()).ConfigureAwait(false);
                    await connection.RunReceiveLoopAsync(cancellationToken).ConfigureAwait(false);

                    attempt = 0;
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    SetError(ex.Message);
                }
                finally
                {
                    lock (_gate)
                    {
                        if (ReferenceEquals(_connection, connection))
                            _connection = null;
                    }

                    connection?.Dispose();
                    DropAllPeers();
                }

                if (cancellationToken.IsCancellationRequested || !IsArmed)
                    break;

                attempt++;
                var seconds = Math.Min(30, 1 << Math.Min(attempt, 5));

                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(seconds), cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }

            lock (_gate)
            {
                if (!_armed)
                    _state = "idle";
            }
        }

        JsonObject BuildAuthFrame()
        {
            lock (_gate)
            {
                var frame = new JsonObject
                {
                    ["t"] = "auth",
                    ["proto"] = RelayProtocol.Proto,
                    ["role"] = "game",
                    ["label"] = "TacPhone",
                };

                if (_hostId.Length > 0) frame["hostId"] = _hostId;
                if (_hostSecret.Length > 0) frame["secret"] = _hostSecret;

                return frame;
            }
        }

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

        void OnData(string peerId, string payload)
        {
            _connections.DispatchToGame(peerId, payload);
        }

        void OnConnectionClosed()
        {
            lock (_gate)
            {
                if (!_armed)
                    return;

                _state = "connecting";
                _code = "";
                _codeExpiresAt = default;
                _codeTtlSeconds = 0;

                // Keep the share key: it is still valid server-side, and only its
                // hash is stored there, so a reconnect cannot recover it.
            }
        }

        RelayConnection? CurrentConnection()
        {
            lock (_gate)
                return _connection;
        }

        bool IsArmed
        {
            get
            {
                lock (_gate)
                    return _armed;
            }
        }

        void SetError(string message)
        {
            lock (_gate)
                _error = message;
        }

        void NotifyIdentity()
        {
            var json = new JsonObject
            {
                ["hostId"] = _hostId,
                ["secret"] = _hostSecret,
            }.ToJsonString();

            try
            {
                DllEntry.callback("ArmaWebHost", "RemoteIdentity", Encoding.UTF8.GetBytes(json));
            }
            catch (Exception ex)
            {
                ExtensionLog.Error("RemoteIdentity callback failed", ex);
            }
        }

        void DropAllPeers()
        {
            foreach (var peerId in _peers.Keys)
            {
                if (!_peers.TryRemove(peerId, out _))
                    continue;

                _ = _connections.RemoveConnectionAsync(peerId, notifyGame: true, closeTransport: false);
            }
        }

        static string Ok() => new JsonObject { ["ok"] = true }.ToJsonString();

        static string Error(string message)
            => new JsonObject { ["ok"] = false, ["error"] = message }.ToJsonString();

        /// <summary>
        /// Accepts `tacphone.arma3.io`, `https://host`, `wss://host/ws`, ... and
        /// returns the relay WebSocket URI plus the public browser base URL.
        /// </summary>
        static Uri? BuildRelayUri(string host, out string publicBase)
        {
            publicBase = "";

            if (string.IsNullOrWhiteSpace(host))
                return null;

            var text = host.Trim();
            if (!text.Contains("://", StringComparison.Ordinal))
                text = "wss://" + text;

            if (!Uri.TryCreate(text, UriKind.Absolute, out var parsed))
                return null;

            var secure = parsed.Scheme is "wss" or "https";
            if (!secure && parsed.Scheme is not ("ws" or "http"))
                return null;

            var path = parsed.AbsolutePath.TrimEnd('/');
            if (path.Length == 0)
                path = "/ws";

            var builder = new UriBuilder(parsed)
            {
                Scheme = secure ? "wss" : "ws",
                Path = path,
                Query = string.Empty,
                Fragment = string.Empty,
            };

            publicBase = $"{(secure ? "https" : "http")}://{parsed.Authority}";
            return builder.Uri;
        }
    }
}
