using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Storage;

/// <summary>
/// Single-writer data access for the remote server. Every operation takes one
/// process-wide semaphore, opens a short-lived connection, does its work inside
/// a transaction when it spans statements, and closes the connection again.
/// </summary>
public sealed partial class RemoteRepository
{
    private const string HostColumns =
        "host_id, secret_hash, label, created_utc, last_seen_utc";

    private readonly RemoteDatabase _database;
    private readonly TimeProvider _time;
    private readonly ILogger<RemoteRepository> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public RemoteRepository(RemoteDatabase database, TimeProvider time, ILogger<RemoteRepository> logger)
    {
        _database = database ?? throw new ArgumentNullException(nameof(database));
        _time = time ?? throw new ArgumentNullException(nameof(time));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    private long Now() => _time.GetUtcNow().ToUnixTimeSeconds();

    // ---------------------------------------------------------------- hosts

    /// <summary>
    /// Validates a host id + secret. Unknown hosts and bad secrets never throw:
    /// they get a brand new identity (the documented recovery path when the
    /// database was reset).
    /// </summary>
    public Task<HostAuthResult> AuthenticateHostAsync(
        string? hostId,
        string? secret,
        string? label,
        CancellationToken ct = default) =>
        ExecuteAsync(async (connection, token) =>
        {
            var now = Now();

            if (!string.IsNullOrWhiteSpace(hostId) && !string.IsNullOrEmpty(secret))
            {
                var existing = await ReadHostAsync(connection, hostId, token).ConfigureAwait(false);
                if (existing is not null
                    && Hashing.FixedTimeEquals(existing.SecretHash, Hashing.Sha256(secret)))
                {
                    await UpdateHostSeenAsync(connection, hostId, label, now, token).ConfigureAwait(false);
                    return new HostAuthResult(hostId, null);
                }
            }

            return await CreateHostAsync(connection, label, now, token).ConfigureAwait(false);
        }, ct);

    public Task TouchHostAsync(string hostId, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(hostId);
        var now = Now();

        return RunAsync(async (connection, token) =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE hosts SET last_seen_utc = $now WHERE host_id = $host;";
            AddInt64(command, "$now", now);
            AddText(command, "$host", hostId);
            await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
        }, ct);
    }

    private async Task<HostAuthResult> CreateHostAsync(
        SqliteConnection connection,
        string? label,
        long now,
        CancellationToken ct)
    {
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var hostId = CrockfordBase32.Random(CrockfordBase32.HostIdLength);
            var secret = Hashing.NewToken();

            await using var command = connection.CreateCommand();
            command.CommandText =
                """
                INSERT INTO hosts (host_id, secret_hash, label, created_utc, last_seen_utc)
                VALUES ($host, $hash, $label, $created, $seen)
                ON CONFLICT(host_id) DO NOTHING;
                """;
            AddText(command, "$host", hostId);
            AddBlob(command, "$hash", Hashing.Sha256(secret));
            AddText(command, "$label", label);
            AddInt64(command, "$created", now);
            AddInt64(command, "$seen", now);

            if (await command.ExecuteNonQueryAsync(ct).ConfigureAwait(false) == 1)
            {
                _logger.LogInformation("Issued a new host identity.");
                return new HostAuthResult(hostId, secret);
            }
        }

        throw new InvalidOperationException("Could not allocate a unique host id.");
    }

    private static async Task<HostRecord?> ReadHostAsync(
        SqliteConnection connection,
        string hostId,
        CancellationToken ct)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT {HostColumns} FROM hosts WHERE host_id = $host LIMIT 1;";
        AddText(command, "$host", hostId);

        await using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
        return await reader.ReadAsync(ct).ConfigureAwait(false) ? ReadHost(reader) : null;
    }

    private static async Task UpdateHostSeenAsync(
        SqliteConnection connection,
        string hostId,
        string? label,
        long now,
        CancellationToken ct)
    {
        await using var command = connection.CreateCommand();
        command.CommandText =
            """
            UPDATE hosts
            SET last_seen_utc = $now,
                label = CASE WHEN $label IS NULL OR $label = '' THEN label ELSE $label END
            WHERE host_id = $host;
            """;
        AddInt64(command, "$now", now);
        AddText(command, "$label", label);
        AddText(command, "$host", hostId);
        await command.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    private static HostRecord ReadHost(SqliteDataReader reader) => new(
        reader.GetString(0),
        reader.GetFieldValue<byte[]>(1),
        reader.IsDBNull(2) ? null : reader.GetString(2),
        reader.GetInt64(3),
        reader.IsDBNull(4) ? null : reader.GetInt64(4));

    // ------------------------------------------------------------- plumbing

    private async Task<T> ExecuteAsync<T>(
        Func<SqliteConnection, CancellationToken, Task<T>> work,
        CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await using var connection = await _database.OpenAsync(ct).ConfigureAwait(false);
            return await work(connection, ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    private Task RunAsync(Func<SqliteConnection, CancellationToken, Task> work, CancellationToken ct) =>
        ExecuteAsync(async (connection, token) =>
        {
            await work(connection, token).ConfigureAwait(false);
            return true;
        }, ct);

    /// <summary>Adds one text parameter per value and returns the placeholder list.</summary>
    private static string BuildInList(SqliteCommand command, IReadOnlyList<string> values, string prefix)
    {
        var names = new string[values.Count];
        for (var i = 0; i < values.Count; i++)
        {
            names[i] = prefix + i;
            AddText(command, names[i], values[i]);
        }

        return string.Join(", ", names);
    }

    private static void AddText(SqliteCommand command, string name, string? value) =>
        command.Parameters.Add(name, SqliteType.Text).Value = value is null ? DBNull.Value : value;

    private static void AddInt64(SqliteCommand command, string name, long? value) =>
        command.Parameters.Add(name, SqliteType.Integer).Value = value.HasValue ? value.Value : DBNull.Value;

    private static void AddBlob(SqliteCommand command, string name, byte[] value) =>
        command.Parameters.Add(name, SqliteType.Blob).Value = value;
}
