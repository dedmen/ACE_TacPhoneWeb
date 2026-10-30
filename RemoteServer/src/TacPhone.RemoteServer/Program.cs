using System.Net;
using Microsoft.AspNetCore.HttpOverrides;
using TacPhone.RemoteServer.Configuration;
using TacPhone.RemoteServer.Infrastructure;
using TacPhone.RemoteServer.Realtime;
using TacPhone.RemoteServer.Storage;
using TacPhone.RemoteServer.Web;

var builder = WebApplication.CreateBuilder(args);

// Optional .env for `dotnet run`/manual deployments; systemd's EnvironmentFile
// is not visible to the app itself. Real environment variables still win.
var dotEnvPath = DotEnv.Load(builder.Configuration, builder.Environment.ContentRootPath);

var options = builder.Configuration.GetSection(TacPhoneOptions.SectionName).Get<TacPhoneOptions>()
              ?? new TacPhoneOptions();
options.TrustedProxies ??= [];
options.EnsureValid();

var logFilePath = options.ResolveLogFilePath(builder.Environment.ContentRootPath);
if (!string.IsNullOrEmpty(logFilePath))
{
    builder.Logging.AddProvider(new FileLoggerProvider(new FileLoggerOptions
    {
        Path = logFilePath,
        MinLevel = options.LogFileMinLevel,
        MaxBytes = options.LogFileMaxBytes,
        KeepFiles = options.LogFileKeep,
    }));
}

// Plain HTTP only. TLS is terminated by nginx (see README and deploy/).
builder.WebHost.UseUrls(options.ListenUrl());
builder.WebHost.ConfigureKestrel(kestrel => kestrel.AddServerHeader = false);

builder.Services.AddSingleton(options);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<ServerInfo>();
builder.Services.AddSingleton(sp => new RemoteDatabase(
    options.ResolveDatabasePath(builder.Environment.ContentRootPath),
    sp.GetRequiredService<ILogger<RemoteDatabase>>()));
builder.Services.AddSingleton<RemoteRepository>();
builder.Services.AddSingleton<HostRegistry>();
builder.Services.AddSingleton<AttachRateLimiters>();
builder.Services.AddSingleton<TerrainCache>();
builder.Services.AddSingleton<RelayEndpoint>();
builder.Services.AddHostedService<RelayMaintenanceService>();

// Close sockets before the process exits; systemd's TimeoutStopSec is 20s.
builder.Services.Configure<HostOptions>(host => host.ShutdownTimeout = TimeSpan.FromSeconds(15));

var app = builder.Build();

if (dotEnvPath is not null)
{
    app.Logger.LogInformation("Loaded configuration from {DotEnvPath}", dotEnvPath);
}

if (!string.IsNullOrEmpty(logFilePath))
{
    app.Logger.LogInformation("Writing logs to {LogFile}", logFilePath);
}

app.Logger.LogInformation(
    "TacPhone Remote Server {Version} starting: {Configuration}",
    app.Services.GetRequiredService<ServerInfo>().Version,
    options.Describe());

// Precompressed entry document. The variants are built once and regenerated
// only when the source hash changes; they live in memory, so a read-only cache
// directory (production /opt) still serves them.
var databasePath = options.ResolveDatabasePath(app.Environment.ContentRootPath);
var compressedCacheDir = options.ResolveCompressedStaticPath(
    app.Environment.ContentRootPath, databasePath);
var compressedIndex = await CompressedStaticIndex.PrepareAsync(
    Path.Combine(app.Environment.ContentRootPath, "wwwroot", "index.html"),
    compressedCacheDir,
    app.Logger);

// The real client IP is what the attach rate limiter must see.
app.UseForwardedHeaders(BuildForwardedHeadersOptions(options, app.Logger));

// The UI is hash routed: one entry document, never cached.
app.Use(async (context, next) =>
{
    var path = context.Request.Path;
    if (path == "/" || path.Equals("/index.html", StringComparison.OrdinalIgnoreCase))
    {
        context.Response.Headers.CacheControl = "no-store";
    }

    await next(context).ConfigureAwait(false);
});

app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(30),
});

app.UseDefaultFiles();

