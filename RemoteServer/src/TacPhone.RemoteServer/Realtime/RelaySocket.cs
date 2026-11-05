using System.Net.WebSockets;
using System.Text;
using System.Threading.Channels;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// One WebSocket plus a bounded outbound queue. Every send goes through the
/// single writer task, so frames keep their order and a slow peer can never
/// block a relay route or a registry lock. A peer that fills the queue is
/// treated as a slow consumer and aborted.
/// </summary>
public sealed class RelaySocket
{
    /// <summary>Prefix of every text frame the relay sends to the game socket.</summary>
    public const string GameTextPrefix = "RELAY:";

    private const int OutboundQueueCapacity = 16;
    private static readonly TimeSpan CloseTimeout = TimeSpan.FromSeconds(4);
    private static readonly TimeSpan CloseHandshakeTimeout = TimeSpan.FromSeconds(2);

    private readonly WebSocket _socket;
    private readonly ILogger _logger;
    private readonly TimeProvider _time;
    private readonly Channel<OutboundMessage> _outbound;
    private readonly CancellationTokenSource _writerCts = new();
    private readonly TaskCompletionSource _writerFinished = new(TaskCreationOptions.RunContinuationsAsynchronously);

    private long _lastActivityUnixSeconds;
    private long _lastPingUnixSeconds;
    private int _started;
    private int _closing;
    private volatile bool _gameText;

    public RelaySocket(WebSocket socket, string? userAgent, TimeProvider time, ILogger logger)
    {
        _socket = socket;
        _logger = logger;
        _time = time;
        UserAgent = userAgent;
        _outbound = Channel.CreateBounded<OutboundMessage>(new BoundedChannelOptions(OutboundQueueCapacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait,
            AllowSynchronousContinuations = false,
        });

        Touch();
    }

    /// <summary>User-Agent of the HTTP upgrade request, if any.</summary>
    public string? UserAgent { get; }

    public bool IsClosing => Volatile.Read(ref _closing) != 0;

    public DateTimeOffset LastActivity => DateTimeOffset.FromUnixTimeSeconds(Interlocked.Read(ref _lastActivityUnixSeconds));

    public TimeSpan IdleFor => _time.GetUtcNow() - LastActivity;

    /// <summary>
    /// Switches the socket to the game text framing: every text frame is sent as
    /// <see cref="GameTextPrefix"/> + base64(UTF-8). Browser sockets stay raw and
    /// unencoded. Called once the first control frame identifies the game.
    /// </summary>
    public void UseGameTextFraming() => _gameText = true;

    /// <summary>Wraps a game-bound text frame in the <c>RELAY:</c> base64 form.</summary>
    public static string EncodeGameText(string text) =>
        GameTextPrefix + Convert.ToBase64String(Encoding.UTF8.GetBytes(text));

    /// <summary>Starts the writer task. Must be called exactly once, before enqueueing.</summary>
    public void Start()
    {
        if (Interlocked.Exchange(ref _started, 1) == 0)
        {
            _ = Task.Run(RunWriterAsync);
        }
    }

    /// <summary>Marks inbound traffic, which keeps the idle timeout away.</summary>
    public void Touch() =>
        Interlocked.Exchange(ref _lastActivityUnixSeconds, _time.GetUtcNow().ToUnixTimeSeconds());

    public bool TryEnqueueText(string text) =>
        TryEnqueue(new OutboundMessage(
            OutboundKind.Text,
            Encoding.UTF8.GetBytes(_gameText ? EncodeGameText(text) : text),
            null));

    public bool TryEnqueueBinary(ReadOnlyMemory<byte> payload)
    {
        // The game socket is text only; a binary frame would be a programming
        // error, not something to send.
        if (_gameText)
        {
            _logger.LogWarning("Refusing a binary frame for the text-only game socket");
            return false;
        }

        return TryEnqueue(new OutboundMessage(OutboundKind.Binary, payload, null));
    }

