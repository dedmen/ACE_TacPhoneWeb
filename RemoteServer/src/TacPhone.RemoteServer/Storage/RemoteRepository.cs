using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Storage;

/// <summary>
/// Single-writer data access for the remote server. Every operation takes one
/// process-wide semaphore, opens a short-lived connection, does its work inside
/// a transaction when it spans statements, and closes the connection again.
/// </summary>
public sealed class RemoteRepository
{
    private const string ShareColumns =
        "share_id, key_hash, host_id, created_utc, expires_utc, revoked_utc";

    private const string DeviceColumns =
        "token_hash, host_id, share_id, label, expires_utc, created_utc, last_seen_utc";

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

    // ----------------------------------------------------------- pair codes

    public Task CreatePairCodeAsync(
        string hostId,
        string code,
        long expiresUtc,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(hostId);
        ArgumentException.ThrowIfNullOrWhiteSpace(code);

        var codeHash = Hashing.Sha256(code);

        return RunAsync(async (connection, token) =>
        {
            await using var transaction =
                (SqliteTransaction)await connection.BeginTransactionAsync(token).ConfigureAwait(false);

            await using (var delete = connection.CreateCommand())
            {
                delete.Transaction = transaction;
                delete.CommandText = "DELETE FROM pair_codes WHERE host_id = $host;";
                AddText(delete, "$host", hostId);
                await delete.ExecuteNonQueryAsync(token).ConfigureAwait(false);
            }

            await using (var insert = connection.CreateCommand())
            {
                insert.Transaction = transaction;
                insert.CommandText =
                    """
                    INSERT INTO pair_codes (code_hash, host_id, expires_utc, used_utc)
                    VALUES ($hash, $host, $expires, NULL);
                    """;
                AddBlob(insert, "$hash", codeHash);
                AddText(insert, "$host", hostId);
                AddInt64(insert, "$expires", expiresUtc);
                await insert.ExecuteNonQueryAsync(token).ConfigureAwait(false);
            }

            await transaction.CommitAsync(token).ConfigureAwait(false);
        }, ct);
    }

    public Task<string?> ConsumePairCodeAsync(string code, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(code);

        var codeHash = Hashing.Sha256(code);

        return ExecuteAsync(async (connection, token) =>
        {
            var now = Now();

            await using var transaction =
                (SqliteTransaction)await connection.BeginTransactionAsync(token).ConfigureAwait(false);

            int updated;
            await using (var update = connection.CreateCommand())
            {
                update.Transaction = transaction;
                update.CommandText =
                    """
                    UPDATE pair_codes
                    SET used_utc = $now
                    WHERE code_hash = $hash AND used_utc IS NULL AND expires_utc > $now;
                    """;
                AddInt64(update, "$now", now);
                AddBlob(update, "$hash", codeHash);
                updated = await update.ExecuteNonQueryAsync(token).ConfigureAwait(false);
            }

            if (updated == 0)
            {
                return (string?)null;
            }

            string? hostId;
            await using (var select = connection.CreateCommand())
            {
                select.Transaction = transaction;
                select.CommandText = "SELECT host_id FROM pair_codes WHERE code_hash = $hash LIMIT 1;";
                AddBlob(select, "$hash", codeHash);
                hostId = (string?)await select.ExecuteScalarAsync(token).ConfigureAwait(false);
            }

            await transaction.CommitAsync(token).ConfigureAwait(false);
            return hostId;
        }, ct);
    }

    // --------------------------------------------------------------- shares

