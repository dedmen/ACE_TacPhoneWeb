using Microsoft.Data.Sqlite;

namespace TacPhone.RemoteServer.Storage;

/// <summary>
/// Versioned schema migrations. A migration at index <c>i</c> upgrades the
/// database from version <c>i</c> to <c>i + 1</c>; the applied version is kept in
/// SQLite's <c>PRAGMA user_version</c> and bumped inside the same transaction as
/// the migration statements.
/// </summary>
public static class Schema
{
    /// <summary>Schema version the current code expects.</summary>
    public const int LatestVersion = 1;

    /// <summary>Ordered migrations. Index + 1 is the resulting schema version.</summary>
    public static IReadOnlyList<string> Migrations { get; } = new[]
    {
        MigrationV1,
    };

    private const string MigrationV1 = """
        CREATE TABLE hosts (
          host_id       TEXT PRIMARY KEY,
          secret_hash   BLOB NOT NULL,
          label         TEXT,
          created_utc   INTEGER NOT NULL,
          last_seen_utc INTEGER
        );

        CREATE TABLE devices (
          token_hash    BLOB PRIMARY KEY,
          host_id       TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
          share_id      TEXT,
          label         TEXT,
          expires_utc   INTEGER,
          created_utc   INTEGER NOT NULL,
          last_seen_utc INTEGER
        );
        CREATE INDEX devices_host ON devices(host_id);
        CREATE INDEX devices_share ON devices(share_id);

        CREATE TABLE pair_codes (
          code_hash     BLOB PRIMARY KEY,
          host_id       TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
          expires_utc   INTEGER NOT NULL,
          used_utc      INTEGER
        );
        CREATE INDEX pair_codes_host ON pair_codes(host_id);

        CREATE TABLE shares (
          share_id      TEXT PRIMARY KEY,
          key_hash      BLOB NOT NULL,
          host_id       TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
          created_utc   INTEGER NOT NULL,
          expires_utc   INTEGER NOT NULL,
          revoked_utc   INTEGER
        );
        CREATE INDEX shares_host ON shares(host_id);
        CREATE INDEX shares_key ON shares(key_hash);
        """;

    /// <summary>Reads <c>PRAGMA user_version</c>; 0 for a brand new database.</summary>
    public static int ReadVersion(SqliteConnection connection, SqliteTransaction? transaction = null)
    {
        ArgumentNullException.ThrowIfNull(connection);

        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "PRAGMA user_version;";
        var value = command.ExecuteScalar();
        return value is null or DBNull ? 0 : Convert.ToInt32(value);
    }

    /// <summary>
    /// Sets <c>PRAGMA user_version</c>. Must be called inside the migration's own
    /// transaction so the version bump is atomic with the statements.
    /// </summary>
    public static void WriteVersion(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        int version)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentOutOfRangeException.ThrowIfNegative(version);

        // The version is an int from this assembly, never user input.
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"PRAGMA user_version = {version};";
        command.ExecuteNonQuery();
    }
}
