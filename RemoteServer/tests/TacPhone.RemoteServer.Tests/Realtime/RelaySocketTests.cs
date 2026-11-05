using System.Net.WebSockets;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using TacPhone.RemoteServer.Realtime;

namespace TacPhone.RemoteServer.Tests.Realtime;

public sealed class RelaySocketTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    [Fact]
    public void EncodeGameText_PrefixesBase64OfUtf8()
    {
        var encoded = RelaySocket.EncodeGameText("{\"t\":\"pong\"}");

        Assert.StartsWith("RELAY:", encoded);

        var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(encoded["RELAY:".Length..]));
        Assert.Equal("{\"t\":\"pong\"}", decoded);
    }

    [Fact]
    public void EncodeGameText_RoundTripsNonAscii()
    {
        const string payload = "peer\n{\"label\":\"héllo 🙂\"}";
        var encoded = RelaySocket.EncodeGameText(payload);

        var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(encoded["RELAY:".Length..]));
        Assert.Equal(payload, decoded);
    }

    [Fact]
    public async Task GameTextFraming_PrefixesAndEncodesEveryTextFrame()
    {
        var webSocket = new CapturingWebSocket();
        var socket = new RelaySocket(webSocket, null, TimeProvider.System, NullLogger.Instance);
        socket.UseGameTextFraming();
        socket.Start();

        Assert.True(socket.TryEnqueueText("p_abc\n{\"a\":1}"));

        var (type, payload) = await webSocket.Sent.Task.WaitAsync(Timeout);
        Assert.Equal(WebSocketMessageType.Text, type);

        var text = Encoding.UTF8.GetString(payload);
        Assert.StartsWith("RELAY:", text);

        var inner = Encoding.UTF8.GetString(Convert.FromBase64String(text["RELAY:".Length..]));
        Assert.Equal("p_abc\n{\"a\":1}", inner);
    }

    [Fact]
    public async Task BrowserTextFraming_StaysRaw()
    {
        var webSocket = new CapturingWebSocket();
        var socket = new RelaySocket(webSocket, null, TimeProvider.System, NullLogger.Instance);
        socket.Start();

        Assert.True(socket.TryEnqueueText("{\"t\":\"pong\"}"));

        var (type, payload) = await webSocket.Sent.Task.WaitAsync(Timeout);
        Assert.Equal(WebSocketMessageType.Text, type);
        Assert.Equal("{\"t\":\"pong\"}", Encoding.UTF8.GetString(payload));
    }

    [Fact]
    public void GameTextFraming_RefusesBinaryFrames()
    {
        var socket = new RelaySocket(new CapturingWebSocket(), null, TimeProvider.System, NullLogger.Instance);
        socket.UseGameTextFraming();

        Assert.False(socket.TryEnqueueBinary(new byte[] { 0x01 }));
        Assert.False(socket.IsClosing);
    }

    private sealed class CapturingWebSocket : WebSocket
    {
        public TaskCompletionSource<(WebSocketMessageType Type, byte[] Payload)> Sent { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override WebSocketCloseStatus? CloseStatus => null;

        public override string? CloseStatusDescription => null;

        public override WebSocketState State => WebSocketState.Open;

        public override string? SubProtocol => null;

        public override void Abort()
        {
        }

        public override Task CloseAsync(
            WebSocketCloseStatus closeStatus,
            string? statusDescription,
            CancellationToken cancellationToken) => Task.CompletedTask;

        public override Task CloseOutputAsync(
            WebSocketCloseStatus closeStatus,
            string? statusDescription,
            CancellationToken cancellationToken) => Task.CompletedTask;

        public override void Dispose()
        {
        }

        public override Task<WebSocketReceiveResult> ReceiveAsync(
            ArraySegment<byte> buffer,
            CancellationToken cancellationToken) =>
            Task.FromResult(new WebSocketReceiveResult(0, WebSocketMessageType.Close, true));

        public override Task SendAsync(
            ArraySegment<byte> buffer,
            WebSocketMessageType messageType,
            bool endOfMessage,
            CancellationToken cancellationToken)
        {
            Sent.TrySetResult((messageType, buffer.ToArray()));
            return Task.CompletedTask;
        }
    }
}
