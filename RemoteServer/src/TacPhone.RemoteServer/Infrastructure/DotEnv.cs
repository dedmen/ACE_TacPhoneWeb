using Microsoft.Extensions.Configuration;

namespace TacPhone.RemoteServer.Infrastructure;

/// <summary>
/// Optional `.env` support for local runs and simple deployments.
///
/// systemd's <c>EnvironmentFile=</c> is read by systemd, not by this app, so a
/// developer running <c>dotnet run</c> with a `.env` file would otherwise get
/// the defaults from <c>appsettings.json</c>. This loads the file as a
/// configuration source that overrides <c>appsettings.json</c> but never wins
/// over a real environment variable.
///
/// Syntax: <c>KEY=VALUE</c> per line, <c>#</c> comments, optional matching
/// quotes. Both <c>__</c> and <c>:</c> are accepted as section separators, so
/// <c>TacPhone__Port=5080</c> and <c>TacPhone:Port=5080</c> are equivalent.
/// </summary>
public static class DotEnv
{
    private const string FileName = ".env";

    /// <summary>
    /// Loads the first `.env` found in <paramref name="contentRootPath"/> or the
    /// current directory. Returns the path that was loaded, or <c>null</c>.
    /// </summary>
    public static string? Load(IConfigurationBuilder configuration, string contentRootPath)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        var candidates = new List<string>(3);
        if (!string.IsNullOrWhiteSpace(contentRootPath))
        {
            candidates.Add(Path.Combine(contentRootPath, FileName));

            // `dotnet run --project src/TacPhone.RemoteServer` sets the content
            // root to the project directory, while users naturally drop `.env`
            // next to the solution. Walk up a few levels and use the solution
            // root, never an arbitrary parent (e.g. /opt in production).
            var ancestor = new DirectoryInfo(contentRootPath);
            for (var depth = 0; depth < 4 && ancestor is not null; depth++)
            {
                ancestor = ancestor.Parent;
                if (ancestor is null)
                    break;

                if (File.Exists(Path.Combine(ancestor.FullName, "TacPhone.RemoteServer.slnx")))
                {
                    candidates.Add(Path.Combine(ancestor.FullName, FileName));
                    break;
                }
            }
        }

        var current = Directory.GetCurrentDirectory();
        if (!string.IsNullOrWhiteSpace(current))
            candidates.Add(Path.Combine(current, FileName));

        var path = candidates
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(File.Exists);

        if (path is null)
            return null;

        var values = Parse(path);

        // A real environment variable always wins, even though this source is
        // added after the appsettings sources. `TacPhone:Port` is set as
        // `TacPhone__Port` in the environment.
        foreach (var key in values.Keys.ToList())
        {
            if (Environment.GetEnvironmentVariable(key) is not null
                || Environment.GetEnvironmentVariable(key.Replace(":", "__", StringComparison.Ordinal)) is not null)
            {
                values.Remove(key);
            }
        }

        if (values.Count > 0)
            configuration.AddInMemoryCollection(values);

        return path;
    }

    private static Dictionary<string, string?> Parse(string path)
    {
        var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);

        foreach (var rawLine in File.ReadLines(path))
        {
            var line = rawLine.Trim().TrimStart('\uFEFF');
            if (line.Length == 0 || line[0] == '#')
                continue;

            var separator = line.IndexOf('=');
            if (separator <= 0)
                continue;

            var key = line[..separator].Trim();
            if (key.Length == 0)
                continue;

            // Match environment-variable syntax used by the rest of the app.
            key = key.Replace("__", ":", StringComparison.Ordinal);

            var value = line[(separator + 1)..].Trim();
            if (value.Length >= 2
                && ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\'')))
            {
                value = value[1..^1];
            }

            values[key] = value;
        }

        return values;
    }
}
