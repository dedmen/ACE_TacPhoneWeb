using Microsoft.Data.Sqlite;
using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Storage;

public sealed partial class RemoteRepository
{
    private const string ShareColumns =
        "share_id, key_hash, host_id, created_utc, expires_utc, revoked_utc";

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
}
