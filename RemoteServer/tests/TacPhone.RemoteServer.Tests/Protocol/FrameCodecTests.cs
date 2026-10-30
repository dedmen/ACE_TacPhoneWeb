using System.Text;
using TacPhone.RemoteServer.Infrastructure;
using TacPhone.RemoteServer.Protocol;

namespace TacPhone.RemoteServer.Tests.Protocol;

public sealed class FrameCodecTests
{
    private static string NewPeerId() =>
        "p_" + CrockfordBase32.Random(CrockfordBase32.PeerIdLength);

    [Fact]
    public void EncodeGameFrame_WritesTheDocumentedEnvelope()
    {
        var peerId = NewPeerId();
        var payload = Encoding.UTF8.GetBytes("{\"a\":1}");
        var peerIdBytes = Encoding.ASCII.GetBytes(peerId);

        var frame = FrameCodec.EncodeGameFrame(peerId, payload);

        Assert.Equal(FrameCodec.EnvelopeVersion, frame[0]);
        Assert.Equal(1, frame[0]);
        Assert.Equal(peerIdBytes.Length, frame[1]);
        Assert.Equal(peerIdBytes.Length + payload.Length + 2, frame.Length);
        Assert.Equal(peerIdBytes, frame.AsSpan(2, peerIdBytes.Length).ToArray());
        Assert.Equal(payload, frame.AsSpan(2 + peerIdBytes.Length).ToArray());
    }

    [Fact]
    public void TryDecodeGameFrame_RoundTripsNonAsciiPayload()
    {
        var peerId = NewPeerId();
        var payload = Encoding.UTF8.GetBytes("{\"greeting\":\"héllo wörld\",\"emoji\":\"🙂\"}");

        var frame = FrameCodec.EncodeGameFrame(peerId, payload);

        Assert.True(FrameCodec.TryDecodeGameFrame(frame, out var decodedPeerId, out var decodedPayload));
        Assert.Equal(peerId, decodedPeerId);
        Assert.Equal(payload, decodedPayload.ToArray());
    }

    [Fact]
    public void TryDecodeGameFrame_RejectsEmptyFrame()
    {
        Assert.False(FrameCodec.TryDecodeGameFrame(ReadOnlySpan<byte>.Empty, out _, out _));
    }

    [Fact]
    public void TryDecodeGameFrame_RejectsWrongVersion()
    {
        var frame = FrameCodec.EncodeGameFrame(NewPeerId(), Encoding.UTF8.GetBytes("{}"));
        frame[0] = 0x02;

        Assert.False(FrameCodec.TryDecodeGameFrame(frame, out _, out _));
    }

    [Fact]
    public void TryDecodeGameFrame_RejectsTruncatedPeerId()
    {
        var peerId = NewPeerId();
        var full = FrameCodec.EncodeGameFrame(peerId, Encoding.UTF8.GetBytes("{}"));
        var truncated = full.AsSpan(0, 5).ToArray();

        Assert.False(FrameCodec.TryDecodeGameFrame(truncated, out _, out _));
    }

    [Fact]
    public void TryDecodeGameFrame_RejectsNonPrintablePeerId()
    {
        var frame = new byte[]
        {
            FrameCodec.EnvelopeVersion,
            4,
            (byte)'p',
            (byte)'_',
            0x07,
            (byte)'A',
            (byte)'{',
            (byte)'}',
        };

        Assert.False(FrameCodec.TryDecodeGameFrame(frame, out _, out _));
    }

    [Fact]
    public void TryDecodeGameFrame_RejectsIdThatIsNotPeerIdShaped()
    {
        var frame = FrameCodec.EncodeGameFrame("bogus", Encoding.UTF8.GetBytes("{\"a\":1}"));

        Assert.False(FrameCodec.TryDecodeGameFrame(frame, out _, out _));
    }

    [Fact]
    public void TryDecodeGameFrame_RejectsEmptyPayload()
    {
        var frame = FrameCodec.EncodeGameFrame(NewPeerId(), ReadOnlySpan<byte>.Empty);

        Assert.False(FrameCodec.TryDecodeGameFrame(frame, out _, out _));
    }

    [Fact]
    public void EncodeGameFrame_RejectsEmptyAndOversizedPeerIds()
    {
        Assert.Throws<ArgumentException>(() => FrameCodec.EncodeGameFrame(string.Empty, new byte[] { 1 }));
        Assert.Throws<ArgumentException>(() =>
            FrameCodec.EncodeGameFrame(new string('a', FrameCodec.MaxPeerIdBytes + 1), new byte[] { 1 }));
    }

    [Fact]
    public void TryDecodeTextGameFrame_RoundTrips()
    {
        var peerId = NewPeerId();
        var text = peerId + "\n{\"a\":1}";

        Assert.True(FrameCodec.TryDecodeTextGameFrame(text, out var decodedPeerId, out var payload));
        Assert.Equal(peerId, decodedPeerId);
        Assert.Equal("{\"a\":1}", payload);
    }

    [Fact]
    public void TryDecodeTextGameFrame_AcceptsCarriageReturnBeforeTheNewline()
    {
        var peerId = NewPeerId();

        Assert.True(FrameCodec.TryDecodeTextGameFrame(peerId + "\r\n{}", out var decodedPeerId, out var payload));
        Assert.Equal(peerId, decodedPeerId);
        Assert.Equal("{}", payload);
    }

    [Theory]
    [InlineData("")]
    [InlineData("no newline here")]
    [InlineData("p_0123456789AB\n")]              // newline at the end, no payload
    [InlineData("bogus\n{\"a\":1}")]              // not a peer id
    [InlineData("random id\n{\"a\":1}")]          // not a peer id
    [InlineData("\n{\"a\":1}")]                   // empty peer id
    public void TryDecodeTextGameFrame_RejectsMalformedText(string text)
    {
        Assert.False(FrameCodec.TryDecodeTextGameFrame(text, out _, out _));
    }
}