    public Task<ShareRecord?> GetActiveShareAsync(string hostId, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(hostId);

        return ExecuteAsync(async (connection, token) =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText =
                $"""
                SELECT {ShareColumns}
                FROM shares
                WHERE host_id = $host AND revoked_utc IS NULL AND expires_utc > $now
                ORDER BY created_utc DESC, rowid DESC
                LIMIT 1;
                """;
            AddText(command, "$host", hostId);
            AddInt64(command, "$now", Now());

            await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
            return await reader.ReadAsync(token).ConfigureAwait(false) ? ReadShare(reader) : null;
        }, ct);
    }

    public Task<ShareRecord?> FindShareByKeyHashAsync(byte[] keyHash, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(keyHash);

        return ExecuteAsync(async (connection, token) =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText =
                $"""
                SELECT {ShareColumns}
                FROM shares
                WHERE key_hash = $hash
                ORDER BY created_utc DESC, rowid DESC
                LIMIT 1;
                """;
            AddBlob(command, "$hash", keyHash);

            await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
            return await reader.ReadAsync(token).ConfigureAwait(false) ? ReadShare(reader) : null;
        }, ct);
    }

    public Task<ShareRecord?> FindShareByIdAsync(string shareId, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(shareId);

        return ExecuteAsync(async (connection, token) =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText = $"SELECT {ShareColumns} FROM shares WHERE share_id = $id LIMIT 1;";
            AddText(command, "$id", shareId);

            await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
            return await reader.ReadAsync(token).ConfigureAwait(false) ? ReadShare(reader) : null;
        }, ct);
    }

    public Task<ShareCreation> CreateShareReplacementAsync(
        string hostId,
        long expiresUtc,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(hostId);

        var shareId = "s_" + CrockfordBase32.Random(CrockfordBase32.HostIdLength);
        var key = CrockfordBase32.Random(CrockfordBase32.ShareKeyLength);
        var keyHash = Hashing.Sha256(key);

        return ExecuteAsync(async (connection, token) =>
        {
            var now = Now();
            var replaced = new List<string>();

            await using var transaction =
                (SqliteTransaction)await connection.BeginTransactionAsync(token).ConfigureAwait(false);

            var existing = await ReadShareIdsAsync(connection, transaction, hostId, token).ConfigureAwait(false);
            replaced.AddRange(existing);

            if (existing.Count > 0)
            {
                await DeleteDevicesForSharesAsync(connection, transaction, existing, token).ConfigureAwait(false);
            }

            await using (var deleteShares = connection.CreateCommand())
            {
                deleteShares.Transaction = transaction;
                deleteShares.CommandText = "DELETE FROM shares WHERE host_id = $host;";
                AddText(deleteShares, "$host", hostId);
                await deleteShares.ExecuteNonQueryAsync(token).ConfigureAwait(false);
            }

            await using (var insert = connection.CreateCommand())
            {
                insert.Transaction = transaction;
                insert.CommandText =
                    """
                    INSERT INTO shares (share_id, key_hash, host_id, created_utc, expires_utc, revoked_utc)
                    VALUES ($id, $hash, $host, $created, $expires, NULL);
                    """;
                AddText(insert, "$id", shareId);
                AddBlob(insert, "$hash", keyHash);
                AddText(insert, "$host", hostId);
                AddInt64(insert, "$created", now);
                AddInt64(insert, "$expires", expiresUtc);
                await insert.ExecuteNonQueryAsync(token).ConfigureAwait(false);
            }

            await transaction.CommitAsync(token).ConfigureAwait(false);

            _logger.LogInformation(
                "Replaced {Replaced} share(s) with a new share (expires {ExpiresUtc}).",
                replaced.Count,
                expiresUtc);

            return new ShareCreation(shareId, key, expiresUtc, replaced);
        }, ct);
    }

    public Task<ShareRevocation> RevokeSharesAsync(string hostId, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(hostId);

        return ExecuteAsync(async (connection, token) =>
        {
            await using var transaction =
                (SqliteTransaction)await connection.BeginTransactionAsync(token).ConfigureAwait(false);

            var revoked = await ReadShareIdsAsync(connection, transaction, hostId, token).ConfigureAwait(false);

            if (revoked.Count > 0)
            {
                await DeleteDevicesForSharesAsync(connection, transaction, revoked, token).ConfigureAwait(false);

                await using var deleteShares = connection.CreateCommand();
                deleteShares.Transaction = transaction;
                deleteShares.CommandText = "DELETE FROM shares WHERE host_id = $host;";
                AddText(deleteShares, "$host", hostId);
                await deleteShares.ExecuteNonQueryAsync(token).ConfigureAwait(false);
            }

            await transaction.CommitAsync(token).ConfigureAwait(false);

            if (revoked.Count > 0)
            {
                _logger.LogInformation("Revoked {Count} share(s).", revoked.Count);
            }

            return new ShareRevocation(revoked);
        }, ct);
    }

    private static async Task<IReadOnlyList<string>> ReadShareIdsAsync(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string hostId,
        CancellationToken ct)
    {
        var ids = new List<string>();

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT share_id FROM shares WHERE host_id = $host;";
        AddText(command, "$host", hostId);

        await using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            ids.Add(reader.GetString(0));
        }

        return ids;
    }

    private static async Task DeleteDevicesForSharesAsync(
        SqliteConnection connection,
        SqliteTransaction transaction,
        IReadOnlyList<string> shareIds,
        CancellationToken ct)
    {
        if (shareIds.Count == 0)
        {
            return;
        }

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"DELETE FROM devices WHERE share_id IN ({BuildInList(command, shareIds, "$share")});";

        await command.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    private static ShareRecord ReadShare(SqliteDataReader reader) => new(
        reader.GetString(0),
        reader.GetFieldValue<byte[]>(1),
        reader.GetString(2),
        reader.GetInt64(3),
        reader.GetInt64(4),
        reader.IsDBNull(5) ? null : reader.GetInt64(5));

    // -------------------------------------------------------------- devices

    public Task<DeviceRecord?> FindDeviceAsync(byte[] tokenHash, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(tokenHash);

        return ExecuteAsync(async (connection, token) =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText = $"SELECT {DeviceColumns} FROM devices WHERE token_hash = $hash LIMIT 1;";
            AddBlob(command, "$hash", tokenHash);

            await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
            return await reader.ReadAsync(token).ConfigureAwait(false) ? ReadDevice(reader) : null;
        }, ct);
    }

    public Task<IssuedDevice> IssueDeviceAsync(
        string hostId,
        string? shareId,
        string? label,
        long? expiresUtc,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(hostId);

        var token = Hashing.NewToken();
        var tokenHash = Hashing.Sha256(token);
        var now = Now();

        return ExecuteAsync(async (connection, ct2) =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText =
                """
                INSERT INTO devices
                    (token_hash, host_id, share_id, label, expires_utc, created_utc, last_seen_utc)
                VALUES ($hash, $host, $share, $label, $expires, $created, $seen);
                """;
            AddBlob(command, "$hash", tokenHash);
            AddText(command, "$host", hostId);
            AddText(command, "$share", shareId);
            AddText(command, "$label", label);
            AddInt64(command, "$expires", expiresUtc);
            AddInt64(command, "$created", now);
            AddInt64(command, "$seen", now);

            await command.ExecuteNonQueryAsync(ct2).ConfigureAwait(false);

            var record = new DeviceRecord(
                tokenHash,
                hostId,
                shareId,
                label,
                expiresUtc,
                now,
                now);

            _logger.LogInformation("Issued {Scope} device.", shareId is null ? "owner" : "share");
            return new IssuedDevice(token, record);
        }, ct);
    }

    public Task TouchDeviceAsync(byte[] tokenHash, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(tokenHash);
        var now = Now();

        return RunAsync(async (connection, token) =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE devices SET last_seen_utc = $now WHERE token_hash = $hash;";
            AddInt64(command, "$now", now);
            AddBlob(command, "$hash", tokenHash);
            await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
        }, ct);
    }

    private static DeviceRecord ReadDevice(SqliteDataReader reader) => new(
        reader.GetFieldValue<byte[]>(0),
        reader.GetString(1),
        reader.IsDBNull(2) ? null : reader.GetString(2),
        reader.IsDBNull(3) ? null : reader.GetString(3),
        reader.IsDBNull(4) ? null : reader.GetInt64(4),
        reader.GetInt64(5),
        reader.IsDBNull(6) ? null : reader.GetInt64(6));

    // ---------------------------------------------------------- maintenance

    public Task<int> DeleteExpiredAsync(CancellationToken ct = default)
    {
        return ExecuteAsync(async (connection, token) =>
        {
            var now = Now();
            var deleted = 0;

            await using var transaction =
                (SqliteTransaction)await connection.BeginTransactionAsync(token).ConfigureAwait(false);

            // 1. devices of expired or revoked shares.
            deleted += await ExecuteDeleteAsync(
                connection,
                transaction,
                """
                DELETE FROM devices
                WHERE share_id IN (
                    SELECT share_id FROM shares WHERE expires_utc <= $now OR revoked_utc IS NOT NULL
                );
                """,
                now,
                token).ConfigureAwait(false);

            // 2. the expired or revoked shares themselves.
            deleted += await ExecuteDeleteAsync(
                connection,
                transaction,
                "DELETE FROM shares WHERE expires_utc <= $now OR revoked_utc IS NOT NULL;",
                now,
                token).ConfigureAwait(false);

            // 3. individually expired devices (permanent owner devices have NULL).
            deleted += await ExecuteDeleteAsync(
                connection,
                transaction,
                "DELETE FROM devices WHERE expires_utc IS NOT NULL AND expires_utc <= $now;",
                now,
                token).ConfigureAwait(false);

            // 4. expired pairing codes.
            deleted += await ExecuteDeleteAsync(
                connection,
                transaction,
                "DELETE FROM pair_codes WHERE expires_utc <= $now;",
                now,
                token).ConfigureAwait(false);

            await transaction.CommitAsync(token).ConfigureAwait(false);

            if (deleted > 0)
            {
                _logger.LogInformation("Deleted {Count} expired row(s).", deleted);
            }

            return deleted;
        }, ct);
    }

    private static async Task<int> ExecuteDeleteAsync(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sql,
        long now,
        CancellationToken ct)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        AddInt64(command, "$now", now);
        return await command.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

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
