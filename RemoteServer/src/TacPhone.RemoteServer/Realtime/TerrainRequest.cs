using System.Text;
using System.Text.Json;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// Parses the two application frames the terrain cache cares about: the browser's
/// <c>RequestTerrainSVG</c> request and the game's reply. Both are plain
/// <c>{k, d}</c> frames over the existing protocol; nothing about the wire format
/// changes.
/// </summary>
public static class TerrainRequest
{
    /// <summary>The app name the request must target.</summary>
    public const string App = "main";

    /// <summary>The command the relay intercepts.</summary>
    public const string Command = "RequestTerrainSVG";

    /// <summary>The command of a chunked terrain reply.</summary>
    public const string ReplyCommand = "ReplyRequestTerrainSVG";

    /// <summary>Upper bound for <c>count</c> and <c>parts</c>; larger values are malformed.</summary>
    public const int MaxChunks = 64;

    /// <summary>Maximum base64 characters per emitted layer part.</summary>
    public const int MaxTerrainChunkChars = 6 * 1024 * 1024;

    /// <summary>
    /// Parses <c>{"k":"...","d":{"a":"main","c":"RequestTerrainSVG","config":{...}}}</c>.
    /// Returns false for every other command or a malformed frame, so the relay
    /// forwards it untouched.
    /// </summary>
    public static bool TryParse(ReadOnlySpan<byte> payload, out string requestKey, out string configHash)
    {
        requestKey = string.Empty;
        configHash = string.Empty;

        if (!AppFrameJson.TryParseObject(payload, out var document))
        {
            return false;
        }

        using (document)
        {
            return TryParse(document.RootElement, out requestKey, out configHash);
        }
    }

