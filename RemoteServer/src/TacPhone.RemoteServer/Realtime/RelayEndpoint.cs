using System.Net.WebSockets;
using System.Text;
using TacPhone.RemoteServer.Configuration;
using TacPhone.RemoteServer.Infrastructure;
using TacPhone.RemoteServer.Protocol;
using TacPhone.RemoteServer.Storage;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// The <c>/ws</c> endpoint: accepts a socket, decides its role from the first
/// control frame, and relays application frames between one game host and its
/// attached browsers.
/// </summary>
/// <remarks>
/// Concurrency model:
/// <list type="bullet">
/// <item>Frame routing only reads <see cref="HostSession.Clients"/> and enqueues
/// into per-socket bounded queues, so it never awaits a peer.</item>
/// <item>Attach, detach, kick and share changes take <see cref="HostSession.Gate"/>
/// and send their notifications after releasing it.</item>
/// <item>Every send is ordered by the socket's single writer task, and a peer
/// whose queue is full is aborted instead of blocking the relay.</item>
/// </list>
/// </remarks>
public sealed partial class RelayEndpoint
{
    private static readonly TimeSpan FirstFrameTimeout = TimeSpan.FromSeconds(20);

    private readonly TacPhoneOptions _options;
    private readonly RemoteRepository _repository;
    private readonly HostRegistry _registry;
    private readonly AttachRateLimiters _limiters;
    private readonly TerrainCache _terrainCache;
    private readonly TextureCache _textureCache;
    private readonly FileCache _fileCache;
    private readonly TimeProvider _time;
    private readonly ILogger<RelayEndpoint> _logger;

    private long _lastCleanupUnix;

    public RelayEndpoint(
        TacPhoneOptions options,
        RemoteRepository repository,
        HostRegistry registry,
        AttachRateLimiters limiters,
        TerrainCache terrainCache,
        TextureCache textureCache,
        FileCache fileCache,
        TimeProvider time,
        ILogger<RelayEndpoint> logger)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _repository = repository ?? throw new ArgumentNullException(nameof(repository));
        _registry = registry ?? throw new ArgumentNullException(nameof(registry));
        _limiters = limiters ?? throw new ArgumentNullException(nameof(limiters));
        _terrainCache = terrainCache ?? throw new ArgumentNullException(nameof(terrainCache));
        _textureCache = textureCache ?? throw new ArgumentNullException(nameof(textureCache));
        _fileCache = fileCache ?? throw new ArgumentNullException(nameof(fileCache));
        _time = time ?? throw new ArgumentNullException(nameof(time));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    // ------------------------------------------------------------ entry point

    public async Task HandleAsync(HttpContext context, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);

        var userAgent = context.Request.Headers.UserAgent.ToString();
        var remoteIp = context.Connection.RemoteIpAddress;
        var shareBaseUrl = _options.ResolveShareBaseUrl(context.Request);
        var deviceLabel = LabelHelper.FromUserAgent(userAgent);

        var webSocket = await context.WebSockets.AcceptWebSocketAsync().ConfigureAwait(false);
        var socket = new RelaySocket(webSocket, userAgent, _time, _logger);
        socket.Start();

        try
        {
            var reader = new RelayFrameReader(webSocket, _options.Limits.EffectiveMaxFrameBytes);
            var first = await ReadFirstFrameAsync(reader, cancellationToken).ConfigureAwait(false);

            if (first is null)
            {
                return;
            }

            if (first.Value.TooLarge)
            {
                await SendErrorAndCloseAsync(socket, ErrorCodes.TooLarge, "first frame exceeds MaxFrameBytes").ConfigureAwait(false);
                return;
            }

            if (first.Value.Closed)
            {
                return;
            }

            if (first.Value.Type != WebSocketMessageType.Text)
            {
                await SendErrorAndCloseAsync(socket, ErrorCodes.Proto, "expected a text control frame").ConfigureAwait(false);
                return;
            }

            var frame = ParseFirstFrame(Encoding.UTF8.GetString(first.Value.Payload));
            if (frame is null)
            {
                await SendErrorAndCloseAsync(socket, ErrorCodes.Proto, "expected a JSON control frame with a 't' field").ConfigureAwait(false);
                return;
            }

            if (frame.Type == ControlTypes.Auth && string.Equals(frame.Role, "game", StringComparison.Ordinal))
            {
                // Every text frame to the game is "RELAY:" + base64, including the
                // auth-ok and any error that follows.
                socket.UseGameTextFraming();
                await RunGameAsync(socket, reader, frame, shareBaseUrl, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (frame.Type == ControlTypes.Attach && string.Equals(frame.Role, "client", StringComparison.Ordinal))
            {
                await RunClientAsync(socket, reader, frame, deviceLabel, remoteIp, cancellationToken).ConfigureAwait(false);
                return;
            }

            await SendErrorAndCloseAsync(socket, ErrorCodes.Proto, "unknown first control frame").ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Server shutdown or a client that disappeared mid-handshake.
        }
        catch (WebSocketException ex)
        {
            _logger.LogDebug(ex, "WebSocket session ended");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Relay session failed");
        }
        finally
        {
            await socket.CloseAsync("closed").ConfigureAwait(false);
            webSocket.Dispose();
        }
    }

    // --------------------------------------------------------------- helpers

    private async Task<ReceivedFrame?> ReadFirstFrameAsync(RelayFrameReader reader, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(FirstFrameTimeout);

        try
        {
            return await reader.ReceiveAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogDebug("A socket sent no first control frame in time");
            return null;
        }
    }

    private static async Task SendErrorAndCloseAsync(RelaySocket socket, string code, string message)
    {
        socket.TryEnqueueText(ServerFrames.Error(code, message));
        await socket.CloseAsync(code).ConfigureAwait(false);
    }
}
