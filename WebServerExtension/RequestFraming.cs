using System.Text.Json.Nodes;

namespace ArmaServerSide
{
    /// <summary>
    /// Adds the sender connection id to a client request as the <c>s</c> property,
    /// instead of splicing into the raw string (which broke on empty frames, BOMs
    /// and arrays). Shared by the LAN and relay transports.
    /// </summary>
    internal static class RequestFraming
    {
        internal static string? InjectSender(string messageJson, string connectionId)
        {
            try
            {
                if (JsonNode.Parse(messageJson) is not JsonObject request)
                    return null;

                request["s"] = connectionId;
                return request.ToJsonString();
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}