    /// <summary>
    /// True (at most once per <paramref name="interval"/>) when the peer has been
    /// quiet long enough to deserve an application-level keepalive ping.
    /// </summary>
    public bool TryMarkPing(TimeSpan interval)
    {
        var seconds = (long)interval.TotalSeconds;
        var now = _time.GetUtcNow().ToUnixTimeSeconds();
        var last = Math.Max(Interlocked.Read(ref _lastActivityUnixSeconds), Interlocked.Read(ref _lastPingUnixSeconds));
        if (seconds > 0 && now - last < seconds)
        {
            return false;
        }

        Interlocked.Exchange(ref _lastPingUnixSeconds, now);
        return true;
    }

    /// <summary>
    /// Queues a close frame behind everything already queued and waits (bounded)
    /// for the writer to flush. Aborts the transport when that takes too long.
    /// </summary>
    public async Task CloseAsync(string reason)
    {
        if (Volatile.Read(ref _started) == 0)
        {
            Abort();
            return;
        }

        if (Interlocked.Exchange(ref _closing, 1) == 0)
        {
            if (!_outbound.Writer.TryWrite(OutboundMessage.Close(reason)))
            {
                Abort();
                return;
            }

            _outbound.Writer.TryComplete();
        }

        try
        {
            await _writerFinished.Task.WaitAsync(CloseTimeout).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Fall through to the abort below.
        }

        // The close frame is flushed (or the flush timed out). Tear the transport
        // down so a peer that never answers the close handshake cannot keep a
        // session, its buffers and its peer id alive.
        Abort();
    }

    /// <summary>Immediately tears the socket down. Safe to call from any thread, repeatedly.</summary>
    public void Abort()
    {
        Volatile.Write(ref _closing, 1);
        _outbound.Writer.TryComplete();

        try
        {
            _writerCts.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Already torn down.
        }

        try
        {
            _socket.Abort();
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Aborting the relay socket failed");
        }

        _writerFinished.TrySetResult();
    }

    private bool TryEnqueue(OutboundMessage message)
    {
        if (IsClosing)
        {
            return false;
        }

        if (_outbound.Writer.TryWrite(message))
        {
            return true;
        }

        _logger.LogWarning("Dropping a relay peer: outbound queue is full (slow consumer)");
        Abort();
        return false;
    }

    private async Task RunWriterAsync()
    {
        try
        {
            while (await _outbound.Reader.WaitToReadAsync(_writerCts.Token).ConfigureAwait(false))
            {
                while (_outbound.Reader.TryRead(out var message))
                {
                    switch (message.Kind)
                    {
                        case OutboundKind.Text:
                            await _socket.SendAsync(message.Payload, WebSocketMessageType.Text, true, _writerCts.Token)
                                .ConfigureAwait(false);
                            break;

                        case OutboundKind.Binary:
                            await _socket.SendAsync(message.Payload, WebSocketMessageType.Binary, true, _writerCts.Token)
                                .ConfigureAwait(false);
                            break;

                        case OutboundKind.Close:
                            // Complete the closing handshake so frames queued before
                            // the close (peer-kicked, host-offline, rejected) are not
                            // lost to a TCP reset. Bounded: an unresponsive peer is
                            // aborted after a couple of seconds.
                            using (var closeCts = CancellationTokenSource.CreateLinkedTokenSource(_writerCts.Token))
                            {
                                closeCts.CancelAfter(CloseHandshakeTimeout);

                                try
                                {
                                    await _socket.CloseAsync(
                                            WebSocketCloseStatus.NormalClosure,
                                            message.CloseReason ?? "closed",
                                            closeCts.Token)
                                        .ConfigureAwait(false);
                                }
                                catch (Exception)
                                {
                                    // The peer never answered the close frame; the
                                    // caller aborts the transport next.
                                }
                            }

                            return;
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Shutdown or abort.
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Relay socket send loop failed");
            Abort();
        }
        finally
        {
            _writerFinished.TrySetResult();
        }
    }

    private enum OutboundKind
    {
        Text,
        Binary,
        Close,
    }

    private readonly record struct OutboundMessage(OutboundKind Kind, ReadOnlyMemory<byte> Payload, string? CloseReason)
    {
        public static OutboundMessage Close(string reason) => new(OutboundKind.Close, ReadOnlyMemory<byte>.Empty, reason);
    }
}
