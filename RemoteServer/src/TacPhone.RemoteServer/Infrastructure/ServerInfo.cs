using System.Reflection;

namespace TacPhone.RemoteServer.Infrastructure;

/// <summary>Process identity used by <c>/health</c> and the startup log.</summary>
public sealed class ServerInfo
{
    public ServerInfo(TimeProvider time)
    {
        StartedAt = time.GetUtcNow();
        Version = ResolveVersion();
    }

    public DateTimeOffset StartedAt { get; }

    /// <summary>Informational version without the source-revision suffix.</summary>
    public string Version { get; }

    public long UptimeSeconds(TimeProvider time) =>
        Math.Max(0, (long)(time.GetUtcNow() - StartedAt).TotalSeconds);

    private static string ResolveVersion()
    {
        var assembly = typeof(ServerInfo).Assembly;
        var informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            var plus = informational.IndexOf('+');
            return plus > 0 ? informational[..plus] : informational;
        }

        return assembly.GetName().Version?.ToString(3) ?? "unknown";
    }
}
