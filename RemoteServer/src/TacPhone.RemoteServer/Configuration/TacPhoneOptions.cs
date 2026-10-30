namespace TacPhone.RemoteServer.Configuration;

/// <summary>
/// Bound from the <c>TacPhone</c> configuration section. Every key can be
/// overridden with an environment variable using the <c>__</c> separator, e.g.
/// <c>TacPhone__Port=5080</c> or <c>TacPhone__Limits__MaxClientsPerHost=32</c>.
/// </summary>
public sealed class TacPhoneOptions
{
    public const string SectionName = "TacPhone";

    /// <summary>Interface Kestrel binds to. Loopback by default: nginx terminates TLS.</summary>
    public string BindAddress { get; set; } = "127.0.0.1";

    /// <summary>Port for the plain-HTTP listener.</summary>
    public int Port { get; set; } = 443;

    /// <summary>SQLite file. Relative paths are resolved against the content root.</summary>
    public string DatabasePath { get; set; } = "data/tacphone-remote.db";

    /// <summary>
    /// Optional absolute public URL (e.g. <c>https://tacphone.arma3.io</c>) used to
    /// build share links. When empty the URL is derived from the Host and
    /// X-Forwarded-Proto headers of the game connection.
    /// </summary>
    public string PublicBaseUrl { get; set; } = string.Empty;

    /// <summary>
    /// Rolling log file, relative to the content root unless absolute. Leave
    /// empty to disable file logging (console/journald only).
    /// </summary>
    public string LogFile { get; set; } = "logs/tacphone-remote.log";

    /// <summary>Minimum level written to <see cref="LogFile"/>.</summary>
    public LogLevel LogFileMinLevel { get; set; } = LogLevel.Information;

    /// <summary>Rotate the log file when it would exceed this size. 0 disables rotation.</summary>
    public long LogFileMaxBytes { get; set; } = 10L * 1024 * 1024;

    /// <summary>How many rotated log files to keep.</summary>
    public int LogFileKeep { get; set; } = 5;

    /// <summary>
    /// Proxies whose <c>X-Forwarded-For</c>/<c>X-Forwarded-Proto</c> headers are
    /// trusted. Single IPs or CIDR ranges.
    /// </summary>
    public string[] TrustedProxies { get; set; } = ["127.0.0.1", "::1"];

    public LimitsOptions Limits { get; set; } = new();

    /// <summary>In-memory cache for the game's RequestTerrainSVG replies.</summary>
    public TerrainCacheOptions TerrainCache { get; set; } = new();

    /// <summary>The URL passed to <c>UseUrls</c>.</summary>
    public string ListenUrl() => $"http://{FormattedBindAddress()}:{Port}";

    /// <summary>Absolute database path for the given content root.</summary>
    public string ResolveDatabasePath(string contentRootPath)
    {
        ArgumentException.ThrowIfNullOrEmpty(contentRootPath);
        var path = string.IsNullOrWhiteSpace(DatabasePath) ? "data/tacphone-remote.db" : DatabasePath.Trim();
        return Path.IsPathRooted(path) ? Path.GetFullPath(path) : Path.GetFullPath(Path.Combine(contentRootPath, path));
    }

    /// <summary>Absolute log file path for the given content root; empty disables file logging.</summary>
    public string ResolveLogFilePath(string contentRootPath)
    {
        if (string.IsNullOrWhiteSpace(LogFile))
            return string.Empty;

        ArgumentException.ThrowIfNullOrEmpty(contentRootPath);
        var path = LogFile.Trim();
        return Path.IsPathRooted(path) ? Path.GetFullPath(path) : Path.GetFullPath(Path.Combine(contentRootPath, path));
    }

    /// <summary>
    /// Base URL for <c>#s=</c> share links, without a trailing slash.
    /// </summary>
    public string ResolveShareBaseUrl(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (!string.IsNullOrWhiteSpace(PublicBaseUrl))
        {
            return PublicBaseUrl.Trim().TrimEnd('/');
        }

        var proto = request.Headers["X-Forwarded-Proto"].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(proto))
        {
            proto = request.Scheme;
        }