// Precompressed entry document: picks br or gzip from Accept-Encoding and
// falls through to the static files when nothing acceptable is offered.
app.Use(async (context, next) =>
{
    if (compressedIndex is not null &&
        (HttpMethods.IsGet(context.Request.Method) || HttpMethods.IsHead(context.Request.Method)) &&
        (context.Request.Path == "/" ||
         context.Request.Path.Equals("/index.html", StringComparison.OrdinalIgnoreCase)) &&
        compressedIndex.TrySelect(context.Request.Headers.AcceptEncoding.ToString(), out var bytes, out var encoding))
    {
        context.Response.ContentType = "text/html; charset=utf-8";
        // A plain header, not Response.ContentEncoding: that one expects an
        // Encoding object and would try to transcode the body.
        context.Response.Headers.ContentEncoding = encoding;
        context.Response.Headers.Vary = "Accept-Encoding";
        context.Response.ContentLength = bytes.Length;
        context.Response.Headers.CacheControl = "no-store";

        if (HttpMethods.IsHead(context.Request.Method))
            return;

        await context.Response.Body.WriteAsync(bytes, context.RequestAborted).ConfigureAwait(false);
        return;
    }

    await next(context).ConfigureAwait(false);
});

app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = staticContext =>
    {
        if (string.Equals(staticContext.File.Name, "index.html", StringComparison.OrdinalIgnoreCase))
        {
            staticContext.Context.Response.Headers.CacheControl = "no-store";
        }
    },
});

app.MapGet("/health", (ServerInfo info, HostRegistry registry, TerrainCache terrainCache, TimeProvider time) =>
{
    var cache = terrainCache.Snapshot();

    return Results.Json(new
    {
        status = "ok",
        version = info.Version,
        uptimeSeconds = info.UptimeSeconds(time),
        hostsOnline = registry.HostCount,
        clientsOnline = registry.ClientCount,
        terrainCacheEntries = cache.Entries,
        terrainCacheBytes = cache.Bytes,
        terrainCacheHosts = cache.Pins,
        terrainCacheHits = cache.Hits,
        terrainCacheMisses = cache.Misses,
    });
});

app.MapGet("/ws", async (HttpContext context, RelayEndpoint endpoint) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsJsonAsync(new { error = "websocket-required" }).ConfigureAwait(false);
        return;
    }

    await endpoint.HandleAsync(context, context.RequestAborted).ConfigureAwait(false);
});

// Unknown paths serve the static entry: the UI is hash routed.
app.MapFallbackToFile("index.html");

try
{
    await app.Services.GetRequiredService<RemoteDatabase>().InitializeAsync();
}
catch (Exception ex)
{
    app.Logger.LogCritical(ex, "Could not open or migrate the SQLite database");
    throw;
}

app.Logger.LogInformation(
    "Listening on {Url}. Relay traffic is plaintext at this process; terminate TLS in front of it.",
    options.ListenUrl());

try
{
    await app.RunAsync();
}
catch (Exception ex)
{
    // Capture fatal startup/runtime failures in the file log as well.
    app.Logger.LogCritical(ex, "TacPhone Remote Server terminated unexpectedly");
    throw;
}

static ForwardedHeadersOptions BuildForwardedHeadersOptions(TacPhoneOptions options, ILogger logger)
{
    var forwarded = new ForwardedHeadersOptions
    {
        ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
        ForwardLimit = 1,
    };

    // Replace the framework defaults with the configured proxy list.
    forwarded.KnownProxies.Clear();
    forwarded.KnownIPNetworks.Clear();

    foreach (var entry in options.TrustedProxies)
    {
        var value = entry?.Trim();
        if (string.IsNullOrEmpty(value))
        {
            continue;
        }

        if (IPAddress.TryParse(value, out var address))
        {
            forwarded.KnownProxies.Add(address);
            continue;
        }

        var parts = value.Split('/', 2);
        if (parts.Length == 2
            && IPAddress.TryParse(parts[0], out var networkAddress)
            && int.TryParse(parts[1], out var prefixLength)
            && prefixLength >= 0
            && prefixLength <= (networkAddress.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? 128 : 32))
        {
            forwarded.KnownIPNetworks.Add(new System.Net.IPNetwork(networkAddress, prefixLength));
            continue;
        }

        logger.LogWarning("Ignoring an invalid TacPhone:TrustedProxies entry");
    }

    return forwarded;
}
