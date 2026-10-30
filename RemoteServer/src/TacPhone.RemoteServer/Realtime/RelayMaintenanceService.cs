namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// Drives keepalives, idle timeouts, share expiry and database cleanup, and
/// closes every socket on shutdown.
/// </summary>
public sealed class RelayMaintenanceService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);

    private readonly RelayEndpoint _endpoint;
    private readonly ILogger<RelayMaintenanceService> _logger;

    public RelayMaintenanceService(RelayEndpoint endpoint, ILogger<RelayMaintenanceService> logger)
    {
        _endpoint = endpoint ?? throw new ArgumentNullException(nameof(endpoint));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);

        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                try
                {
                    await _endpoint.MaintenanceAsync(stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Relay maintenance tick failed");
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _endpoint.ShutdownAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Relay shutdown did not complete cleanly");
        }

        await base.StopAsync(cancellationToken).ConfigureAwait(false);
    }
}
