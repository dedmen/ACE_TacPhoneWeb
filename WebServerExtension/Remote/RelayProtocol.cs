using System.Text;
using System.Text.Json.Nodes;

namespace ArmaServerSide.Remote
{
    /// <summary>
    /// Small codec shared by the relay client and (conceptually) the relay server.
    ///
    /// Control frames are text JSON with a <c>t</c> property. Application frames
    /// are binary: <c>0x01 | peerIdLen (u8) | peerId (ASCII) | application JSON</c>.
    /// </summary>
    internal static class RelayProtocol
    {
        public const int Proto = 1;

        const byte DataFrameTag = 0x01;

        public static JsonObject? ParseObject(string text)
        {
            try
            {
                return JsonNode.Parse(text) as JsonObject;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static string String(this JsonObject? obj, string name)
            => obj?[name]?.GetValue<string>() ?? string.Empty;

        public static int Int(this JsonObject? obj, string name)
        {
            var node = obj?[name];
            if (node is null) return 0;
            try { return node.GetValue<int>(); }
            catch (Exception) { return 0; }
        }

        public static byte[] EncodeDataFrame(string peerId, string payload)
        {
            var idBytes = Encoding.ASCII.GetBytes(peerId);
            if (idBytes.Length > byte.MaxValue)
                throw new ArgumentException("Peer id is too long for the data frame envelope.", nameof(peerId));

            var payloadBytes = Encoding.UTF8.GetBytes(payload);
            var frame = new byte[2 + idBytes.Length + payloadBytes.Length];
            frame[0] = DataFrameTag;
            frame[1] = (byte)idBytes.Length;
            idBytes.CopyTo(frame, 2);
            payloadBytes.CopyTo(frame, 2 + idBytes.Length);
            return frame;
        }

        public static bool TryDecodeDataFrame(ReadOnlySpan<byte> frame, out string peerId, out string payload)
        {
            peerId = string.Empty;
            payload = string.Empty;

            if (frame.Length < 2 || frame[0] != DataFrameTag)
                return false;

            var idLength = frame[1];
            if (frame.Length < 2 + idLength)
                return false;

            peerId = Encoding.ASCII.GetString(frame.Slice(2, idLength));
            payload = Encoding.UTF8.GetString(frame.Slice(2 + idLength));
            return true;
        }

        /// <summary>
        /// Text variant used by a native SQF client: <c>peerId\napplication JSON</c>.
        /// Accepted defensively so the relay can translate either way.
        /// </summary>
        public static bool TryDecodeTextDataFrame(string text, out string peerId, out string payload)
        {
            peerId = string.Empty;
            payload = string.Empty;

            var separator = text.IndexOf('\n');
            if (separator <= 0 || separator == text.Length - 1)
                return false;

            peerId = text[..separator];
            payload = text[(separator + 1)..];
            return true;
        }
    }
}
