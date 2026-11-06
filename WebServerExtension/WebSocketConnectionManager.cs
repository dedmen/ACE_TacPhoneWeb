using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using ArmaServerSide.Transports;

namespace ArmaServerSide
{

    // Connection Manager Class
    public class WebSocketConnectionManager
    {
        internal readonly ConcurrentDictionary<string, Connection> _connections = new();

        internal sealed class Connection
        {
            public IClientTransport Transport { get; }

            public Connection(IClientTransport transport)
            {
                Transport = transport;
            }
        }

        internal Task AddConnectionAsync(string connectionId, IClientTransport transport)
        {
            _connections[connectionId] = new Connection(transport);
            ExtensionLog.Info($"Connection added: {connectionId}. Total connections: {_connections.Count}");
            return Task.CompletedTask;
        }

        public Task AddConnectionAsync(string connectionId, WebSocket webSocket)
            => AddConnectionAsync(connectionId, new WebSocketTransport(webSocket));

        /// <summary>
        /// Removes a client. <paramref name="notifyGame"/> fires the Disconnect
        /// callback so the game drops that client's interests.
        /// </summary>
        public async Task RemoveConnectionAsync(string connectionId, bool notifyGame = true, bool closeTransport = true)
        {
            if (!_connections.TryRemove(connectionId, out var connection))
                return;

            if (notifyGame)
            {
                try
                {
                    DllEntry.callback("ArmaWebHost", "Disconnect", Encoding.UTF8.GetBytes(connectionId));
                }
                catch (Exception ex)
                {
                    ExtensionLog.Error("Disconnect callback failed", ex);
                }
            }

            if (closeTransport)
            {
                try
                {
                    await connection.Transport.CloseAsync().ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    ExtensionLog.Warn("Close failed", ex);
                }
            }

            ExtensionLog.Info($"Connection removed: {connectionId}. Total connections: {_connections.Count}");
        }

        /// <summary>
        /// Adds the sender id to a client request and hands it to the game.
        /// Used by the relay data path (kept for the unused Remote/ code).
        /// </summary>
        internal void DispatchToGame(string connectionId, string messageJson)
            => DispatchWebhostRequest(connectionId, messageJson, framed => framed);

        /// <summary>
        /// Adds the sender id to a LAN client request and hands it to the game as
        /// <c>WEBHOST:</c> + base64(UTF8(framed JSON)). The base64 keeps the
        /// payload safe to embed in an SQF <c>ExecJS</c> string; SQF forwards it
        /// unchanged.
        /// </summary>
        internal void DispatchWebhostRequest(string connectionId, string messageJson)
            => DispatchWebhostRequest(
                connectionId,
                messageJson,
                framed => WebServer.WebhostTransportPrefix + Convert.ToBase64String(Encoding.UTF8.GetBytes(framed)));

        /// <summary>
        /// Shared core of the request dispatchers: adds the sender id and hands the
        /// (optionally re-encoded) payload to the game through the Request callback.
        /// </summary>
        private static void DispatchWebhostRequest(string connectionId, string messageJson, Func<string, string> encode)
        {
            var framed = RequestFraming.InjectSender(messageJson, connectionId);
            if (framed is null)
            {
                ExtensionLog.Warn($"Dropping malformed client frame from {connectionId}.");
                return;
            }

            try
            {
                DllEntry.callback("ArmaWebHost", "Request", Encoding.UTF8.GetBytes(encode(framed)));
            }
            catch (Exception ex)
            {
                ExtensionLog.Error("Request callback failed", ex);
            }
        }

        /// <summary>
        /// Closes a socket without ever hanging: a peer that stopped responding
        /// cannot complete the close handshake, so abort after 2 s.
        /// </summary>
        internal static async Task CloseSafelyAsync(WebSocket socket, WebSocketCloseStatus status, string? description)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await socket.CloseAsync(status, description ?? string.Empty, cts.Token);
            }
            catch (Exception)
            {
                socket.Abort();
            }
        }

        public async Task BroadcastAsync(string message, string? excludeConnectionId = null)
        {
            var tasks = new List<Task>();

            foreach (var connection in _connections)
            {
                if (connection.Key != excludeConnectionId && connection.Value.Transport.IsOpen)
                {
                    tasks.Add(connection.Value.Transport.SendTextAsync(message));
                }
            }

            await Task.WhenAll(tasks);
        }

        /// <summary>
        /// Returns the number of connections that are currently open.
        /// </summary>
        public int CountOpenConnections()
        {
            int count = 0;
            foreach (var connection in _connections)
            {
                if (connection.Value.Transport.IsOpen)
                {
                    count++;
                }
            }
            return count;
        }

        public async Task SendMessageToConnectionAsync(string connectionId, string message)
        {
            if (_connections.TryGetValue(connectionId, out var connection))
            {
                await connection.Transport.SendTextAsync(message).ConfigureAwait(false);
            }
        }
    }

}
