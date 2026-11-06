using System.Collections.Concurrent;
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
    internal sealed partial class RemoteAccessService
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
        JsonArray _fileManifest = new();

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
                            ? Start(args[0], args[1], args.Count >= 3 ? args[2] : "[]")
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
                _fileManifest = new();
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
    }
}
