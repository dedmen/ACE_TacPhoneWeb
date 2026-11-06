using TacPhone.RemoteServer.Protocol;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// RelayEndpoint partial: periodic housekeeping. Keepalive pings, idle timeouts,
/// expired share eviction, database cleanup and the shutdown drain.
/// </summary>
public sealed partial class RelayEndpoint
{
    private static readonly TimeSpan KeepAliveInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan CleanupInterval = TimeSpan.FromSeconds(60);

    private static readonly string PingFrame = ServerFrames.Ping();

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

        // Abandoned transfers expire even when no new request arrives.
        _terrainCache.SweepPending(_options.TerrainCache.PendingTimeout());
        _textureCache.SweepPending(_options.TextureCache.PendingTimeout());
        _fileCache.SweepPending(_options.FileCache.PendingTimeout());

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
}
