using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using TacPhone.RemoteServer.Storage;

namespace TacPhone.RemoteServer.Tests.Storage;

/// <summary>
/// One throwaway SQLite database per test. Pooling is disabled so the file (and
/// its WAL sidecars) can be deleted again on dispose.
/// </summary>
public sealed class TempDatabase : IAsyncDisposable
{
    private readonly string _directory;
    private bool _disposed;

    private TempDatabase(string directory, TestClock clock)
    {
        _directory = directory;
        Clock = clock;

        Database = new RemoteDatabase(
            Path.Combine(directory, "remote.db"),
            NullLogger<RemoteDatabase>.Instance,
            pooling: false);

        Repository = new RemoteRepository(
            Database,
            clock,
            NullLogger<RemoteRepository>.Instance);
    }

    public TestClock Clock { get; }

    public RemoteDatabase Database { get; }

    public RemoteRepository Repository { get; }

    public string DirectoryPath => _directory;

    public string DatabasePath => Database.Path;

    public static async Task<TempDatabase> CreateAsync(TestClock? clock = null)
    {
        var directory = Path.Combine(
            Path.GetTempPath(),
            "tacphone-remote-tests",
            Guid.NewGuid().ToString("N"));

        var temp = new TempDatabase(directory, clock ?? TestClock.Create());
        await temp.Database.InitializeAsync();
        return temp;
    }

    /// <summary>Authenticates a brand new host and returns its id and secret.</summary>
    public async Task<(string HostId, string Secret)> CreateHostAsync(string label = "test host")
    {
        var result = await Repository.AuthenticateHostAsync(null, null, label);
        Assert.NotNull(result.IssuedSecret);
        return (result.HostId, result.IssuedSecret!);
    }

    /// <summary>
    /// All bytes of the database file plus its WAL sidecar, decoded as Latin1 so
    /// a plaintext secret would show up verbatim.
    /// </summary>
    public string RawText()
    {
        var builder = new StringBuilder();
        foreach (var path in new[] { Database.Path, Database.Path + "-wal" })
        {
            if (!File.Exists(path))
            {
                continue;
            }

            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            builder.Append(Encoding.Latin1.GetString(memory.ToArray()));
        }

        return builder.ToString();
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                if (Directory.Exists(_directory))
                {
                    Directory.Delete(_directory, recursive: true);
                }

                return;
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
