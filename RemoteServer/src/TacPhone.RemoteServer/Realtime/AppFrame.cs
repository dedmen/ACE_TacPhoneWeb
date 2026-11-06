using System.Text.Json;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>A <c>{"k":"...","d":"..."}</c> application reply frame.</summary>
internal static class AppReply
{
    public static byte[] Build(string requestKey, string payload)
    {
        ArgumentException.ThrowIfNullOrEmpty(requestKey);
        ArgumentNullException.ThrowIfNull(payload);

        using var buffer = new MemoryStream(payload.Length + requestKey.Length + 16);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("k", requestKey);
            writer.WriteString("d", payload);
            writer.WriteEndObject();
        }

        return buffer.ToArray();
    }
}

/// <summary>
/// Small parsers shared by the relay endpoint, the terrain request and the
/// texture and file frame readers.
/// </summary>
internal static class AppFrameJson
{
    /// <summary>
    /// Parses the frame buffer into a JSON object document. Works directly on
    /// the frame bytes, so no copy is made for the (rare) frames the relay has
    /// to look into. Exactly one value per frame; trailing data is not a
    /// protocol frame.
    /// </summary>
    public static bool TryParseObject(ReadOnlySpan<byte> payload, out JsonDocument document)
    {
        document = null!;

        if (payload.IsEmpty)
        {
            return false;
        }

        try
        {
            var reader = new Utf8JsonReader(payload, isFinalBlock: true, state: default);
            var parsed = JsonDocument.ParseValue(ref reader);

            if (parsed.RootElement.ValueKind != JsonValueKind.Object)
            {
                parsed.Dispose();
                return false;
            }

            if (reader.Read())
            {
                parsed.Dispose();
                return false;
            }

            document = parsed;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>
    /// Parses a control frame string into a JSON object document. The fast path
    /// rejects anything that does not start with '<c>{</c>' before touching the
    /// parser.
    /// </summary>
    public static bool TryParseObject(string json, out JsonDocument document)
    {
        document = null!;

        if (string.IsNullOrEmpty(json) || json[0] != '{')
        {
            return false;
        }

        try
        {
            var parsed = JsonDocument.Parse(json);
            if (parsed.RootElement.ValueKind == JsonValueKind.Object)
            {
                document = parsed;
                return true;
            }

            parsed.Dispose();
        }
        catch (JsonException)
        {
            // Not a control frame.
        }

        return false;
    }

    public static string? GetString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    public static int? GetInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt32(out var number)
            ? number
            : null;
}
