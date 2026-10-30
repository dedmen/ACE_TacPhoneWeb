using System.IO.Compression;
using System.Security.Cryptography;

namespace TacPhone.RemoteServer.Web;

/// <summary>
/// Precompressed Brotli/gzip variants of the hosted <c>wwwroot/index.html</c>.
/// The variants are produced once at startup and kept in memory; the cache
/// directory only avoids recompressing an unchanged file on the next start.
/// A read-only cache directory (production <c>/opt</c> under
/// <c>ProtectSystem=strict</c>) is not fatal: the bytes stay in memory.
/// </summary>
public sealed class CompressedStaticIndex
{
    /// <summary>Brotli variant file name inside the cache directory.</summary>
    public const string BrotliFileName = "index.html.br";

    /// <summary>Gzip variant file name inside the cache directory.</summary>
    public const string GzipFileName = "index.html.gz";

    /// <summary>Marker file holding the lowercase hex SHA-256 of the source.</summary>
    public const string MarkerFileName = "index.html.sha256";

    private const string BrotliEncoding = "br";
    private const string GzipEncoding = "gzip";

    private CompressedStaticIndex(byte[] brotli, byte[] gzip, long sourceBytes, bool regenerated)
    {
        Brotli = brotli;
        Gzip = gzip;
        SourceBytes = sourceBytes;
        Regenerated = regenerated;
    }

    /// <summary>Brotli-compressed source bytes.</summary>
    public byte[] Brotli { get; }

    /// <summary>Gzip-compressed source bytes.</summary>
    public byte[] Gzip { get; }

    /// <summary>Size of the uncompressed source file.</summary>
    public long SourceBytes { get; }

    /// <summary>
    /// True when the source hash did not match the marker (or a variant was
    /// missing) and both variants were rebuilt.
    /// </summary>
    public bool Regenerated { get; }

    /// <summary>
    /// Loads or rebuilds the variants for <paramref name="sourcePath"/>. Returns
    /// <c>null</c> when the source file does not exist; the caller keeps serving
    /// the static files in that case.
    /// </summary>
    public static async Task<CompressedStaticIndex?> PrepareAsync(
        string sourcePath,
        string cacheDirectory,
        ILogger logger,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(sourcePath);
        ArgumentException.ThrowIfNullOrEmpty(cacheDirectory);
        ArgumentNullException.ThrowIfNull(logger);

        if (!File.Exists(sourcePath))
        {
            logger.LogWarning(
                "Compressed static index: {SourcePath} is missing; serving the static files uncompressed",
                sourcePath);
            return null;
        }

        var sourceBytes = await File.ReadAllBytesAsync(sourcePath, cancellationToken).ConfigureAwait(false);
        var hash = Convert.ToHexString(SHA256.HashData(sourceBytes)).ToLowerInvariant();

        if (TryLoadCached(cacheDirectory, hash, out var cachedBrotli, out var cachedGzip))
        {
            logger.LogInformation(
                "Compressed static index: reusing cached variants (source {SourceBytes} bytes, br {BrotliBytes} bytes, gzip {GzipBytes} bytes)",
                sourceBytes.Length,
                cachedBrotli.Length,
                cachedGzip.Length);

            return new CompressedStaticIndex(cachedBrotli, cachedGzip, sourceBytes.Length, regenerated: false);
        }

        var brotli = Compress(sourceBytes, static stream => new BrotliStream(stream, CompressionLevel.SmallestSize, leaveOpen: true));
        var gzip = Compress(sourceBytes, static stream => new GZipStream(stream, CompressionLevel.SmallestSize, leaveOpen: true));

        logger.LogInformation(
            "Compressed static index: regenerated variants (source {SourceBytes} bytes, br {BrotliBytes} bytes, gzip {GzipBytes} bytes)",
            sourceBytes.Length,
            brotli.Length,
            gzip.Length);

        Persist(cacheDirectory, hash, brotli, gzip, logger);

        return new CompressedStaticIndex(brotli, gzip, sourceBytes.Length, regenerated: true);
    }

