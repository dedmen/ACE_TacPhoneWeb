using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using TacPhone.RemoteServer.Infrastructure;
using TacPhone.RemoteServer.Protocol;
using TacPhone.RemoteServer.Storage;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// RelayEndpoint partial: the game side. Authentication, host registration and
/// the <c>webRequest</c> read loop that turns control frames into relay actions.
/// </summary>
public sealed partial class RelayEndpoint
{
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
            if (!string.IsNullOrEmpty(auth.HostId))
            {
                _logger.LogWarning(
                    "A game connection presented an unknown or invalid host identity; issued a new identity");
            }
            else
            {
                _logger.LogInformation("Issued a new host identity");
            }
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

                if (frame.Type == WebSocketMessageType.Binary)
                {
                    // The native SQF client is text only. A binary frame is a
                    // protocol violation from a stale client.
                    _logger.LogWarning("Closing a game socket after a binary frame (text only)");
                    session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.BadFrame, "the game socket is text only"));
                    break;
                }

                try
                {
                    await HandleGameTextAsync(session, Encoding.UTF8.GetString(frame.Payload), cancellationToken)
                        .ConfigureAwait(false);
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
                _fileCache.UnpinHost(hostId);
                _logger.LogInformation("Game host disconnected");
                await CloseHostClientsAsync(session, RejectionReasons.HostStop).ConfigureAwait(false);
            }
        }
    }

    private async Task HandleGameTextAsync(HostSession session, string text, CancellationToken cancellationToken)
    {
        // Inbound game text is control JSON only; application data arrives in a
        // "send" control frame.
        if (!AppFrameJson.TryParseObject(text, out var document))
        {
            session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.BadFrame, "expected a control frame"));
            return;
        }

        using (document)
        {
            var root = document.RootElement;
            var type = AppFrameJson.GetString(root, "t");

            switch (type)
            {
                case ControlTypes.Auth:
                    // The first auth frame already authenticated this socket.
                    // Arma's webRequest can invoke onWebsocketEstablished more
                    // than once, which makes the SQF client send a duplicate
                    // auth; ignore it instead of reporting an unknown frame.
                    return;

                case ControlTypes.Ping:
                    session.Game.TryEnqueueText(ServerFrames.Pong());
                    return;

                case ControlTypes.Pong:
                    // Keepalive answer from the game; activity is already recorded.
                    return;

                case ControlTypes.Send:
                    HandleSend(session, root);
                    return;

                case ControlTypes.CodeNew:
                    await HandleCodeNewAsync(session, cancellationToken).ConfigureAwait(false);
                    return;

                case ControlTypes.ShareCreate:
                    await HandleShareCreateAsync(session, AppFrameJson.GetInt(root, "ttlSeconds"), cancellationToken).ConfigureAwait(false);
                    return;

                case ControlTypes.ShareRevoke:
                    await HandleShareRevokeAsync(session, cancellationToken).ConfigureAwait(false);
                    return;

                case ControlTypes.Kick:
                    await HandleKickAsync(session, AppFrameJson.GetString(root, "peerId"), cancellationToken).ConfigureAwait(false);
                    return;

                case ControlTypes.Files:
                    if (ParseFileManifest(root) is { } files)
                    {
                        _fileCache.ObserveManifest(session.HostId, files);
                    }

                    return;

                default:
                {
                    _logger.LogWarning(
                        "Game sent an unknown control frame type '{FrameType}': {Frame}",
                        type ?? "(none)",
                        PreviewFrame(text));

                    session.Game.TryEnqueueText(ServerFrames.Error(
                        ErrorCodes.Proto,
                        $"unknown control frame: {type ?? "(none)"} — {PreviewFrame(text, 200)}"));
                    return;
                }
            }
        }
    }

    /// <summary>Handles the game's <c>send</c> frame: expand, dedupe, route, reply.</summary>
    private void HandleSend(HostSession session, JsonElement root)
    {
        if (!TryGetStringArray(root, "targets", out var requested))
        {
            session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.BadFrame, "send needs a 'targets' array of peer ids"));
            return;
        }

        if (!root.TryGetProperty("data", out var dataElement) || dataElement.ValueKind != JsonValueKind.String)
        {
            session.Game.TryEnqueueText(ServerFrames.Error(ErrorCodes.BadFrame, "send needs a string 'data' payload"));
            return;
        }

        var data = dataElement.GetString() ?? string.Empty;
        var plan = RelaySendPlan.Expand(requested, session.Clients.Keys);
        var payload = Encoding.UTF8.GetBytes(data);

        var delivered = 0;
        foreach (var target in plan.Targets)
        {
            // Every target goes through the same cache-aware path a browser frame
            // would, so terrain/texture/file caching keeps working.
            if (ForwardToClient(session, target, payload))
            {
                delivered++;
            }
        }

        session.Game.TryEnqueueText(ServerFrames.SendResult(plan.Requested, delivered, plan.Unknown));
    }

    private bool ForwardToClient(HostSession session, string peerId, ReadOnlyMemory<byte> payload)
    {
        if (!session.Clients.TryGetValue(peerId, out var client))
        {
            // Unknown peers are dropped: the browser may have just closed. Nothing
            // is cached for a peer that is no longer there.
            _logger.LogDebug("Dropping an application frame for an unknown peer");
            return false;
        }

        // Terrain replies are large; only look inside a frame while a forwarded
        // request is actually outstanding. Routing is by frame shape so the
        // legacy terrain parser never consumes a texture reply.
        if (_terrainCache.Enabled &&
            _terrainCache.HasPending &&
            TerrainRequest.TryReadChunk(payload.Span, out var chunkKey, out var chunk))
        {
            var result = _terrainCache.TryAddChunk(
                peerId, chunkKey, chunk, out var completed, out var hostId, out var configHash);

            switch (result)
            {
                case ChunkResult.Buffered:
                    // Part of a transfer: hold it until every layer part arrived.
                    return true;

                case ChunkResult.Completed when completed is not null:
                {
                    var contentHash = TerrainCache.ComputeContentHash(completed.Data);
                    _terrainCache.Pin(hostId, configHash, contentHash, completed.Data);

                    foreach (var frame in TerrainRequest.BuildLayerFrames(
                                 chunkKey, completed, TerrainRequest.MaxTerrainChunkChars))
                    {
                        client.Socket.TryEnqueueBinary(frame);
                    }

                    return true;
                }

                case ChunkResult.Completed:
                    return true;

                default:
                    // Not pending, an error chunk or an inconsistent transfer:
                    // forward the frame untouched (and never cache it).
                    break;
            }
        }

        if (_textureCache.Enabled &&
            _textureCache.HasPending &&
            TextureRequest.TryReadReply(payload.Span, out var textureKey, out var textureData) &&
            _textureCache.TakePending(peerId, textureKey, out var textureCacheKey))
        {
            if (!string.IsNullOrEmpty(textureData))
            {
                _textureCache.Store(textureCacheKey, textureData);
            }
        }
        else if (_terrainCache.Enabled &&
                 _terrainCache.HasPending &&
                 TerrainRequest.TryReadReply(payload.Span, out var replyKey, out var terrainData) &&
                 _terrainCache.TakePending(peerId, replyKey, out var terrainHostId, out var terrainConfigHash) &&
                 !string.IsNullOrEmpty(terrainData))
        {
            var contentHash = TerrainCache.ComputeContentHash(terrainData);
            _terrainCache.Pin(terrainHostId, terrainConfigHash, contentHash, terrainData);
        }

        if (_fileCache.Enabled &&
            _fileCache.HasPending &&
            FileRequest.TryReadReply(payload.Span, out var fileKey, out var fileData) &&
            _fileCache.TakePending(peerId, fileKey, out var fileHostId, out var filePath))
        {
            if (!string.IsNullOrEmpty(fileData))
            {
                _fileCache.TryGetExpected(fileHostId, filePath, out var manifestHash);
                _fileCache.Store(fileHostId, filePath, fileData, manifestHash);
            }
        }

        // A full queue aborts the peer; its receive loop then detaches it.
        return client.Socket.TryEnqueueBinary(payload);
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

    private int ClampShareTtl(int? requestedTtlSeconds)
    {
        var ttl = requestedTtlSeconds is null or <= 0 ? 3600 : requestedTtlSeconds.Value;
        return Math.Clamp(ttl, 60, _options.Limits.MaxShareTtlSeconds);
    }
}
