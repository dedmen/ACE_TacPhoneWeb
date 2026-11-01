using System.Text;
using System.Text.Json;
using TacPhone.RemoteServer.Realtime;

namespace TacPhone.RemoteServer.Tests.Realtime;

public sealed class FileRequestTests
{
    private const string RequestJson = """
        {"k":"nr8","d":{"a":"main","c":"GetFile","path":"a/b.js"}}
        """;

    [Fact]
    public void TryParse_AcceptsAValidRequest()
    {
        Assert.True(FileRequest.TryParse(Utf8(RequestJson), out var requestKey, out var path));

        Assert.Equal("nr8", requestKey);
        Assert.Equal(@"a\b.js", path);
    }

    [Fact]
    public void NormalizePath_MatchesTheCacheConvention()
    {
        Assert.Equal(@"a\b.js", FileRequest.NormalizePath(@"\a\b.js"));
        Assert.Equal(@"a\b.js", FileRequest.NormalizePath("a/b.js"));
        Assert.Equal(@"a\b.js", FileRequest.NormalizePath(@"A\B.JS"));
    }

    [Fact]
    public void TryParse_RejectsNonJavaScriptPaths()
    {
        Assert.False(TryParse("""{"a":"main","c":"GetFile","path":"a/b.paa"}"""));
        Assert.False(TryParse("""{"a":"main","c":"GetFile","path":"a/b.json"}"""));
        Assert.False(TryParse("""{"a":"main","c":"GetFile","path":""}"""));
        Assert.False(TryParse("""{"a":"main","c":"GetFile"}"""));
        Assert.False(TryParse("""{"a":"main","c":"GetFile","path":42}"""));
    }

    [Fact]
    public void TryParse_RejectsTraversalPaths()
    {
        Assert.False(TryParse("""{"a":"main","c":"GetFile","path":"../a.js"}"""));
        Assert.False(TryParse("""{"a":"main","c":"GetFile","path":"a/../b.js"}"""));
    }

    [Fact]
    public void TryParse_RejectsAnotherCommandOrApp()
    {
        Assert.False(TryParse("""{"a":"main","c":"RequestTexture","path":"a/b.js"}"""));
        Assert.False(TryParse("""{"a":"map","c":"GetFile","path":"a/b.js"}"""));
    }

    [Fact]
    public void TryParse_RejectsMalformedFrames()
    {
        Assert.False(FileRequest.TryParse(ReadOnlySpan<byte>.Empty, out _, out _));
        Assert.False(FileRequest.TryParse(Utf8("not json"), out _, out _));
        Assert.False(FileRequest.TryParse(Utf8("[]"), out _, out _));
        Assert.False(FileRequest.TryParse(Utf8("""{"k":"nr8","d":"GetFile"}"""), out _, out _));
        Assert.False(FileRequest.TryParse(Utf8("""{"d":{"a":"main","c":"GetFile","path":"a.js"}}"""), out _, out _));
        Assert.False(FileRequest.TryParse(Utf8(RequestJson + "{}"), out _, out _));
    }

    [Fact]
    public void TryReadReply_ExtractsANonEmptyString()
    {
        Assert.True(FileRequest.TryReadReply(Utf8("""{"k":"nr8","d":"console.log(1);"}"""), out var requestKey, out var data));

        Assert.Equal("nr8", requestKey);
        Assert.Equal("console.log(1);", data);
    }

    [Fact]
    public void TryReadReply_ClearsTheKeyWithoutDataForAnErrorReply()
    {
        Assert.True(FileRequest.TryReadReply(
            Utf8("""{"k":"nr8","d":{"ok":false,"error":"missing"}}"""), out var objectKey, out var objectData));
        Assert.Equal("nr8", objectKey);
        Assert.Null(objectData);

        Assert.True(FileRequest.TryReadReply(Utf8("""{"k":"nr8","d":""}"""), out var emptyKey, out var empty));
        Assert.Equal("nr8", emptyKey);
        Assert.Null(empty);

        Assert.True(FileRequest.TryReadReply(Utf8("""{"k":"nr8","d":42}"""), out _, out var numeric));
        Assert.Null(numeric);
    }

    [Fact]
    public void TryReadReply_RejectsMissingKeyOrD()
    {
        Assert.False(FileRequest.TryReadReply(Utf8("""{"d":"payload"}"""), out _, out _));
        Assert.False(FileRequest.TryReadReply(Utf8("""{"k":7,"d":"payload"}"""), out _, out _));
        Assert.False(FileRequest.TryReadReply(Utf8("""{"k":"nr8"}"""), out _, out _));
        Assert.False(FileRequest.TryReadReply(ReadOnlySpan<byte>.Empty, out _, out _));
    }

    [Fact]
    public void TryReadReply_RejectsATerrainChunkObject()
    {
        Assert.False(FileRequest.TryReadReply(
            Utf8("""{"k":"nr8","d":{"a":"main","c":"ReplyRequestTerrainSVG","index":0,"count":1,"part":0,"parts":1,"width":1,"height":1,"data":"x"}}"""),
            out _,
            out _));
    }

    [Fact]
    public void BuildReply_WritesTheRequestKeyAndPayload()
    {
        var reply = FileRequest.BuildReply("nr8", "console.log(\"quoted\");");

        using var document = JsonDocument.Parse(reply);
        Assert.Equal("nr8", document.RootElement.GetProperty("k").GetString());
        Assert.Equal("console.log(\"quoted\");", document.RootElement.GetProperty("d").GetString());
        Assert.Equal(2, document.RootElement.EnumerateObject().Count());
    }

    private static bool TryParse(string d) =>
        FileRequest.TryParse(Utf8($$"""{"k":"nr8","d":{{d}}}"""), out _, out _);

    private static byte[] Utf8(string json) => Encoding.UTF8.GetBytes(json);
}
