using Microsoft.Extensions.Configuration;
using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Tests.Infrastructure;

public sealed class DotEnvTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "tacphone-dotenv-" + Guid.NewGuid().ToString("N"));

    public DotEnvTests()
    {
        Directory.CreateDirectory(_directory);
    }

    public void Dispose()
    {
        try { Directory.Delete(_directory, recursive: true); } catch (IOException) { /* best effort */ }
    }

    [Fact]
    public void LoadsNestedKeysAndNormalisesDoubleUnderscore()
    {
        File.WriteAllText(Path.Combine(_directory, ".env"), """
            # comment
            TacPhone__Port=5080
            TacPhone__BindAddress=127.0.0.1
            TacPhone:Limits:MaxHosts=1234
            TacPhone__PublicBaseUrl="https://tacphone.arma3.io"
            """);

        var configuration = new ConfigurationManager();
        var path = DotEnv.Load(configuration, _directory);

        Assert.NotNull(path);
        Assert.Equal("5080", configuration["TacPhone:Port"]);
        Assert.Equal("127.0.0.1", configuration["TacPhone:BindAddress"]);
        Assert.Equal("1234", configuration["TacPhone:Limits:MaxHosts"]);
        Assert.Equal("https://tacphone.arma3.io", configuration["TacPhone:PublicBaseUrl"]);
    }

    [Fact]
    public void MissingFileIsIgnored()
    {
        var configuration = new ConfigurationManager();
        Assert.Null(DotEnv.Load(configuration, _directory));
        Assert.Null(configuration["TacPhone:Port"]);
    }

    [Fact]
    public void RealEnvironmentVariablesWinOverDotEnv()
    {
        var key = "TACPHONE_TEST_" + Guid.NewGuid().ToString("N");
        Environment.SetEnvironmentVariable(key, "from-environment");

        try
        {
            File.WriteAllText(Path.Combine(_directory, ".env"), $"{key}=from-dotenv\n");

            var configuration = new ConfigurationManager();
            configuration.AddEnvironmentVariables();

            DotEnv.Load(configuration, _directory);

            Assert.Equal("from-environment", configuration[key]);
        }
        finally
        {
            Environment.SetEnvironmentVariable(key, null);
        }
    }
}
