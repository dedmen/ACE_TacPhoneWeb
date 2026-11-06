using System.Net;
using System.Net.WebSockets;
using System.Text;
using TacPhone.RemoteServer.Infrastructure;
using TacPhone.RemoteServer.Protocol;
using TacPhone.RemoteServer.Storage;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// RelayEndpoint partial: the browser side. Attach resolution (token, pairing
/// code, share link), peer registration and the client receive loop.
/// </summary>
public sealed partial class RelayEndpoint
{
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

            // The one-time code is now spent; clear it from the in-game panel instead
            // of letting it count down a dead code.
            host.Game.TryEnqueueText(ServerFrames.CodeUsed());

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

                // Parse the frame once; the control check and every cache
                // interceptor below read the same document.
                if (AppFrameJson.TryParseObject(frame.Payload, out var document))
                {
                    using (document)
                    {
                        var root = document.RootElement;

                        if (frame.Type == WebSocketMessageType.Text)
                        {
                            var text = Encoding.UTF8.GetString(frame.Payload);

                            // A control frame starts with '{' in the raw text,
                            // exactly as the string parser required before.
                            if (frame.Payload[0] == (byte)'{' &&
                                AppFrameJson.GetString(root, "t") is { Length: > 0 } controlType)
                            {
                                switch (controlType)
                                {
                                    case ControlTypes.Ping:
                                        client.Socket.TryEnqueueText(ServerFrames.Pong());
                                        continue;

                                    case ControlTypes.Pong:
                                        // Keepalive answer from the browser; not application data.
                                        continue;

                                    default:
                                        _logger.LogWarning(
                                            "Browser sent an unknown control frame type '{FrameType}': {Frame}",
                                            controlType,
                                            PreviewFrame(text));
                                        continue;
                                }
                            }
                        }

                        // Browsers send the raw application JSON; text is accepted as well.
                        // Terrain SVGs are cached per host and textures globally: a matching
                        // entry answers the browser directly and never reaches the game.
                        if (TerrainRequest.TryParse(root, out var requestKey, out var configHash))
                        {
                            if (!_terrainCache.Enabled)
                            {
                                _logger.LogInformation(
                                    "Terrain cache miss for host {HostId}: TacPhone:TerrainCache:Enabled is false",
                                    host.HostId);
                            }
                            else
                            {
                                _terrainCache.SweepPending(_options.TerrainCache.PendingTimeout());

                                if (_terrainCache.TryGetPin(host.HostId, configHash, out var pinned))
                                {
                                    if (TerrainRequest.TryBuildLayerFrames(
                                            requestKey, pinned, TerrainRequest.MaxTerrainChunkChars, out var frames))
                                    {
                                        foreach (var cachedFrame in frames)
                                        {
                                            client.Socket.TryEnqueueBinary(cachedFrame);
                                        }
                                    }
                                    else
                                    {
                                        client.Socket.TryEnqueueBinary(TerrainRequest.BuildReply(requestKey, pinned));
                                    }

                                    continue; // instant, no game round-trip
                                }

                                // A reused request key would corrupt an existing correlation;
                                // forward it uncached instead.
                                if (!_textureCache.IsPending(client.PeerId, requestKey) &&
                                    !_terrainCache.IsPending(client.PeerId, requestKey))
                                {
                                    _terrainCache.AddPending(client.PeerId, requestKey, host.HostId, configHash);
                                }
                            }
                        }

                        if (_textureCache.Enabled &&
                            TextureRequest.TryParse(root, out var textureKey, out var textureCacheKey))
                        {
                            _textureCache.SweepPending(_options.TextureCache.PendingTimeout());

                            if (_textureCache.TryGet(textureCacheKey, out var cachedTexture))
                            {
                                client.Socket.TryEnqueueBinary(TextureRequest.BuildReply(textureKey, cachedTexture));
                                continue; // instant, never reaches the game
                            }

                            if (!_terrainCache.IsPending(client.PeerId, textureKey) &&
                                !_textureCache.IsPending(client.PeerId, textureKey))
                            {
                                _textureCache.AddPending(client.PeerId, textureKey, textureCacheKey);
                            }
                        }

                        if (_fileCache.Enabled &&
                            FileRequest.TryParse(root, out var fileKey, out var filePath))
                        {
                            _fileCache.SweepPending(_options.FileCache.PendingTimeout());

                            if (_fileCache.TryGetPinned(host.HostId, filePath, out var cachedFile))
                            {
                                client.Socket.TryEnqueueBinary(FileRequest.BuildReply(fileKey, cachedFile));
                                continue; // instant, never reaches the game
                            }

                            if (!_terrainCache.IsPending(client.PeerId, fileKey) &&
                                !_textureCache.IsPending(client.PeerId, fileKey) &&
                                !_fileCache.IsPending(client.PeerId, fileKey))
                            {
                                _fileCache.AddPending(client.PeerId, fileKey, host.HostId, filePath);
                            }
                        }
                    }
                }

                // The game socket is text only: "<peerId>\n<payload>", which the
                // RelaySocket then wraps as "RELAY:" + base64.
                var forwarded = client.PeerId + "\n" + Encoding.UTF8.GetString(frame.Payload);
                if (!host.Game.TryEnqueueText(forwarded))
                {
                    _logger.LogDebug("The game socket refused a frame; detaching the peer");
                    break;
                }
            }
        }
        finally
        {
            // Pending correlations belong to the browser; cached texture entries do
            // not, so only the pending maps are dropped here.
            _terrainCache.DropPeer(client.PeerId);
            _textureCache.DropPeer(client.PeerId);
            _fileCache.DropPeer(client.PeerId);

            if (host.Clients.TryRemove(client.PeerId, out _))
            {
                host.Game.TryEnqueueText(ServerFrames.PeerLeft(client.PeerId, reason));
            }
        }
    }

    private async Task RejectAsync(RelaySocket socket, string reason)
    {
        socket.TryEnqueueText(ServerFrames.Rejected(reason));
        await socket.CloseAsync(reason).ConfigureAwait(false);
    }
}
