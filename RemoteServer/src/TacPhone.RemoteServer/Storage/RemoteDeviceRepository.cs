using Microsoft.Data.Sqlite;
using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Storage;

public sealed partial class RemoteRepository
{
    private const string DeviceColumns =
        "token_hash, host_id, share_id, label, expires_utc, created_utc, last_seen_utc";

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
}
