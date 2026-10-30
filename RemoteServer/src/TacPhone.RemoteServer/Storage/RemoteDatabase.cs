using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace TacPhone.RemoteServer.Storage;

/// <summary>
/// Owns the SQLite file: resolves its absolute path, applies per-connection
/// PRAGMAs, switches the database to WAL and runs pending schema migrations.
/// Connections are short-lived and pooled unless <c>pooling</c> is disabled.
/// </summary>
public sealed class RemoteDatabase
{
    private readonly ILogger<RemoteDatabase> _logger;
    private readonly string _connectionString;

    public RemoteDatabase(string path, ILogger<RemoteDatabase> logger, bool pooling = true)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        Path = System.IO.Path.GetFullPath(path);
        var directory = System.IO.Path.GetDirectoryName(Path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            Pooling = pooling,
        }.ToString();
    }

    /// <summary>Fully resolved absolute path of the database file.</summary>
    public string Path { get; }

    /// <summary>
    /// Creates the data directory (already done in the constructor), enables WAL
    /// and applies every pending migration. Safe to call on an empty directory.
    /// </summary>
    public async Task InitializeAsync(CancellationToken ct = default)
    {
        await using var connection = await OpenAsync(ct).ConfigureAwait(false);

        await using (var wal = connection.CreateCommand())
        {
            wal.CommandText = "PRAGMA journal_mode=WAL;";
            await wal.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }

        var applied = Schema.ReadVersion(connection);
        if (applied > Schema.LatestVersion)
        {
            throw new InvalidOperationException(
                $"Database schema version {applied} is newer than the supported version {Schema.LatestVersion}.");
        }

        for (var version = applied; version < Schema.LatestVersion; version++)
        {
            var migration = Schema.Migrations[version];
            await using var transaction =
                (SqliteTransaction)await connection.BeginTransactionAsync(ct).ConfigureAwait(false);

            await using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = migration;
                await command.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }

            Schema.WriteVersion(connection, transaction, version + 1);

            await transaction.CommitAsync(ct).ConfigureAwait(false);
            _logger.LogInformation("Applied database migration {Version}.", version + 1);
        }

        _logger.LogInformation(
            "SQLite database ready at {Path} (schema version {Version}).",
            Path,
            Schema.LatestVersion);
    }

    /// <summary>Opens a connection and applies the per-connection PRAGMAs.</summary>
    public async Task<SqliteConnection> OpenAsync(CancellationToken ct = default)
    {
        var connection = new SqliteConnection(_connectionString);
        try
        {
            await connection.OpenAsync(ct).ConfigureAwait(false);

            await using var command = connection.CreateCommand();
            command.CommandText =
                "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;";
            await command.ExecuteNonQueryAsync(ct).ConfigureAwait(false);

            return connection;
        }
        catch
        {
            await connection.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }
}
