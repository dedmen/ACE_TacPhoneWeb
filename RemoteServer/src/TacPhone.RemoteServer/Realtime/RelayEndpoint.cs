using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
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
public sealed class RelayEndpoint
{
    private static readonly TimeSpan FirstFrameTimeout = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan KeepAliveInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan CleanupInterval = TimeSpan.FromSeconds(60);

    private static readonly string PingFrame = ServerFrames.Ping();

    private readonly TacPhoneOptions _options;
    private readonly RemoteRepository _repository;
    private readonly HostRegistry _registry;
    private readonly AttachRateLimiters _limiters;
    private readonly TerrainCache _terrainCache;
    private readonly TimeProvider _time;
    private readonly ILogger<RelayEndpoint> _logger;

    private long _lastCleanupUnix;

    public RelayEndpoint(
        TacPhoneOptions options,
        RemoteRepository repository,
        HostRegistry registry,
        AttachRateLimiters limiters,
        TerrainCache terrainCache,
        TimeProvider time,
        ILogger<RelayEndpoint> logger)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _repository = repository ?? throw new ArgumentNullException(nameof(repository));
        _registry = registry ?? throw new ArgumentNullException(nameof(registry));
        _limiters = limiters ?? throw new ArgumentNullException(nameof(limiters));
        _terrainCache = terrainCache ?? throw new ArgumentNullException(nameof(terrainCache));
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

    // -------------------------------------------------------------- game side

    private async Task RunGameAsync(
        RelaySocket socket,
        RelayFrameReader reader,
        FirstFrame auth,
        string shareBaseUrl,
        CancellationToken cancellationToken)
    {
        if (auth.Proto != ProtocolConstants.Version)
        {
            await SendErrorAndCloseAsync(socket, ErrorCodes.Proto, $"unsupported protocol version {auth.Proto?.ToString() ?? "none"}")
                .ConfigureAwait(false);
            return;
        }

        var hostLabel = string.IsNullOrWhiteSpace(auth.Label) ? null : LabelHelper.FromUserAgent(auth.Label);

        HostAuthResult authResult;
        try
        {
            authResult = await _repository.AuthenticateHostAsync(auth.HostId, auth.Secret, hostLabel, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Host authentication failed");
            await SendErrorAndCloseAsync(socket, ErrorCodes.Internal, "storage unavailable").ConfigureAwait(false);
            return;
        }

        var hostId = authResult.HostId;
        if (!_registry.Contains(hostId) && _registry.HostCount >= _options.Limits.MaxHosts)
        {
            _logger.LogWarning("Rejecting a game connection: MaxHosts reached");
            await SendErrorAndCloseAsync(socket, ErrorCodes.MaxHosts, "too many online hosts").ConfigureAwait(false);
            return;
        }

        if (authResult.IssuedSecret is not null)
        {
            // The secret itself is never logged; it is only returned in auth-ok.
            _logger.LogInformation("Issued a new host identity");
        }

        ShareRecord? activeShare = null;
        try
        {
            activeShare = await _repository.GetActiveShareAsync(hostId, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Could not load the active share");
        }

        var session = new HostSession(
            hostId,
            socket,
            shareBaseUrl,
            activeShare is null ? null : DateTimeOffset.FromUnixTimeSeconds(activeShare.ExpiresUtc),
            activeShare?.ShareId);

        if (!socket.TryEnqueueText(ServerFrames.AuthOk(hostId, authResult.IssuedSecret)))
        {
            return;
        }

        var displaced = _registry.AddOrReplace(session);
        if (displaced is not null)
        {
            // The replacement session must start without the previous session's
            // terrain pin (the mission may have changed).
            _terrainCache.Unpin(hostId);
            _logger.LogInformation("A game connection for an online host was replaced");
            await RetireHostSessionAsync(displaced, RejectionReasons.Superseded).ConfigureAwait(false);
        }

        _logger.LogInformation("Game host connected");

        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                ReceivedFrame frame;
                try
                {
                    frame = await reader.ReceiveAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (WebSocketException)
                {
                    break;
                }

                if (frame.Closed)
                {
                    break;
                }

                socket.Touch();

                if (frame.TooLarge)
                {
                    _logger.LogWarning("Closing a game socket after an oversized frame");
                    socket.TryEnqueueText(ServerFrames.Error(ErrorCodes.TooLarge, "frame exceeds MaxFrameBytes"));
                    break;
                }

                try
                {
                    if (frame.Type == WebSocketMessageType.Binary)
                    {
                        HandleGameBinary(session, frame.Payload);
                    }
                    else
                    {
                        await HandleGameTextAsync(session, Encoding.UTF8.GetString(frame.Payload), cancellationToken)
                            .ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to handle a game frame");
                    socket.TryEnqueueText(ServerFrames.Error(ErrorCodes.Internal, "could not handle the frame"));
                }
            }
        }
        finally
        {
            if (_registry.Remove(hostId, session))
            {
                // Only the session that is still registered owns the terrain pin.
                // A displaced session must not clear the replacement's pin.
                _terrainCache.Unpin(hostId);
                _logger.LogInformation("Game host disconnected");
                await CloseHostClientsAsync(session, RejectionReasons.HostStop).ConfigureAwait(false);
            }
        }
    }

    private void HandleGameBinary(HostSession session, byte[] payload)
    {
        if (!FrameCodec.TryDecodeGameFrame(payload, out var peerId, out var applicationPayload))
        {
            session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.BadFrame, "expected the binary peer envelope"));
            return;
        }

        ForwardToClient(session, peerId, applicationPayload);
    }

