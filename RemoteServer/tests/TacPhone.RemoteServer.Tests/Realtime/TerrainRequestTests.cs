using System.Text;
using System.Text.Json;
using TacPhone.RemoteServer.Realtime;

namespace TacPhone.RemoteServer.Tests.Realtime;

public sealed class TerrainRequestTests
{
    private const string TerrainRequestJson = """
        {"k":"nr7","d":{"a":"main","c":"RequestTerrainSVG","config":{"world":"altis","size":2048,"flags":["a","b"]}}}
        """;

    [Fact]
    public void TryParse_AcceptsTheTerrainRequestFrame()
    {
        Assert.True(TerrainRequest.TryParse(Utf8(TerrainRequestJson), out var requestKey, out var configHash));

        Assert.Equal("nr7", requestKey);
        Assert.Equal(64, configHash.Length);
    }

    [Fact]
    public void TryParse_UsesTheCanonicalConfigHash()
    {
        const string reordered = """
            {"k":"nr7","d":{"config":{"flags":["a","b"],"size":2048,"world":"altis"},"c":"RequestTerrainSVG","a":"main"}}
            """;

        Assert.True(TerrainRequest.TryParse(Utf8(TerrainRequestJson), out _, out var first));
        Assert.True(TerrainRequest.TryParse(Utf8(reordered), out _, out var second));

        using var config = JsonDocument.Parse("""{"world":"altis","size":2048,"flags":["a","b"]}""");
        Assert.Equal(TerrainCache.ComputeConfigHash(config.RootElement), first);
        Assert.Equal(first, second);
    }

    [Fact]
    public void TryParse_RejectsOtherCommands()
    {
        const string texture = """
            {"k":"nr8","d":{"a":"main","c":"RequestTexture","path":"x.paa"}}
            """;

        Assert.False(TerrainRequest.TryParse(Utf8(texture), out _, out _));
    }

    [Fact]
    public void TryParse_RejectsAnotherApp()
    {
        const string other = """
            {"k":"nr7","d":{"a":"map","c":"RequestTerrainSVG","config":{"world":"altis"}}}
            """;

        Assert.False(TerrainRequest.TryParse(Utf8(other), out _, out _));
    }

    [Fact]
    public void TryParse_RejectsMissingOrNonStringKey()
    {
        Assert.False(TerrainRequest.TryParse(
            Utf8("""{"d":{"a":"main","c":"RequestTerrainSVG","config":{"world":"altis"}}}"""), out _, out _));

        Assert.False(TerrainRequest.TryParse(
            Utf8("""{"k":7,"d":{"a":"main","c":"RequestTerrainSVG","config":{"world":"altis"}}}"""), out _, out _));

        Assert.False(TerrainRequest.TryParse(
            Utf8("""{"k":"","d":{"a":"main","c":"RequestTerrainSVG","config":{"world":"altis"}}}"""), out _, out _));
    }

    [Fact]
    public void TryParse_RejectsMissingOrNonObjectConfig()
    {
        Assert.False(TerrainRequest.TryParse(
            Utf8("""{"k":"nr7","d":{"a":"main","c":"RequestTerrainSVG"}}"""), out _, out _));

        Assert.False(TerrainRequest.TryParse(
            Utf8("""{"k":"nr7","d":{"a":"main","c":"RequestTerrainSVG","config":[1,2]}}"""), out _, out _));
    }

    [Fact]
    public void TryParse_RejectsNonObjectD()
    {
        Assert.False(TerrainRequest.TryParse(
            Utf8("""{"k":"nr7","d":"RequestTerrainSVG"}"""), out _, out _));
    }

    [Fact]
    public void TryParse_RejectsMalformedFrames()
    {
        Assert.False(TerrainRequest.TryParse(ReadOnlySpan<byte>.Empty, out _, out _));
        Assert.False(TerrainRequest.TryParse(Utf8("not json"), out _, out _));
        Assert.False(TerrainRequest.TryParse(Utf8("[]"), out _, out _));
        Assert.False(TerrainRequest.TryParse(Utf8(TerrainRequestJson + "{}"), out _, out _));
    }

    [Fact]
    public void BuildReply_WritesTheRequestKeyAndPayload()
    {
        var reply = TerrainRequest.BuildReply("nr7", "H4sIAAAA\"quoted\"");

        using var document = JsonDocument.Parse(reply);
        Assert.Equal(JsonValueKind.Object, document.RootElement.ValueKind);
        Assert.Equal("nr7", document.RootElement.GetProperty("k").GetString());
        Assert.Equal("H4sIAAAA\"quoted\"", document.RootElement.GetProperty("d").GetString());
        Assert.Equal(2, document.RootElement.EnumerateObject().Count());
    }

    [Fact]
    public void TryReadReply_ExtractsTheStringPayload()
    {
        Assert.True(TerrainRequest.TryReadReply(Utf8("""{"k":"nr7","d":"H4sIAAAA"}"""), out var requestKey, out var data));

        Assert.Equal("nr7", requestKey);
        Assert.Equal("H4sIAAAA", data);
    }

    [Fact]
    public void TryReadReply_ReturnsNullForANonStringPayload()
    {
        // The frame is still a valid reply and must consume the pending entry;
        // only a string `d` is ever cached.
        Assert.True(TerrainRequest.TryReadReply(Utf8("""{"k":"nr7","d":42}"""), out var numericKey, out var numeric));
        Assert.Equal("nr7", numericKey);
        Assert.Null(numeric);

        Assert.True(TerrainRequest.TryReadReply(
            Utf8("""{"k":"nr7","d":{"ok":false,"error":"boom"}}"""), out var objectKey, out var error));
        Assert.Equal("nr7", objectKey);
        Assert.Null(error);

        // An empty string is still a string; it parses but is never cached.
        Assert.True(TerrainRequest.TryReadReply(Utf8("""{"k":"nr7","d":""}"""), out var emptyKey, out var empty));
        Assert.Equal("nr7", emptyKey);
        Assert.Equal(string.Empty, empty);
    }

    [Fact]
    public void TryReadReply_RejectsMissingKey()
    {
        Assert.False(TerrainRequest.TryReadReply(Utf8("""{"d":"H4sIAAAA"}"""), out _, out _));
        Assert.False(TerrainRequest.TryReadReply(Utf8("""{"k":null,"d":"H4sIAAAA"}"""), out _, out _));
        Assert.False(TerrainRequest.TryReadReply(ReadOnlySpan<byte>.Empty, out _, out _));
    }

    private static byte[] Utf8(string json) => Encoding.UTF8.GetBytes(json);
}
