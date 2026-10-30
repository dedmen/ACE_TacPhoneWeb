using System.Net.WebSockets;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>One complete inbound WebSocket message.</summary>
public readonly record struct ReceivedFrame(
    WebSocketMessageType Type,
    byte[] Payload,
    bool TooLarge,
    bool Closed)
{
    public static ReceivedFrame Close() => new(WebSocketMessageType.Close, [], false, true);

    public static ReceivedFrame Oversized(WebSocketMessageType type) => new(type, [], true, false);
}

/// <summary>
/// Reads whole WebSocket messages with a hard size cap. A message over the cap
/// is reported as <see cref="ReceivedFrame.TooLarge"/> instead of being buffered:
/// the caller closes that peer, which is the documented behaviour for oversized
/// frames and keeps one huge frame from taking the server down.
/// </summary>
public sealed class RelayFrameReader
{
    private const int ChunkSize = 16 * 1024;

    private readonly WebSocket _socket;
    private readonly int _maxBytes;
    private readonly byte[] _chunk = new byte[ChunkSize];

    public RelayFrameReader(WebSocket socket, int maxBytes)
    {
        ArgumentNullException.ThrowIfNull(socket);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxBytes);
        _socket = socket;
        _maxBytes = maxBytes;
    }

    public int MaxBytes => _maxBytes;

    public async ValueTask<ReceivedFrame> ReceiveAsync(CancellationToken cancellationToken)
    {
        var accumulator = new byte[Math.Min(_maxBytes, ChunkSize)];
        var total = 0;

        while (true)
        {
            var result = await _socket.ReceiveAsync(_chunk.AsMemory(), cancellationToken).ConfigureAwait(false);

            if (result.MessageType == WebSocketMessageType.Close)
            {
                return ReceivedFrame.Close();
            }

            var needed = total + result.Count;
            if (needed > _maxBytes)
            {
                return ReceivedFrame.Oversized(result.MessageType);
            }

            if (needed > accumulator.Length)
            {
                var size = (int)Math.Min(_maxBytes, Math.Max((long)needed, accumulator.Length * 2L));
                Array.Resize(ref accumulator, size);
            }

            if (result.Count > 0)
            {
                Buffer.BlockCopy(_chunk, 0, accumulator, total, result.Count);
                total = needed;
            }

            if (!result.EndOfMessage)
            {
                continue;
            }

            var payload = new byte[total];
            Buffer.BlockCopy(accumulator, 0, payload, 0, total);
            return new ReceivedFrame(result.MessageType, payload, false, false);
        }
    }
}