    /// <summary>Request checks for an already parsed frame.</summary>
    public static bool TryParse(JsonElement root, out string requestKey, out string configHash)
    {
        requestKey = string.Empty;
        configHash = string.Empty;

        if (AppFrameJson.GetString(root, "k") is not { Length: > 0 } key)
        {
            return false;
        }

        if (!root.TryGetProperty("d", out var request) || request.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!string.Equals(AppFrameJson.GetString(request, "a"), App, StringComparison.Ordinal) ||
            !string.Equals(AppFrameJson.GetString(request, "c"), Command, StringComparison.Ordinal))
        {
            return false;
        }

        if (!request.TryGetProperty("config", out var config) || config.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var computed = TerrainCache.ComputeConfigHash(config);
        if (computed is null)
        {
            return false;
        }

        requestKey = key;
        configHash = computed;
        return true;
    }

    /// <summary>
    /// Parses the game's reply <c>{"k":"...","d":"..."}</c>. Only a string payload
    /// counts: errors and objects are never cached. A frame without a string
    /// <c>k</c> is ignored.
    /// </summary>
    public static bool TryReadReply(ReadOnlySpan<byte> payload, out string requestKey, out string? data)
    {
        requestKey = string.Empty;
        data = null;

        if (!AppFrameJson.TryParseObject(payload, out var document))
        {
            return false;
        }

        using (document)
        {
            var root = document.RootElement;

            if (AppFrameJson.GetString(root, "k") is not { Length: > 0 } key)
            {
                return false;
            }

            if (!root.TryGetProperty("d", out var value))
            {
                return false;
            }

            requestKey = key;
            data = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            return true;
        }
    }

    /// <summary>Builds the cache-hit reply <c>{"k":"&lt;k&gt;","d":"&lt;payload&gt;"}</c>.</summary>
    public static byte[] BuildReply(string requestKey, string payload) => AppReply.Build(requestKey, payload);

    /// <summary>
    /// Parses one chunk frame of a chunked terrain reply. A chunk either carries a
    /// non-empty <c>data</c> string plus the layer indices, or a non-empty
    /// <c>error</c> string. Bounds are validated here so an assembly cannot be
    /// driven past <c>count</c>/<c>parts</c> = 64.
    /// </summary>
    public static bool TryReadChunk(
        ReadOnlySpan<byte> payload,
        out string requestKey,
        out TerrainChunk chunk)
    {
        requestKey = string.Empty;
        chunk = default;

        if (!AppFrameJson.TryParseObject(payload, out var document))
        {
            return false;
        }

        using (document)
        {
            var root = document.RootElement;

            if (AppFrameJson.GetString(root, "k") is not { Length: > 0 } key)
            {
                return false;
            }

            if (!root.TryGetProperty("d", out var reply) || reply.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            if (!string.Equals(AppFrameJson.GetString(reply, "c"), ReplyCommand, StringComparison.Ordinal))
            {
                return false;
            }

            if (AppFrameJson.GetString(reply, "error") is { Length: > 0 } error)
            {
                requestKey = key;
                chunk = new TerrainChunk(0, 1, 0, 1, 0, 0, string.Empty, null, error);
                return true;
            }

            if (AppFrameJson.GetString(reply, "data") is not { Length: > 0 } data)
            {
                return false;
            }

            var index = AppFrameJson.GetInt(reply, "index");
            var count = AppFrameJson.GetInt(reply, "count");
            if (index is null or < 0 || count is null or < 1 or > MaxChunks || index >= count)
            {
                return false;
            }

            var part = AppFrameJson.GetInt(reply, "part") ?? 0;
            var parts = AppFrameJson.GetInt(reply, "parts") ?? 1;
            if (part < 0 || parts < 1 || parts > MaxChunks || part >= parts)
            {
                return false;
            }

            var width = AppFrameJson.GetInt(reply, "width");
            var height = AppFrameJson.GetInt(reply, "height");
            if (width is null or <= 0 || height is null or <= 0)
            {
                return false;
            }

            var name = AppFrameJson.GetString(reply, "name");
            requestKey = key;
            chunk = new TerrainChunk(
                index.Value,
                count.Value,
                part,
                parts,
                width.Value,
                height.Value,
                string.IsNullOrEmpty(name) ? $"Layer {index.Value + 1}" : name,
                data,
                null);
            return true;
        }
    }

    /// <summary>
    /// Canonical cache entry for a chunked transfer:
    /// <c>{"width":W,"height":H,"layers":[{"name":"...","data":"..."}]}</c>.
    /// </summary>
    public static string BuildCombinedPayload(int width, int height, IReadOnlyList<TerrainLayer> layers)
    {
        ArgumentNullException.ThrowIfNull(layers);

        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("width", width);
            writer.WriteNumber("height", height);
            writer.WriteStartArray("layers");

            foreach (var layer in layers)
            {
                writer.WriteStartObject();
                writer.WriteString("name", layer.Name);
                writer.WriteString("data", layer.Data);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>
    /// Splits a combined payload back into layer frames for a cache hit. Returns
    /// false when <paramref name="payload"/> is not a combined payload (for
    /// example a legacy whole-SVG string), so the caller can emit the old single
    /// frame instead.
    /// </summary>
    public static bool TryBuildLayerFrames(
        string requestKey,
        string payload,
        int maxChars,
        out IReadOnlyList<byte[]> frames)
    {
        frames = Array.Empty<byte[]>();

        if (string.IsNullOrEmpty(requestKey) ||
            string.IsNullOrEmpty(payload) ||
            payload[0] != '{')
        {
            return false;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(payload);
        }
        catch (JsonException)
        {
            return false;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("width", out var widthElement) ||
                !widthElement.TryGetInt32(out var width) ||
                width <= 0 ||
                !root.TryGetProperty("height", out var heightElement) ||
                !heightElement.TryGetInt32(out var height) ||
                height <= 0 ||
                !root.TryGetProperty("layers", out var layersElement) ||
                layersElement.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            var layers = new List<TerrainLayer>();
            foreach (var layer in layersElement.EnumerateArray())
            {
                if (layer.ValueKind != JsonValueKind.Object ||
                    AppFrameJson.GetString(layer, "name") is not { } name ||
                    AppFrameJson.GetString(layer, "data") is not { } data ||
                    data.Length == 0 ||
                    layers.Count >= MaxChunks)
                {
                    return false;
                }

                layers.Add(new TerrainLayer(name, data));
            }

            if (layers.Count == 0)
            {
                return false;
            }

            frames = BuildLayerFrames(requestKey, width, height, layers, maxChars);
            return true;
        }
    }

    /// <summary>Builds one frame per layer part, in index/part order.</summary>
    public static IReadOnlyList<byte[]> BuildLayerFrames(
        string requestKey,
        int width,
        int height,
        IReadOnlyList<TerrainLayer> layers,
        int maxChars)
    {
        ArgumentException.ThrowIfNullOrEmpty(requestKey);
        ArgumentNullException.ThrowIfNull(layers);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxChars, 1);

        var frames = new List<byte[]>();
        var count = layers.Count;

        for (var index = 0; index < count; index++)
        {
            var layer = layers[index];
            var parts = SplitBase64(layer.Data, maxChars);

            for (var part = 0; part < parts.Count; part++)
            {
                frames.Add(BuildChunkFrame(
                    requestKey,
                    index,
                    count,
                    part,
                    parts.Count,
                    width,
                    height,
                    layer.Name,
                    parts[part],
                    last: index == count - 1 && part == parts.Count - 1));
            }
        }

        return frames;
    }

    /// <summary>Builds frames from a completed payload.</summary>
    public static IReadOnlyList<byte[]> BuildLayerFrames(
        string requestKey,
        TerrainPayload payload,
        int maxChars)
    {
        ArgumentNullException.ThrowIfNull(payload);
        return BuildLayerFrames(requestKey, payload.Width, payload.Height, payload.Layers, maxChars);
    }

    private static List<string> SplitBase64(string data, int maxChars)
    {
        if (data.Length == 0)
        {
            return [string.Empty];
        }

        var parts = new List<string>((data.Length / maxChars) + 1);
        for (var offset = 0; offset < data.Length; offset += maxChars)
        {
            parts.Add(data.Substring(offset, Math.Min(maxChars, data.Length - offset)));
        }

        return parts;
    }

    private static byte[] BuildChunkFrame(
        string requestKey,
        int index,
        int count,
        int part,
        int parts,
        int width,
        int height,
        string name,
        string data,
        bool last)
    {
        using var buffer = new MemoryStream(data.Length + 256);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("k", requestKey);
            writer.WriteStartObject("d");
            writer.WriteString("a", App);
            writer.WriteString("c", ReplyCommand);
            writer.WriteNumber("index", index);
            writer.WriteNumber("count", count);
            writer.WriteNumber("part", part);
            writer.WriteNumber("parts", parts);
            writer.WriteString("name", name);
            writer.WriteNumber("width", width);
            writer.WriteNumber("height", height);
            writer.WriteString("data", data);
            writer.WriteBoolean("last", last);
            writer.WriteEndObject();
            writer.WriteEndObject();
        }

        return buffer.ToArray();
    }
}