    /// <summary>
    /// Picks the best variant the client accepts: Brotli before gzip.
    /// Returns false when no supported encoding is acceptable (including a
    /// missing header or every supported encoding disabled with <c>q=0</c>).
    /// </summary>
    public bool TrySelect(string? acceptEncoding, out byte[] data, out string contentEncoding)
    {
        data = Array.Empty<byte>();
        contentEncoding = string.Empty;

        var acceptsBrotli = false;
        var acceptsGzip = false;
        var acceptsAny = false;

        foreach (var part in (acceptEncoding ?? string.Empty).Split(','))
        {
            var sections = part.Split(';');
            var token = sections[0].Trim();
            if (token.Length == 0)
            {
                continue;
            }

            if (!IsAcceptable(sections))
            {
                continue;
            }

            if (token.Equals(BrotliEncoding, StringComparison.OrdinalIgnoreCase))
            {
                acceptsBrotli = true;
            }
            else if (token.Equals(GzipEncoding, StringComparison.OrdinalIgnoreCase))
            {
                acceptsGzip = true;
            }
            else if (token == "*")
            {
                acceptsAny = true;
            }
        }

        if (acceptsBrotli)
        {
            data = Brotli;
            contentEncoding = BrotliEncoding;
            return true;
        }

        if (acceptsGzip || acceptsAny)
        {
            data = Gzip;
            contentEncoding = GzipEncoding;
            return true;
        }

        return false;
    }

    private static bool IsAcceptable(string[] sections)
    {
        for (var i = 1; i < sections.Length; i++)
        {
            var parameter = sections[i].Trim();
            if (!parameter.StartsWith("q=", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            // Only an explicit zero rejects the encoding; anything unparsable is
            // treated as acceptable (the header is advisory, not a guarantee).
            return !double.TryParse(
                       parameter.AsSpan(2),
                       System.Globalization.NumberStyles.Float,
                       System.Globalization.CultureInfo.InvariantCulture,
                       out var quality)
                   || quality > 0;
        }

        return true;
    }

    private static byte[] Compress(byte[] source, Func<Stream, Stream> createCompressor)
    {
        using var output = new MemoryStream();
        using (var compressor = createCompressor(output))
        {
            compressor.Write(source, 0, source.Length);
        }

        return output.ToArray();
    }

    private static bool TryLoadCached(string cacheDirectory, string hash, out byte[] brotli, out byte[] gzip)
    {
        brotli = Array.Empty<byte>();
        gzip = Array.Empty<byte>();

        try
        {
            var markerPath = Path.Combine(cacheDirectory, MarkerFileName);
            if (!File.Exists(markerPath))
            {
                return false;
            }

            if (!string.Equals(File.ReadAllText(markerPath).Trim(), hash, StringComparison.Ordinal))
            {
                return false;
            }

            var brotliPath = Path.Combine(cacheDirectory, BrotliFileName);
            var gzipPath = Path.Combine(cacheDirectory, GzipFileName);
            if (!File.Exists(brotliPath) || !File.Exists(gzipPath))
            {
                return false;
            }

            var brotliBytes = File.ReadAllBytes(brotliPath);
            var gzipBytes = File.ReadAllBytes(gzipPath);
            if (brotliBytes.Length == 0 || gzipBytes.Length == 0)
            {
                return false;
            }

            brotli = brotliBytes;
            gzip = gzipBytes;
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static void Persist(string cacheDirectory, string hash, byte[] brotli, byte[] gzip, ILogger logger)
    {
        try
        {
            Directory.CreateDirectory(cacheDirectory);

            WriteAtomically(Path.Combine(cacheDirectory, BrotliFileName), brotli);
            WriteAtomically(Path.Combine(cacheDirectory, GzipFileName), gzip);

            // The marker goes last: a crash mid-write leaves a stale marker that
            // simply triggers a regeneration next start.
            WriteAtomically(Path.Combine(cacheDirectory, MarkerFileName), System.Text.Encoding.UTF8.GetBytes(hash));
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                "Compressed static index: could not write the cache directory {CacheDirectory} ({Reason}); keeping the in-memory variants",
                cacheDirectory,
                ex.Message);
        }
    }

    private static void WriteAtomically(string path, byte[] contents)
    {
        var temporaryPath = path + ".tmp";
        File.WriteAllBytes(temporaryPath, contents);
        File.Move(temporaryPath, path, overwrite: true);
    }
}
