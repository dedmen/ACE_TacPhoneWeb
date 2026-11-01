using System.Text.Json;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// Parses the application frames the file cache cares about: the browser's
/// <c>GetFile</c> request and the game's reply.
/// </summary>
/// <remarks>
/// The pin is per host plus normalized path, but the pooled content is shared
/// across hosts by hash.
/// </remarks>
public static class FileRequest
{
    /// <summary>The app name the request must target.</summary>
    public const string App = "main";

    /// <summary>The command the relay intercepts.</summary>
    public const string Command = "GetFile";

    /// <summary>
    /// Parses <c>{"k":"...","d":{"a":"main","c":"GetFile","path":"..."}}</c>.
    /// Returns false for every other command or a malformed frame, so the relay
    /// forwards it untouched.
    /// </summary>
    public static bool TryParse(ReadOnlySpan<byte> payload, out string requestKey, out string path)
    {
        requestKey = string.Empty;
        path = string.Empty;

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

            if (!root.TryGetProperty("d", out var request) || request.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            if (!string.Equals(AppFrameJson.GetString(request, "a"), App, StringComparison.Ordinal) ||
                !string.Equals(AppFrameJson.GetString(request, "c"), Command, StringComparison.Ordinal))
            {
                return false;
            }

            if (AppFrameJson.GetString(request, "path") is not { Length: > 0 } rawPath)
            {
                return false;
            }

            if (!rawPath.EndsWith(".js", StringComparison.OrdinalIgnoreCase) ||
                rawPath.Contains("..", StringComparison.Ordinal))
            {
                return false;
            }

            requestKey = key;
            path = NormalizePath(rawPath);
            return true;
        }
    }

    /// <summary>
    /// Parses the game's reply <c>{"k":"...","d":"..."}</c>. Returns true for any
    /// <c>d</c> so an error reply still clears the pending correlation;
    /// <paramref name="data"/> is set only for a non-empty string. A terrain chunk
    /// (an object with <c>c == ReplyRequestTerrainSVG</c>) is not consumed.
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

            // A terrain chunk is an object too, but it is not a file reply. Keep
            // the pending maps from consuming each other's frames.
            if (value.ValueKind == JsonValueKind.Object &&
                string.Equals(
                    AppFrameJson.GetString(value, "c"),
                    TerrainRequest.ReplyCommand,
                    StringComparison.Ordinal))
            {
                return false;
            }

            requestKey = key;
            data = value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } text
                ? text
                : null;
            return true;
        }
    }

    /// <summary>Builds the cache-hit reply <c>{"k":"&lt;k&gt;","d":"&lt;payload&gt;"}</c>.</summary>
    public static byte[] BuildReply(string requestKey, string payload) => AppReply.Build(requestKey, payload);

    /// <summary>Normalizes a file path the same way the cache does.</summary>
    public static string NormalizePath(string path) => FileCache.NormalizePath(path);
}
