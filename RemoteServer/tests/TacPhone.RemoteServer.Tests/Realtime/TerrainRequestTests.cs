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

    // ----------------------------------------------------------- chunk frames

    [Fact]
    public void TryReadChunk_AcceptsAValidLayerFrame()
    {
        const string frame = """
            {"k":"nr7","d":{"a":"main","c":"ReplyRequestTerrainSVG","uid":12,"index":2,"count":5,
             "part":1,"parts":3,"name":"Layer 3","width":2048,"height":2048,"data":"H4sIAAAA","last":false}}
            """;

        Assert.True(TerrainRequest.TryReadChunk(Utf8(frame), out var key, out var chunk));

        Assert.Equal("nr7", key);
        Assert.Equal(2, chunk.Index);
        Assert.Equal(5, chunk.Count);
        Assert.Equal(1, chunk.Part);
        Assert.Equal(3, chunk.Parts);
        Assert.Equal(2048, chunk.Width);
        Assert.Equal(2048, chunk.Height);
        Assert.Equal("Layer 3", chunk.Name);
        Assert.Equal("H4sIAAAA", chunk.Data);
        Assert.Null(chunk.Error);
    }

    [Fact]
    public void TryReadChunk_DefaultsPartAndPartsAndNames()
    {
        const string frame = """
            {"k":"nr7","d":{"c":"ReplyRequestTerrainSVG","index":0,"count":1,
             "width":512,"height":256,"data":"H4sIAAAA"}}
            """;

        Assert.True(TerrainRequest.TryReadChunk(Utf8(frame), out _, out var chunk));

        Assert.Equal(0, chunk.Part);
        Assert.Equal(1, chunk.Parts);
        Assert.Equal("Layer 1", chunk.Name);
    }

    [Fact]
    public void TryReadChunk_AcceptsAnErrorFrame()
    {
        const string frame = """
            {"k":"nr7","d":{"a":"main","c":"ReplyRequestTerrainSVG","uid":12,"error":"no terrain"}}
            """;

        Assert.True(TerrainRequest.TryReadChunk(Utf8(frame), out var key, out var chunk));

        Assert.Equal("nr7", key);
        Assert.Equal("no terrain", chunk.Error);
        Assert.Null(chunk.Data);
    }

    [Fact]
    public void TryReadChunk_RejectsMalformedIndices()
    {
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":-1,"count":2,"width":1,"height":1,"data":"x"}"""));
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":2,"count":2,"width":1,"height":1,"data":"x"}"""));
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","count":2,"width":1,"height":1,"data":"x"}"""));
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":0,"count":0,"width":1,"height":1,"data":"x"}"""));
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":0,"count":65,"width":1,"height":1,"data":"x"}"""));
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":0,"count":2,"part":2,"parts":2,"width":1,"height":1,"data":"x"}"""));
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":0,"count":2,"parts":65,"width":1,"height":1,"data":"x"}"""));
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":0,"count":2,"width":0,"height":1,"data":"x"}"""));
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":0,"count":2,"width":1,"height":-4,"data":"x"}"""));
    }

    [Fact]
    public void TryReadChunk_RejectsMissingKeyDataOrCommand()
    {
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":0,"count":1,"width":1,"height":1,"data":"x"}""", withKey: false));
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":0,"count":1,"width":1,"height":1}"""));
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":0,"count":1,"width":1,"height":1,"data":42}"""));
        Assert.False(TryChunk("""{"c":"ReplyRequestTerrainSVG","index":0,"count":1,"width":1,"height":1,"data":""}"""));
        Assert.False(TryChunk("""{"c":"SomethingElse","index":0,"count":1,"width":1,"height":1,"data":"x"}"""));
        Assert.False(TryChunk(""""not json""""));
    }

    // --------------------------------------------------------- frame building

    [Fact]
    public void BuildCombinedPayload_AndTryBuildLayerFrames_RoundTrip()
    {
        var layers = new[]
        {
            new TerrainLayer("Layer 1", "AAAA"),
            new TerrainLayer("Layer 2", "BBBB"),
        };

        var payload = TerrainRequest.BuildCombinedPayload(2048, 1024, layers);

        Assert.Equal(
            """{"width":2048,"height":1024,"layers":[{"name":"Layer 1","data":"AAAA"},{"name":"Layer 2","data":"BBBB"}]}""",
            payload);

        Assert.True(TerrainRequest.TryBuildLayerFrames("nr7", payload, 4096, out var frames));
        Assert.Equal(2, frames.Count);

        Assert.True(TerrainRequest.TryReadChunk(frames[0], out var firstKey, out var first));
        Assert.Equal("nr7", firstKey);
        Assert.Equal(0, first.Index);
        Assert.Equal(2, first.Count);
        Assert.Equal(0, first.Part);
        Assert.Equal(1, first.Parts);
        Assert.Equal("Layer 1", first.Name);
        Assert.Equal("AAAA", first.Data);

        Assert.True(TerrainRequest.TryReadChunk(frames[1], out _, out var second));
        Assert.Equal(1, second.Index);
        Assert.Equal("BBBB", second.Data);
    }

    [Fact]
    public void TryBuildLayerFrames_SplitsALayerIntoParts()
    {
        var layers = new[] { new TerrainLayer("Layer 1", "abcdefgh") };
        var payload = TerrainRequest.BuildCombinedPayload(64, 64, layers);

        Assert.True(TerrainRequest.TryBuildLayerFrames("nr7", payload, 3, out var frames));

        Assert.Equal(3, frames.Count);
        var parts = new List<string>();
        foreach (var frame in frames)
        {
            Assert.True(TerrainRequest.TryReadChunk(frame, out _, out var chunk));
            Assert.Equal(3, chunk.Parts);
            Assert.Equal(1, chunk.Count);
            parts.Add(chunk.Data!);
        }

        Assert.Equal(["abc", "def", "gh"], parts);
    }

    [Fact]
    public void TryBuildLayerFrames_ReturnsFalseForALegacyPayload()
    {
        Assert.False(TerrainRequest.TryBuildLayerFrames("nr7", "H4sIAAAA", 1024, out var stringFrames));
        Assert.Empty(stringFrames);

        Assert.False(TerrainRequest.TryBuildLayerFrames("nr7", """{"width":1}""", 1024, out _));
        Assert.False(TerrainRequest.TryBuildLayerFrames("nr7", """{"width":1,"height":1,"layers":[]}""", 1024, out _));
        Assert.False(TerrainRequest.TryBuildLayerFrames("nr7", """{"width":1,"height":1,"layers":{}}""", 1024, out _));
    }

    private static bool TryChunk(string d, bool withKey = true)
    {
        var frame = withKey ? $$"""{"k":"nr7","d":{{d}}}""" : $$"""{"d":{{d}}}""";
        return TerrainRequest.TryReadChunk(Utf8(frame), out _, out _);
    }

    private static byte[] Utf8(string json) => Encoding.UTF8.GetBytes(json);
}
