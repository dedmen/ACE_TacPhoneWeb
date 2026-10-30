using System.Text;
using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Protocol;

/// <summary>
/// The game-side binary envelope:
/// <code>0x01 | peerIdLen (u8) | peerId (ASCII) | application JSON (UTF-8)</code>.
/// Browsers never see the envelope; the server adds/strips it.
/// </summary>
public static class FrameCodec
{
    /// <summary>Envelope version byte.</summary>
    public const byte EnvelopeVersion = 0x01;

    /// <summary>Upper bound for the peer id portion of an envelope.</summary>
    public const int MaxPeerIdBytes = 64;

    /// <summary>
    /// Wraps <paramref name="payload"/> for the game socket.
    /// </summary>
    public static byte[] EncodeGameFrame(string peerId, ReadOnlySpan<byte> payload)
    {
        ArgumentException.ThrowIfNullOrEmpty(peerId);

        var peerIdBytes = Encoding.ASCII.GetBytes(peerId);
        if (peerIdBytes.Length is 0 or > MaxPeerIdBytes)
        {
            throw new ArgumentException($"Peer id must be 1..{MaxPeerIdBytes} ASCII bytes.", nameof(peerId));
        }

        var frame = new byte[2 + peerIdBytes.Length + payload.Length];
        frame[0] = EnvelopeVersion;
        frame[1] = (byte)peerIdBytes.Length;
        peerIdBytes.CopyTo(frame, 2);
        payload.CopyTo(frame.AsSpan(2 + peerIdBytes.Length));
        return frame;
    }

    /// <summary>
    /// Parses a binary game frame. Returns <c>false</c> for a wrong version, a
    /// truncated frame, a non-printable peer id or an empty payload.
    /// </summary>
    public static bool TryDecodeGameFrame(
        ReadOnlySpan<byte> frame,
        out string peerId,
        out ReadOnlyMemory<byte> payload)
    {
        peerId = string.Empty;
        payload = ReadOnlyMemory<byte>.Empty;

        if (frame.Length < 3 || frame[0] != EnvelopeVersion)
        {
            return false;
        }

        var peerIdLength = frame[1];
        if (peerIdLength is 0 or > MaxPeerIdBytes)
        {
            return false;
        }

        if (frame.Length < 2 + peerIdLength)
        {
            return false;
        }

        var peerIdBytes = frame.Slice(2, peerIdLength);
        foreach (var b in peerIdBytes)
        {
            if (b is < 0x20 or > 0x7E)
            {
                return false;
            }
        }

        var payloadBytes = frame[(2 + peerIdLength)..];
        if (payloadBytes.Length == 0)
        {
            return false;
        }

        peerId = Encoding.ASCII.GetString(peerIdBytes);
        if (!CrockfordBase32.IsPeerId(peerId))
        {
            return false;
        }

        // Copy so the caller can hold on to the payload after the receive buffer is reused.
        payload = payloadBytes.ToArray();
        return true;
    }

    /// <summary>
    /// Parses the text-only game form <c>&lt;peerId&gt;\n&lt;application JSON&gt;</c>
    /// used by the future SQF-native client.
    /// </summary>
    public static bool TryDecodeTextGameFrame(string text, out string peerId, out string payload)
    {
        peerId = string.Empty;
        payload = string.Empty;

        if (string.IsNullOrEmpty(text))
        {
            return false;
        }

        var newline = text.IndexOf('\n');
        if (newline <= 0 || newline == text.Length - 1)
        {
            return false;
        }

        var candidate = text[..newline].TrimEnd('\r').Trim();
        if (!CrockfordBase32.IsPeerId(candidate))
        {
            return false;
        }

        peerId = candidate;
        payload = text[(newline + 1)..];
        return payload.Length > 0;
    }
}