        var host = request.Host.HasValue ? request.Host.Value : "localhost";
        return $"{proto}://{host}";
    }

    /// <summary>Fails fast on values that cannot work.</summary>
    public void EnsureValid()
    {
        var problems = new List<string>();

        if (Port is < 1 or > 65535)
        {
            problems.Add($"TacPhone:Port must be 1..65535 (got {Port}).");
        }

        if (string.IsNullOrWhiteSpace(BindAddress))
        {
            problems.Add("TacPhone:BindAddress must not be empty.");
        }

        if (Limits.MaxFrameBytes < 1024)
        {
            problems.Add("TacPhone:Limits:MaxFrameBytes must be at least 1024.");
        }

        if (Limits.MaxClientsPerHost < 1)
        {
            problems.Add("TacPhone:Limits:MaxClientsPerHost must be at least 1.");
        }

        if (Limits.MaxHosts < 1)
        {
            problems.Add("TacPhone:Limits:MaxHosts must be at least 1.");
        }

        if (Limits.PairCodeTtlSeconds < 1)
        {
            problems.Add("TacPhone:Limits:PairCodeTtlSeconds must be at least 1.");
        }

        if (Limits.MaxShareTtlSeconds < 60)
        {
            problems.Add("TacPhone:Limits:MaxShareTtlSeconds must be at least 60.");
        }

        if (Limits.IdleTimeoutSeconds < 1)
        {
            problems.Add("TacPhone:Limits:IdleTimeoutSeconds must be at least 1.");
        }

        if (TerrainCache.MaxTotalBytes < 0)
        {
            problems.Add("TacPhone:TerrainCache:MaxTotalBytes must not be negative.");
        }

        if (TerrainCache.PendingTimeoutSeconds < 1)
        {
            problems.Add("TacPhone:TerrainCache:PendingTimeoutSeconds must be at least 1.");
        }

        if (LogFileMaxBytes < 0)
        {
            problems.Add("TacPhone:LogFileMaxBytes must not be negative.");
        }

        if (LogFileKeep < 1)
        {
            problems.Add("TacPhone:LogFileKeep must be at least 1.");
        }

        if (problems.Count > 0)
        {
            throw new InvalidOperationException("Invalid configuration:" + Environment.NewLine + string.Join(Environment.NewLine, problems));
        }
    }

    /// <summary>One-line configuration summary for the startup log (contains no secrets).</summary>
    public string Describe() =>
        $"bind={ListenUrl()} db={DatabasePath} log={(string.IsNullOrWhiteSpace(LogFile) ? "(disabled)" : LogFile)} " +
        $"publicBaseUrl={(string.IsNullOrWhiteSpace(PublicBaseUrl) ? "(derived)" : PublicBaseUrl)} " +
        $"maxFrameBytes={Limits.MaxFrameBytes} maxClientsPerHost={Limits.MaxClientsPerHost} maxHosts={Limits.MaxHosts} " +
        $"pairCodeTtl={Limits.PairCodeTtlSeconds}s maxShareTtl={Limits.MaxShareTtlSeconds}s idleTimeout={Limits.IdleTimeoutSeconds}s " +
        $"terrainCache={(TerrainCache.Enabled ? "on" : "off")} " +
        $"terrainCacheMaxBytes={TerrainCache.MaxTotalBytes} terrainCachePendingTimeout={TerrainCache.PendingTimeoutSeconds}s";

    private string FormattedBindAddress()
    {
        var address = BindAddress.Trim();
        if (address is "*" or "+" or "0.0.0.0" or "::")
        {
            return address;
        }

        // IPv6 literals must be bracketed inside a URL authority.
        return address.Contains(':') && !address.StartsWith('[') ? $"[{address}]" : address;
    }
}

/// <summary>Limits section. Defaults match the plan.</summary>
public sealed class LimitsOptions
{
    public long MaxFrameBytes { get; set; } = 32L * 1024 * 1024;

    public int MaxClientsPerHost { get; set; } = 64;

    public int MaxHosts { get; set; } = 5000;

    public int PairCodeTtlSeconds { get; set; } = 120;

    public int MaxShareTtlSeconds { get; set; } = 86400;

    public int AttachAttemptsPerMinutePerIp { get; set; } = 10;

    public int AttachAttemptsPerMinutePerShare { get; set; } = 60;

    public int IdleTimeoutSeconds { get; set; } = 120;

    /// <summary><see cref="MaxFrameBytes"/> clamped to what a single buffer can hold.</summary>
    public int EffectiveMaxFrameBytes => (int)Math.Min(MaxFrameBytes, int.MaxValue);
}

/// <summary>
/// Terrain SVG cache section. Each game host pins the last terrain result of its
/// session; unique payloads are pooled by content hash.
/// </summary>
public sealed class TerrainCacheOptions
{
    /// <summary>When false every terrain request is forwarded as before.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Cap on the unique pooled payload bytes. A new payload that would exceed it
    /// is forwarded but not cached or pinned. 0 keeps nothing new.
    /// </summary>
    public long MaxTotalBytes { get; set; } = 256L * 1024 * 1024;

    /// <summary>How long a forwarded request may wait for its reply before it is forgotten.</summary>
    public int PendingTimeoutSeconds { get; set; } = 60;

    /// <summary><see cref="PendingTimeoutSeconds"/> as a duration.</summary>
    public TimeSpan PendingTimeout() => TimeSpan.FromSeconds(Math.Max(1, PendingTimeoutSeconds));
}
