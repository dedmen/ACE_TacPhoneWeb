using System.Text;
using System.Text.Json;
using TacPhone.RemoteServer.Realtime;

namespace TacPhone.RemoteServer.Tests.Realtime;

public sealed class TextureRequestTests
{
    private const string RequestJson = """
        {"k":"nr8","d":{"a":"main","c":"RequestTexture","path":"a/b.paa","maxSize":512}}
        """;

    [Fact]
    public void TryParse_AcceptsAValidRequest()
    {
        Assert.True(TextureRequest.TryParse(Utf8(RequestJson), out var requestKey, out var cacheKey));

        Assert.Equal("nr8", requestKey);
        Assert.Equal(TextureRequest.ComputeCacheKey("a\\b.paa", 512), cacheKey);
        Assert.EndsWith("\u0000512", cacheKey);
    }

    [Fact]
    public void ComputeCacheKey_NormalizesSlashesLeadingBackslashAndCase()
    {
        var expected = TextureRequest.ComputeCacheKey(@"a\b.paa", 512);

        Assert.Equal(expected, TextureRequest.ComputeCacheKey(@"\a\b.paa", 512));
        Assert.Equal(expected, TextureRequest.ComputeCacheKey("a/b.paa", 512));
        Assert.Equal(expected, TextureRequest.ComputeCacheKey(@"A\B.PAA", 512));
        Assert.Equal(@"a\b.paa" + "\u0000" + "512", expected);
    }

    [Fact]
    public void ComputeCacheKey_DifferentMaxSizeProducesADifferentKey()
    {
        Assert.NotEqual(
            TextureRequest.ComputeCacheKey(@"a\b.paa", 128),
            TextureRequest.ComputeCacheKey(@"a\b.paa", 256));
    }

    [Fact]
    public void TryParse_RejectsMissingOrNonStringPath()
    {
        Assert.False(TryParse("""{"a":"main","c":"RequestTexture","maxSize":512}"""));
        Assert.False(TryParse("""{"a":"main","c":"RequestTexture","path":42,"maxSize":512}"""));
        Assert.False(TryParse("""{"a":"main","c":"RequestTexture","path":"","maxSize":512}"""));
    }

    [Fact]
    public void TryParse_RejectsMissingZeroNegativeOrNonIntegerMaxSize()
    {
        Assert.False(TryParse("""{"a":"main","c":"RequestTexture","path":"a.paa"}"""));
        Assert.False(TryParse("""{"a":"main","c":"RequestTexture","path":"a.paa","maxSize":0}"""));
        Assert.False(TryParse("""{"a":"main","c":"RequestTexture","path":"a.paa","maxSize":-1}"""));
        Assert.False(TryParse("""{"a":"main","c":"RequestTexture","path":"a.paa","maxSize":"512"}"""));
        Assert.False(TryParse("""{"a":"main","c":"RequestTexture","path":"a.paa","maxSize":16385}"""));
    }

    [Fact]
    public void TryParse_RejectsAnotherCommandOrApp()
    {
        Assert.False(TryParse("""{"a":"main","c":"RequestTerrainSVG","path":"a.paa","maxSize":512}"""));
        Assert.False(TryParse("""{"a":"map","c":"RequestTexture","path":"a.paa","maxSize":512}"""));
    }

    [Fact]
    public void TryParse_RejectsMalformedFrames()
    {
        Assert.False(TextureRequest.TryParse(ReadOnlySpan<byte>.Empty, out _, out _));
        Assert.False(TextureRequest.TryParse(Utf8("not json"), out _, out _));
        Assert.False(TextureRequest.TryParse(Utf8("[]"), out _, out _));
        Assert.False(TextureRequest.TryParse(Utf8("""{"k":"nr8","d":"RequestTexture"}"""), out _, out _));
        Assert.False(TextureRequest.TryParse(Utf8("""{"d":{"a":"main","c":"RequestTexture","path":"a.paa","maxSize":512}}"""), out _, out _));
        Assert.False(TextureRequest.TryParse(Utf8(RequestJson + "{}"), out _, out _));
    }

    [Fact]
    public void TryReadReply_ExtractsANonEmptyString()
    {
        Assert.True(TextureRequest.TryReadReply(Utf8("""{"k":"nr8","d":"H4sIAAAA"}"""), out var requestKey, out var data));

        Assert.Equal("nr8", requestKey);
        Assert.Equal("H4sIAAAA", data);
    }

    [Fact]
    public void TryReadReply_ClearsTheKeyWithoutDataForAnErrorReply()
    {
        Assert.True(TextureRequest.TryReadReply(
            Utf8("""{"k":"nr8","d":{"ok":false,"error":"missing"}}"""), out var objectKey, out var objectData));
        Assert.Equal("nr8", objectKey);
        Assert.Null(objectData);

        Assert.True(TextureRequest.TryReadReply(Utf8("""{"k":"nr8","d":""}"""), out var emptyKey, out var empty));
        Assert.Equal("nr8", emptyKey);
        Assert.Null(empty);

        Assert.True(TextureRequest.TryReadReply(Utf8("""{"k":"nr8","d":42}"""), out _, out var numeric));
        Assert.Null(numeric);
    }

    [Fact]
    public void TryReadReply_RejectsMissingKeyOrD()
    {
        Assert.False(TextureRequest.TryReadReply(Utf8("""{"d":"H4sIAAAA"}"""), out _, out _));
        Assert.False(TextureRequest.TryReadReply(Utf8("""{"k":7,"d":"H4sIAAAA"}"""), out _, out _));
        Assert.False(TextureRequest.TryReadReply(Utf8("""{"k":"nr8"}"""), out _, out _));
        Assert.False(TextureRequest.TryReadReply(ReadOnlySpan<byte>.Empty, out _, out _));
    }

    [Fact]
    public void TryReadReply_RejectsATerrainChunkObject()
    {
        // Terrain chunks are objects too; the texture pending map must not consume them.
        Assert.False(TextureRequest.TryReadReply(
            Utf8("""{"k":"nr8","d":{"a":"main","c":"ReplyRequestTerrainSVG","index":0,"count":1,"part":0,"parts":1,"width":1,"height":1,"data":"x"}}"""),
            out _,
            out _));
    }

    [Fact]
    public void BuildReply_WritesTheRequestKeyAndPayload()
    {
        var reply = TextureRequest.BuildReply("nr8", "H4sIAAAA\"quoted\"");

        using var document = JsonDocument.Parse(reply);
        Assert.Equal("nr8", document.RootElement.GetProperty("k").GetString());
        Assert.Equal("H4sIAAAA\"quoted\"", document.RootElement.GetProperty("d").GetString());
        Assert.Equal(2, document.RootElement.EnumerateObject().Count());
    }

    private static bool TryParse(string d) =>
        TextureRequest.TryParse(Utf8($$"""{"k":"nr8","d":{{d}}}"""), out _, out _);

    private static byte[] Utf8(string json) => Encoding.UTF8.GetBytes(json);
}
