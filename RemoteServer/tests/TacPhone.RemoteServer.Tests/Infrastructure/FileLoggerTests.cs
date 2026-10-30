using Microsoft.Extensions.Logging;
using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Tests.Infrastructure;

public sealed class FileLoggerTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "tacphone-log-" + Guid.NewGuid().ToString("N"));

    public FileLoggerTests()
    {
        Directory.CreateDirectory(_directory);
    }

    public void Dispose()
    {
        try { Directory.Delete(_directory, recursive: true); } catch (IOException) { /* best effort */ }
    }

    private string LogPath => Path.Combine(_directory, "relay.log");

    [Fact]
    public void WritesLevelCategoryAndMessage()
    {
        using (var provider = new FileLoggerProvider(new FileLoggerOptions
        {
            Path = LogPath,
            MinLevel = LogLevel.Information,
            MaxBytes = 0,
        }))
        {
            provider.CreateLogger("TacPhone.Test").LogInformation("relay started");
        }

        var text = File.ReadAllText(LogPath);
        Assert.Contains("[Information]", text);
        Assert.Contains("TacPhone.Test", text);
        Assert.Contains("relay started", text);
    }

    [Fact]
    public void FiltersBelowMinimumLevel()
    {
        using (var provider = new FileLoggerProvider(new FileLoggerOptions
        {
            Path = LogPath,
            MinLevel = LogLevel.Warning,
            MaxBytes = 0,
        }))
        {
            var logger = provider.CreateLogger("TacPhone.Test");
            logger.LogInformation("hidden");
            logger.LogError("visible");
        }

        var text = File.ReadAllText(LogPath);
        Assert.DoesNotContain("hidden", text);
        Assert.Contains("visible", text);
    }

    [Fact]
    public void RollsAndKeepsConfiguredNumberOfFiles()
    {
        using (var provider = new FileLoggerProvider(new FileLoggerOptions
        {
            Path = LogPath,
            MinLevel = LogLevel.Information,
            MaxBytes = 200,
            KeepFiles = 3,
        }))
        {
            var logger = provider.CreateLogger("TacPhone.Test");
            for (var i = 0; i < 20; i++)
                logger.LogInformation("line {Index} with enough text to force rotation", i);
        }

        Assert.True(File.Exists(LogPath));
        Assert.True(File.Exists(LogPath + ".1"));
        Assert.False(File.Exists(LogPath + ".3"));
        Assert.All(
            Directory.GetFiles(_directory),
            path => Assert.True(new FileInfo(path).Length <= 400, $"{path} was not rotated"));
    }

    [Fact]
    public void UnwritablePathDoesNotThrow()
    {
        // A file used as a directory component makes CreateDirectory fail.
        File.WriteAllText(LogPath, "not a directory");

        using var logger = new FileLoggerProvider(new FileLoggerOptions
        {
            Path = Path.Combine(LogPath, "nested", "relay.log"),
            MaxBytes = 0,
        });

        var exception = Record.Exception(() =>
            logger.CreateLogger("TacPhone.Test").LogInformation("must not throw"));
        Assert.Null(exception);
    }
}
