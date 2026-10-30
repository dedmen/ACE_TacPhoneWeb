using System.Net.WebSockets;
using System.Text;

namespace ArmaServerSide.Transports
{
    /// <summary>Adapts a Kestrel/LAN <see cref="WebSocket"/> to <see cref="IClientTransport"/>.</summary>
    internal sealed class WebSocketTransport : IClientTransport
    {
        readonly WebSocket _socket;
        // WebSocket only allows one send at a time, so serialize per connection.
        readonly SemaphoreSlim _sendLock = new(1, 1);

        public WebSocketTransport(WebSocket socket)
        {
            _socket = socket;
        }

        public bool IsOpen => _socket.State == WebSocketState.Open;

        public async Task SendTextAsync(string message)
        {
            await _sendLock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (_socket.State != WebSocketState.Open) return;

                var bytes = Encoding.UTF8.GetBytes(message);
                await _socket.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    true,
                    CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                ExtensionLog.Error("Error sending message", ex);
            }
            finally
            {
                _sendLock.Release();
            }
        }

        public async Task CloseAsync()
        {
            try
            {
                // A peer that stopped responding cannot complete the close handshake.
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Connection closed", cts.Token)
                    .ConfigureAwait(false);
            }
            catch (Exception)
            {
                _socket.Abort();
            }
        }

        public void Abort()
        {
            try { _socket.Abort(); } catch (Exception) { /* already gone */ }
        }
    }
}