    private async Task HandleGameTextAsync(HostSession session, string text, CancellationToken cancellationToken)
    {
        // The future SQF client is text only and sends "<peerId>\n<application JSON>".
        if (FrameCodec.TryDecodeTextGameFrame(text, out var peerId, out var applicationJson))
        {
            ForwardToClient(session, peerId, Encoding.UTF8.GetBytes(applicationJson));
            return;
        }

        if (!TryParseJsonObject(text, out var document))
        {
            session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.BadFrame, "expected a control frame or '<peerId>\\n<json>'"));
            return;
        }

        using (document)
        {
            var root = document.RootElement;
            var type = GetString(root, "t");

            switch (type)
            {
                case ControlTypes.Ping:
                    session.Game.TryEnqueueText(ServerFrames.Pong());
                    return;

                case ControlTypes.Pong:
                    // Keepalive answer from the game; activity is already recorded.
                    return;

                case ControlTypes.CodeNew:
                    await HandleCodeNewAsync(session, cancellationToken).ConfigureAwait(false);
                    return;

                case ControlTypes.ShareCreate:
                    await HandleShareCreateAsync(session, GetInt(root, "ttlSeconds"), cancellationToken).ConfigureAwait(false);
                    return;

                case ControlTypes.ShareRevoke:
                    await HandleShareRevokeAsync(session, cancellationToken).ConfigureAwait(false);
                    return;

                case ControlTypes.Kick:
                    await HandleKickAsync(session, GetString(root, "peerId"), cancellationToken).ConfigureAwait(false);
                    return;

                default:
                    _logger.LogWarning("Game sent an unknown control frame type '{FrameType}'", type ?? "(none)");
                    session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.Proto, $"unknown control frame: {type ?? "(none)"}"));
                    return;
            }
        }
    }

    private void ForwardToClient(HostSession session, string peerId, ReadOnlyMemory<byte> payload)
    {
        // Terrain replies are large; only look inside a frame while a forwarded
        // terrain request is actually outstanding. TakePending runs only after a
        // successful parse so a coincidental key cannot consume an entry.
        if (_terrainCache.Enabled &&
            _terrainCache.HasPending &&
            TerrainRequest.TryReadReply(payload.Span, out var replyKey, out var terrainData) &&
            _terrainCache.TakePending(peerId, replyKey, out var hostId, out var configHash) &&
            !string.IsNullOrEmpty(terrainData))
        {
            var contentHash = TerrainCache.ComputeContentHash(terrainData);
            _terrainCache.Pin(hostId, configHash, contentHash, terrainData);
        }

        if (!session.Clients.TryGetValue(peerId, out var client))
        {
            // Unknown peers are dropped: the browser may have just closed.
            _logger.LogDebug("Dropping an application frame for an unknown peer");
            return;
        }

        // A full queue aborts the peer; its receive loop then detaches it.
        client.Socket.TryEnqueueBinary(payload);
    }

    private async Task HandleCodeNewAsync(HostSession session, CancellationToken cancellationToken)
    {
        var now = _time.GetUtcNow();
        var nowUnix = now.ToUnixTimeSeconds();
        var allowed = false;

        await session.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (nowUnix - session.CodeMintWindowStartUnix >= 60 || nowUnix < session.CodeMintWindowStartUnix)
            {
                session.CodeMintWindowStartUnix = nowUnix;
                session.CodeMintsInWindow = 0;
            }

            if (session.CodeMintsInWindow < HostSession.CodeMintsPerMinute)
            {
                session.CodeMintsInWindow++;
                allowed = true;
            }
        }
        finally
        {
            session.Gate.Release();
        }

        if (!allowed)
        {
            session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.RateLimit, "too many pairing codes"));
            return;
        }

        var ttl = _options.Limits.PairCodeTtlSeconds;
        var code = CrockfordBase32.FormatPairCode(CrockfordBase32.Random(CrockfordBase32.PairCodeLength));

        await _repository.CreatePairCodeAsync(session.HostId, code, nowUnix + ttl, cancellationToken)
            .ConfigureAwait(false);

        session.Game.TryEnqueueText(ServerFrames.Code(code, ttl));
    }

    private async Task HandleShareCreateAsync(HostSession session, int? requestedTtlSeconds, CancellationToken cancellationToken)
    {
        var ttl = ClampShareTtl(requestedTtlSeconds);
        var expiresUtc = _time.GetUtcNow().ToUnixTimeSeconds() + ttl;

        ShareCreation creation;
        try
        {
            creation = await _repository.CreateShareReplacementAsync(session.HostId, expiresUtc, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not create a share");
            session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.Internal, "could not create the share"));
            return;
        }

        await session.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            session.ShareId = creation.ShareId;
            session.ShareExpiresAt = DateTimeOffset.FromUnixTimeSeconds(creation.ExpiresUtc);
        }
        finally
        {
            session.Gate.Release();
        }

        session.Game.TryEnqueueText(ServerFrames.Share(creation.Key, session.BuildShareUrl(creation.Key), ttl));

        // One active share per host: every device bound to the share we just
        // replaced dies. Devices that attach with the new key are untouched.
        await KickShareDevicesAsync(session, creation.ReplacedShareIds, RejectionReasons.Revoked, RejectionReasons.Kicked)
            .ConfigureAwait(false);
    }

    private async Task HandleShareRevokeAsync(HostSession session, CancellationToken cancellationToken)
    {
        ShareRevocation revocation;
        try
        {
            revocation = await _repository.RevokeSharesAsync(session.HostId, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not revoke the share");
            session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.Internal, "could not revoke the share"));
            return;
        }

        await session.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            session.ShareId = null;
            session.ShareExpiresAt = null;
        }
        finally
        {
            session.Gate.Release();
        }

        session.Game.TryEnqueueText(ServerFrames.ShareRevoked());
        await KickShareDevicesAsync(session, revocation.RevokedShareIds, RejectionReasons.Revoked, RejectionReasons.Kicked)
            .ConfigureAwait(false);
    }

    private async Task HandleKickAsync(HostSession session, string? requestedPeerId, CancellationToken cancellationToken)
    {
        if (requestedPeerId is null || !CrockfordBase32.IsPeerId(requestedPeerId))
        {
            session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.BadFrame, "kick needs a valid peerId"));
            return;
        }

        var peerId = requestedPeerId;

        ClientSession? client;
        await session.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            session.Clients.TryRemove(peerId, out client);
        }
        finally
        {
            session.Gate.Release();
        }

        if (client is null)
        {
            session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.UnknownPeer, "no such peer"));
            return;
        }

        client.Socket.TryEnqueueText(ServerFrames.PeerKicked(RejectionReasons.Kicked));
        await client.Socket.CloseAsync("kicked").ConfigureAwait(false);
        session.Game.TryEnqueueText(ServerFrames.PeerLeft(peerId, RejectionReasons.Kicked));
    }

    // ------------------------------------------------------------ client side

    private async Task RunClientAsync(
        RelaySocket socket,
        RelayFrameReader reader,
        FirstFrame attach,
        string deviceLabel,
        IPAddress? remoteIp,
        CancellationToken cancellationToken)
    {
        if (attach.Proto != ProtocolConstants.Version)
        {
            await RejectAsync(socket, RejectionReasons.Proto).ConfigureAwait(false);
            return;
        }

        var ipKey = remoteIp?.ToString() ?? "unknown";
        if (!_limiters.PerIp.TryAcquire(ipKey, _options.Limits.AttachAttemptsPerMinutePerIp))
        {
            _logger.LogWarning("Attach rate limit reached for a client IP");
            await RejectAsync(socket, RejectionReasons.RateLimit).ConfigureAwait(false);
            return;
        }

        AttachResult result;
        try
        {
            result = await ResolveAttachAsync(attach, deviceLabel, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Attach failed");
            socket.TryEnqueueText(ServerFrames.Error(ErrorCodes.Internal, "storage unavailable"));
            await socket.CloseAsync("attach failed").ConfigureAwait(false);
            return;
        }

        switch (result.Status)
        {
            case AttachStatus.Rejected:
                await RejectAsync(socket, result.Reason ?? RejectionReasons.BadToken).ConfigureAwait(false);
                return;

            case AttachStatus.HostOffline:
                socket.TryEnqueueText(ServerFrames.HostOffline());
                await socket.CloseAsync("host offline").ConfigureAwait(false);
                return;

            default:
                await CompleteAttachAsync(socket, reader, result, cancellationToken).ConfigureAwait(false);
                return;
        }
    }

    private async Task<AttachResult> ResolveAttachAsync(FirstFrame attach, string deviceLabel, CancellationToken cancellationToken)
    {
        var nowUnix = _time.GetUtcNow().ToUnixTimeSeconds();

        if (!string.IsNullOrWhiteSpace(attach.DeviceToken))
        {
            var tokenHash = Hashing.Sha256(attach.DeviceToken);
            var device = await _repository.FindDeviceAsync(tokenHash, cancellationToken).ConfigureAwait(false);
            if (device is null)
            {
                return AttachResult.Rejected(RejectionReasons.BadToken);
            }

            if (!string.IsNullOrEmpty(attach.HostId) && !string.Equals(device.HostId, attach.HostId, StringComparison.Ordinal))
            {
                return AttachResult.Rejected(RejectionReasons.BadToken);
            }

            if (device.ExpiresUtc is long expires && expires <= nowUnix)
            {
                return AttachResult.Rejected(RejectionReasons.Expired);
            }

            if (device.ShareId is not null)
            {
                var share = await _repository.FindShareByIdAsync(device.ShareId, cancellationToken).ConfigureAwait(false);
                if (share is null || share.RevokedUtc is not null)
                {
                    return AttachResult.Rejected(RejectionReasons.Revoked);
                }

                if (share.ExpiresUtc <= nowUnix)
                {
                    return AttachResult.Rejected(RejectionReasons.Expired);
                }
            }

            var host = _registry.Get(device.HostId);
            if (host is null)
            {
                return AttachResult.HostOffline();
            }

            try
            {
                await _repository.TouchDeviceAsync(tokenHash, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogDebug(ex, "Could not update the device last-seen timestamp");
            }

            return AttachResult.Attached(host, device, null, device.ShareId is null ? "owner" : "share");
        }

        if (!string.IsNullOrWhiteSpace(attach.Code))
        {
            var code = CrockfordBase32.NormalizePairCode(attach.Code);
            if (code is null)
            {
                return AttachResult.Rejected(RejectionReasons.BadCode);
            }

            var hostId = await _repository.ConsumePairCodeAsync(code, cancellationToken).ConfigureAwait(false);
            if (hostId is null)
            {
                return AttachResult.Rejected(RejectionReasons.BadCode);
            }

            var host = _registry.Get(hostId);
            if (host is null)
            {
                return AttachResult.HostOffline();
            }

            var issued = await _repository.IssueDeviceAsync(hostId, null, deviceLabel, null, cancellationToken)
                .ConfigureAwait(false);
            return AttachResult.Attached(host, issued.Record, issued.Token, "owner");
        }

        if (!string.IsNullOrWhiteSpace(attach.Share))
        {
            var key = CrockfordBase32.NormalizeShareKey(attach.Share);
            if (key is null)
            {
                return AttachResult.Rejected(RejectionReasons.BadShare);
            }

            var share = await _repository.FindShareByKeyHashAsync(Hashing.Sha256(key), cancellationToken)
                .ConfigureAwait(false);
            if (share is null)
            {
                return AttachResult.Rejected(RejectionReasons.BadShare);
            }

            if (share.RevokedUtc is not null)
            {
                return AttachResult.Rejected(RejectionReasons.Revoked);
            }

            if (share.ExpiresUtc <= nowUnix)
            {
                return AttachResult.Rejected(RejectionReasons.Expired);
            }

            if (!_limiters.PerShare.TryAcquire(share.ShareId, _options.Limits.AttachAttemptsPerMinutePerShare))
            {
                _logger.LogWarning("Attach rate limit reached for a share");
                return AttachResult.Rejected(RejectionReasons.RateLimit);
            }

            var host = _registry.Get(share.HostId);
            if (host is null)
            {
                return AttachResult.HostOffline();
            }

            var issued = await _repository
                .IssueDeviceAsync(host.HostId, share.ShareId, deviceLabel, share.ExpiresUtc, cancellationToken)
                .ConfigureAwait(false);
            return AttachResult.Attached(host, issued.Record, issued.Token, "share");
        }

        return AttachResult.Rejected(RejectionReasons.BadToken);
    }

    private async Task CompleteAttachAsync(
        RelaySocket socket,
        RelayFrameReader reader,
        AttachResult result,
        CancellationToken cancellationToken)
    {
        var host = result.Host!;
        var device = result.Device!;
        var peerId = host.NewPeerId();
        var connectedAt = _time.GetUtcNow();
        var firstSeenAt = DateTimeOffset.FromUnixTimeSeconds(device.CreatedUtc);

        var client = new ClientSession(
            peerId,
            socket,
            result.Via,
            device.ShareId,
            device.TokenHash,
            device.Label,
            connectedAt,
            firstSeenAt);

        string? rejection = null;
        await host.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (host.Game.IsClosing)
            {
                rejection = "host-offline";
            }
            else if (host.Clients.Count >= _options.Limits.MaxClientsPerHost)
            {
                _logger.LogWarning("Rejecting an attach: MaxClientsPerHost reached");
                rejection = RejectionReasons.HostFull;
            }
            else
            {
                host.Clients[peerId] = client;
            }
        }
        finally
        {
            host.Gate.Release();
        }

        if (rejection == "host-offline")
        {
            socket.TryEnqueueText(ServerFrames.HostOffline());
            await socket.CloseAsync("host offline").ConfigureAwait(false);
            return;
        }

        if (rejection is not null)
        {
            await RejectAsync(socket, rejection).ConfigureAwait(false);
            return;
        }

        // attach-ok is queued before peer-joined, and the game only learns about
        // the peer from peer-joined, so no application frame can overtake it.
        if (!socket.TryEnqueueText(ServerFrames.AttachOk(host.HostId, peerId, result.NewToken)))
        {
            host.Clients.TryRemove(peerId, out _);
            return;
        }

        if (!host.Game.TryEnqueueText(ServerFrames.PeerJoined(peerId, client.Label, client.Via, connectedAt, firstSeenAt)))
        {
            host.Clients.TryRemove(peerId, out _);
            socket.Abort();
            return;
        }

        _logger.LogInformation("Attached a peer via {Via}", client.Via);

        await RunClientLoopAsync(host, client, reader, cancellationToken).ConfigureAwait(false);
    }

    private async Task RunClientLoopAsync(
        HostSession host,
        ClientSession client,
        RelayFrameReader reader,
        CancellationToken cancellationToken)
    {
        var reason = RejectionReasons.Closed;

        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                ReceivedFrame frame;
                try
                {
                    frame = await reader.ReceiveAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (WebSocketException)
                {
                    break;
                }

                if (frame.Closed)
                {
                    break;
                }

                client.Socket.Touch();

                if (frame.TooLarge)
                {
                    _logger.LogWarning("Closing a client socket after an oversized frame");
                    client.Socket.TryEnqueueText(ServerFrames.Error(ErrorCodes.TooLarge, "frame exceeds MaxFrameBytes"));
                    break;
                }

                if (frame.Type == WebSocketMessageType.Text)
                {
                    var text = Encoding.UTF8.GetString(frame.Payload);
                    if (IsControl(text, ControlTypes.Ping))
                    {
                        client.Socket.TryEnqueueText(ServerFrames.Pong());
                        continue;
                    }

                    if (IsControl(text, ControlTypes.Pong))
                    {
                        // Keepalive answer from the browser; not application data.
                        continue;
                    }
                }

                // Browsers send the raw application JSON; text is accepted as well.
                // Terrain SVGs are cached per host: a matching pin answers the
                // browser directly and never reaches the game.
                if (_terrainCache.Enabled &&
                    TerrainRequest.TryParse(frame.Payload, out var requestKey, out var configHash))
                {
                    _terrainCache.SweepPending(_options.TerrainCache.PendingTimeout());

                    if (_terrainCache.TryGetPin(host.HostId, configHash, out var pinned))
                    {
                        client.Socket.TryEnqueueBinary(TerrainRequest.BuildReply(requestKey, pinned));
                        continue;
                    }

                    _terrainCache.AddPending(client.PeerId, requestKey, host.HostId, configHash);
                }

                var envelope = FrameCodec.EncodeGameFrame(client.PeerId, frame.Payload);
                if (!host.Game.TryEnqueueBinary(envelope))
                {
                    _logger.LogDebug("The game socket refused a frame; detaching the peer");
                    break;
                }
            }
        }
        finally
        {
            if (host.Clients.TryRemove(client.PeerId, out _))
            {
                host.Game.TryEnqueueText(ServerFrames.PeerLeft(client.PeerId, reason));
            }
        }
    }

    // ------------------------------------------------------------ maintenance

    /// <summary>
    /// Periodic housekeeping: keepalive pings, idle timeouts, expired share
    /// eviction and database cleanup. Called by <see cref="RelayMaintenanceService"/>.
    /// </summary>
    public async Task MaintenanceAsync(CancellationToken cancellationToken)
    {
        var now = _time.GetUtcNow();
        var nowUnix = now.ToUnixTimeSeconds();
        var idleTimeout = TimeSpan.FromSeconds(_options.Limits.IdleTimeoutSeconds);

        foreach (var host in _registry.Snapshot())
        {
            if (!host.Game.IsClosing)
            {
                if (host.Game.IdleFor > idleTimeout)
                {
                    _logger.LogInformation("Closing an idle game connection");
                    if (_registry.Remove(host.HostId, host))
                    {
                        _terrainCache.Unpin(host.HostId);
                        await CloseHostClientsAsync(host, RejectionReasons.Timeout).ConfigureAwait(false);
                    }

                    host.Game.Abort();
                    continue;
                }

                if (host.Game.TryMarkPing(KeepAliveInterval))
                {
                    host.Game.TryEnqueueText(PingFrame);
                }
            }

            var shareExpired = host.ShareExpiresAt is DateTimeOffset shareExpiresAt && shareExpiresAt <= now;
            var kicks = new List<(ClientSession Client, string KickReason, string PeerLeftReason)>();

            foreach (var client in host.Clients.Values)
            {
                if (client.Socket.IsClosing)
                {
                    continue;
                }

                if (shareExpired && client.IsShareDevice)
                {
                    kicks.Add((client, RejectionReasons.Expired, RejectionReasons.Kicked));
                    continue;
                }

                if (client.Socket.IdleFor > idleTimeout)
                {
                    kicks.Add((client, RejectionReasons.Timeout, RejectionReasons.Timeout));
                    continue;
                }

                if (client.Socket.TryMarkPing(KeepAliveInterval))
                {
                    client.Socket.TryEnqueueText(PingFrame);
                }
            }

            if (kicks.Count > 0)
            {
                // Never serialize slow close handshakes behind each other.
                await Task.WhenAll(kicks.Select(kick => KickPeerAsync(host, kick.Client, kick.KickReason, kick.PeerLeftReason)))
                    .ConfigureAwait(false);
            }
        }

        var lastCleanup = Interlocked.Read(ref _lastCleanupUnix);
        if (nowUnix >= lastCleanup && nowUnix - lastCleanup < (long)CleanupInterval.TotalSeconds)
        {
            return;
        }

        Interlocked.Exchange(ref _lastCleanupUnix, nowUnix);

        try
        {
            var deleted = await _repository.DeleteExpiredAsync(cancellationToken).ConfigureAwait(false);
            if (deleted > 0)
            {
                _logger.LogInformation("Removed {Count} expired rows", deleted);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Expired-row cleanup failed");
        }

        _limiters.Sweep();
    }

    /// <summary>Closes every host and client socket within a bounded budget.</summary>
    public async Task ShutdownAsync(CancellationToken cancellationToken)
    {
        var hosts = _registry.Snapshot();
        _registry.Clear();

        if (hosts.Count == 0)
        {
            return;
        }

        var tasks = new Task[hosts.Count];
        for (var i = 0; i < hosts.Count; i++)
        {
            tasks[i] = RetireHostSessionAsync(hosts[i], "server shutting down");
        }

        try
        {
            await Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(8), cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Shutdown did not close every socket in time");
        }
    }

    // --------------------------------------------------------------- helpers

    private async Task RetireHostSessionAsync(HostSession session, string reason)
    {
        await CloseHostClientsAsync(session, reason).ConfigureAwait(false);
        await session.Game.CloseAsync(reason).ConfigureAwait(false);
    }

    private async Task CloseHostClientsAsync(HostSession session, string reason)
    {
        var clients = new List<ClientSession>();

        await session.Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            clients.AddRange(session.Clients.Values);
            session.Clients.Clear();
        }
        finally
        {
            session.Gate.Release();
        }

        if (clients.Count == 0)
        {
            return;
        }

        var tasks = new Task[clients.Count];
        for (var i = 0; i < clients.Count; i++)
        {
            clients[i].Socket.TryEnqueueText(ServerFrames.HostOffline());
            tasks[i] = clients[i].Socket.CloseAsync(reason);
        }

        await Task.WhenAll(tasks).ConfigureAwait(false);
    }

    private async Task KickShareDevicesAsync(
        HostSession host,
        IReadOnlyCollection<string> replacedShareIds,
        string kickReason,
        string peerLeftReason)
    {
        var kicked = new List<ClientSession>();

        await host.Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            foreach (var client in host.Clients.Values)
            {
                if (!client.IsShareDevice)
                {
                    continue;
                }

                if (client.ShareId is null || !replacedShareIds.Contains(client.ShareId))
                {
                    continue;
                }

                if (host.Clients.TryRemove(client.PeerId, out _))
                {
                    kicked.Add(client);
                }
            }
        }
        finally
        {
            host.Gate.Release();
        }

        if (kicked.Count == 0)
        {
            return;
        }

        var tasks = new Task[kicked.Count];
        for (var i = 0; i < kicked.Count; i++)
        {
            var client = kicked[i];
            client.Socket.TryEnqueueText(ServerFrames.PeerKicked(kickReason));
            tasks[i] = client.Socket.CloseAsync(kickReason);
            host.Game.TryEnqueueText(ServerFrames.PeerLeft(client.PeerId, peerLeftReason));
        }

        await Task.WhenAll(tasks).ConfigureAwait(false);
    }

    private async Task KickPeerAsync(
        HostSession host,
        ClientSession client,
        string kickReason,
        string peerLeftReason)
    {
        await host.Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (!host.Clients.TryRemove(client.PeerId, out _))
            {
                return;
            }
        }
        finally
        {
            host.Gate.Release();
        }

        client.Socket.TryEnqueueText(ServerFrames.PeerKicked(kickReason));
        await client.Socket.CloseAsync(kickReason).ConfigureAwait(false);
        host.Game.TryEnqueueText(ServerFrames.PeerLeft(client.PeerId, peerLeftReason));
    }

    private async Task RejectAsync(RelaySocket socket, string reason)
    {
        socket.TryEnqueueText(ServerFrames.Rejected(reason));
        await socket.CloseAsync(reason).ConfigureAwait(false);
    }

    private static async Task SendErrorAndCloseAsync(RelaySocket socket, string code, string message)
    {
        socket.TryEnqueueText(ServerFrames.Error(code, message));
        await socket.CloseAsync(code).ConfigureAwait(false);
    }

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

    private int ClampShareTtl(int? requestedTtlSeconds)
    {
        var ttl = requestedTtlSeconds is null or <= 0 ? 3600 : requestedTtlSeconds.Value;
        return Math.Clamp(ttl, 60, _options.Limits.MaxShareTtlSeconds);
    }

    private static bool IsControl(string text, string expectedType)
    {
        if (!TryParseJsonObject(text, out var document))
        {
            return false;
        }

        using (document)
        {
            return GetString(document.RootElement, "t") == expectedType;
        }
    }

    private static FirstFrame? ParseFirstFrame(string json)
    {
        if (!TryParseJsonObject(json, out var document))
        {
            return null;
        }

        using (document)
        {
            var root = document.RootElement;
            var type = GetString(root, "t");
            if (string.IsNullOrEmpty(type))
            {
                return null;
            }

            return new FirstFrame(
                type,
                GetInt(root, "proto"),
                GetString(root, "role"),
                GetString(root, "hostId"),
                GetString(root, "secret"),
                GetString(root, "deviceToken"),
                GetString(root, "code"),
                GetString(root, "share"),
                GetString(root, "label"));
        }
    }

    private static bool TryParseJsonObject(string json, out JsonDocument document)
    {
        document = null!;

        if (string.IsNullOrEmpty(json) || json[0] != '{')
        {
            return false;
        }

        try
        {
            var parsed = JsonDocument.Parse(json);
            if (parsed.RootElement.ValueKind == JsonValueKind.Object)
            {
                document = parsed;
                return true;
            }

            parsed.Dispose();
        }
        catch (JsonException)
        {
            // Not a control frame.
        }

        return false;
    }

    private static string? GetString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? GetInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.Number
        && value.TryGetInt32(out var number)
            ? number
            : null;

    private enum AttachStatus
    {
        Attached,
        Rejected,
        HostOffline,
    }

    private sealed record FirstFrame(
        string Type,
        int? Proto,
        string? Role,
        string? HostId,
        string? Secret,
        string? DeviceToken,
        string? Code,
        string? Share,
        string? Label);

    private sealed record AttachResult(
        AttachStatus Status,
        HostSession? Host = null,
        DeviceRecord? Device = null,
        string? NewToken = null,
        string Via = "owner",
        string? Reason = null)
    {
        public static AttachResult Attached(HostSession host, DeviceRecord device, string? newToken, string via) =>
            new(AttachStatus.Attached, host, device, newToken, via);

        public static AttachResult Rejected(string reason) =>
            new(AttachStatus.Rejected, Reason: reason);

        public static AttachResult HostOffline() => new(AttachStatus.HostOffline);
    }
}
