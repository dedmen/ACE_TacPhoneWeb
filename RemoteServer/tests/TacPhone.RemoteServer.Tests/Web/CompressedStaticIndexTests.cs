using System.IO.Compression;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using TacPhone.RemoteServer.Web;

namespace TacPhone.RemoteServer.Tests.Web;

public sealed class CompressedStaticIndexTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        "tacphone-compressed-static-" + Guid.NewGuid().ToString("N"));

    public CompressedStaticIndexTests()
    {
        Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }
        catch (IOException)
        {
            // A test may deliberately hold a file where a directory is expected.
        }
    }

    [Fact]
    public async Task PrepareAsync_CreatesBothVariantsAndTheMarker()
    {
        var source = WriteSource("first version of the entry document");

        var index = await Prepare(source);

        Assert.NotNull(index);
        Assert.True(index.Regenerated);
        Assert.Equal(File.ReadAllBytes(source).Length, index.SourceBytes);

        Assert.Equal("first version of the entry document", DecompressBrotli(index.Brotli));
        Assert.Equal("first version of the entry document", DecompressGzip(index.Gzip));

        var cache = CacheDirectory();
        Assert.True(File.Exists(Path.Combine(cache, CompressedStaticIndex.BrotliFileName)));
        Assert.True(File.Exists(Path.Combine(cache, CompressedStaticIndex.GzipFileName)));

        var marker = File.ReadAllText(Path.Combine(cache, CompressedStaticIndex.MarkerFileName)).Trim();
        Assert.Equal(64, marker.Length);
        Assert.Equal(marker.ToLowerInvariant(), marker);
    }

    [Fact]
    public async Task PrepareAsync_ReusesVariantsWhenTheSourceIsUnchanged()
    {
        var source = WriteSource("unchanged source text");

        var first = await Prepare(source);
        var second = await Prepare(source);

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.True(first.Regenerated);
        Assert.False(second.Regenerated);
        Assert.Equal(DecompressBrotli(first.Brotli), DecompressBrotli(second.Brotli));
        Assert.Equal(DecompressGzip(first.Gzip), DecompressGzip(second.Gzip));
        Assert.Equal("unchanged source text", DecompressBrotli(second.Brotli));
    }

    [Fact]
    public async Task PrepareAsync_RegeneratesWhenTheSourceChanges()
    {
        var source = WriteSource("the original text");
        await Prepare(source);

        File.WriteAllText(source, "a completely different text with another hash", new UTF8Encoding(false));

        var index = await Prepare(source);

        Assert.NotNull(index);
        Assert.True(index.Regenerated);
        Assert.Equal("a completely different text with another hash", DecompressBrotli(index.Brotli));
        Assert.Equal("a completely different text with another hash", DecompressGzip(index.Gzip));
    }

    [Fact]
    public async Task PrepareAsync_ReturnsNullWhenTheSourceIsMissing()
    {
        var index = await Prepare(Path.Combine(_root, "missing.html"));

        Assert.Null(index);
    }

    [Fact]
    public async Task PrepareAsync_KeepsInMemoryVariantsWhenTheCacheIsNotWritable()
    {
        var source = WriteSource("serve me even without a cache directory");

        // A file where the cache directory should be: Directory.CreateDirectory throws.
        var blockedCache = Path.Combine(_root, "blocked");
        File.WriteAllText(blockedCache, "not a directory");

        var index = await CompressedStaticIndex.PrepareAsync(
            source,
            blockedCache,
            NullLogger.Instance);

        Assert.NotNull(index);
        Assert.True(index.Regenerated);
        Assert.Equal("serve me even without a cache directory", DecompressBrotli(index.Brotli));
        Assert.Equal("serve me even without a cache directory", DecompressGzip(index.Gzip));
        Assert.True(File.Exists(blockedCache));
    }

    [Theory]
    [InlineData("br, gzip", "br")]
    [InlineData("gzip", "gzip")]
    [InlineData("br;q=0, gzip", "gzip")]
    [InlineData("*", "gzip")]
    [InlineData("gzip, br", "br")]
    [InlineData("BR", "br")]
    [InlineData("br;q=0.5", "br")]
    [InlineData("gzip;q=0.5", "gzip")]
    public async Task TrySelect_PicksThePreferredAcceptableEncoding(string header, string expected)
    {
        var index = await Prepare(WriteSource("select me"));

        Assert.NotNull(index);
        Assert.True(index.TrySelect(header, out var data, out var encoding));
        Assert.Equal(expected, encoding);
        Assert.NotEmpty(data);
    }

    [Theory]
    [InlineData("identity")]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("br;q=0")]
    [InlineData("*;q=0")]
    public async Task TrySelect_ReturnsFalseForUnsupportedHeaders(string? header)
    {
        var index = await Prepare(WriteSource("select me"));

        Assert.NotNull(index);
        Assert.False(index.TrySelect(header, out _, out var encoding));
        Assert.Equal(string.Empty, encoding);
    }

    private string CacheDirectory() => Path.Combine(_root, "cache");

    private string WriteSource(string text)
    {
        var path = Path.Combine(_root, "index.html");
        File.WriteAllText(path, text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return path;
    }

    private Task<CompressedStaticIndex?> Prepare(string sourcePath) =>
        CompressedStaticIndex.PrepareAsync(sourcePath, CacheDirectory(), NullLogger.Instance);

    private static string DecompressBrotli(byte[] data)
    {
        using var input = new MemoryStream(data);
        using var brotli = new BrotliStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        brotli.CopyTo(output);
        return Encoding.UTF8.GetString(output.ToArray());
    }

    private static string DecompressGzip(byte[] data)
    {
        using var input = new MemoryStream(data);
        using var gzip = new GZipStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        gzip.CopyTo(output);
        return Encoding.UTF8.GetString(output.ToArray());
    }
}
