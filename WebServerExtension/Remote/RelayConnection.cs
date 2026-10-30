using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace ArmaServerSide.Remote
{
    /// <summary>
    /// The single outbound WebSocket to the public relay. Owns framing, send
    /// serialization, the receive loop and a bounded close. Reconnection is
    /// driven by <see cref="RemoteAccessService"/>.
    /// </summary>
    internal sealed class RelayConnection : IDisposable
    {
        const int ReceiveBufferSize = 64 * 1024;
        const int MaxMessageBytes = 32 * 1024 * 1024;

        readonly ClientWebSocket _socket = new();
        readonly SemaphoreSlim _sendLock = new(1, 1);
        readonly Action<JsonObject> _onControl;
        readonly Action<string, string> _onData;
        readonly Action<string> _onClosed;

        int _closedNotified;

        public RelayConnection(
            Action<JsonObject> onControl,
            Action<string, string> onData,
            Action<string> onClosed)
        {
            _onControl = onControl;
            _onData = onData;
            _onClosed = onClosed;
        }

        public bool IsOpen => _socket.State == WebSocketState.Open;

        public async Task ConnectAsync(Uri uri, CancellationToken cancellationToken)
        {
            _socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
            _socket.Options.KeepAliveTimeout = TimeSpan.FromSeconds(10);
            await _socket.ConnectAsync(uri, cancellationToken).ConfigureAwait(false);
        }

        public Task SendControlAsync(JsonObject frame)
            => SendTextAsync(frame.ToJsonString());

        public Task SendApplicationAsync(string peerId, string payload)
            => SendBinaryAsync(RelayProtocol.EncodeDataFrame(peerId, payload));

        async Task SendTextAsync(string text)
            => await SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text).ConfigureAwait(false);

        async Task SendBinaryAsync(byte[] bytes)
            => await SendAsync(bytes, WebSocketMessageType.Binary).ConfigureAwait(false);

        async Task SendAsync(byte[] bytes, WebSocketMessageType type)
        {
            await _sendLock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (_socket.State != WebSocketState.Open)
                    return;

                await _socket.SendAsync(
                    new ArraySegment<byte>(bytes),
                    type,
                    true,
                    CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                ExtensionLog.Error("Relay send failed", ex);
            }
            finally
            {
                _sendLock.Release();
            }
        }

        /// <summary>Receives until the socket closes or <paramref name="cancellationToken"/> fires.</summary>
        public async Task RunReceiveLoopAsync(CancellationToken cancellationToken)
        {
            var buffer = new byte[ReceiveBufferSize];
            var message = new MemoryStream();

            try
            {
                while (!cancellationToken.IsCancellationRequested && _socket.State == WebSocketState.Open)
                {
                    message.SetLength(0);
                    WebSocketReceiveResult result;

                    do
                    {
                        result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken)
                            .ConfigureAwait(false);

                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            await CloseAsync().ConfigureAwait(false);
                            return;
                        }

                        if (message.Length + result.Count > MaxMessageBytes)
                            throw new InvalidOperationException("Relay message exceeded the 32 MiB limit.");

                        message.Write(buffer, 0, result.Count);
                    }
                    while (!result.EndOfMessage);

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var text = Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
                        var parsed = RelayProtocol.ParseObject(text);

                        if (parsed is not null && parsed.ContainsKey("t"))
                            SafeInvoke(() => _onControl(parsed));
                        else if (RelayProtocol.TryDecodeTextDataFrame(text, out var textPeerId, out var textPayload))
                            SafeInvoke(() => _onData(textPeerId, textPayload));
                        else
                            ExtensionLog.Warn("Relay sent an unrecognised text frame.");
                    }
                    else
                    {
                        var span = new ReadOnlySpan<byte>(message.GetBuffer(), 0, (int)message.Length);
                        if (RelayProtocol.TryDecodeDataFrame(span, out var peerId, out var payload))
                            SafeInvoke(() => _onData(peerId, payload));
                        else
                            ExtensionLog.Warn("Relay sent a malformed data frame.");
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Expected on Stop()/mission restart.
            }
            catch (Exception ex)
            {
                ExtensionLog.Warn("Relay receive loop ended", ex);
            }
            finally
            {
                NotifyClosed("closed");
            }
        }

        public async Task CloseAsync()
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                if (_socket.State == WebSocketState.Open || _socket.State == WebSocketState.CloseReceived)
                    await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "closing", cts.Token)
                        .ConfigureAwait(false);
            }
            catch (Exception)
            {
                Abort();
            }
        }

        public void Abort()
        {
            try { _socket.Abort(); } catch (Exception) { /* already gone */ }
        }

        void NotifyClosed(string reason)
        {
            if (Interlocked.Exchange(ref _closedNotified, 1) != 0)
                return;

            SafeInvoke(() => _onClosed(reason));
        }

        static void SafeInvoke(Action action)
        {
            try { action(); }
            catch (Exception ex) { ExtensionLog.Error("Relay callback failed", ex); }
        }

        public void Dispose()
        {
            Abort();
            _socket.Dispose();
            _sendLock.Dispose();
        }
    }
}
