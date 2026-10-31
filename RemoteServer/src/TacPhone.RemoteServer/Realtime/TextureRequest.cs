using System.Text.Json;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// Parses the application frames the texture cache cares about: the browser's
/// <c>RequestTexture</c> request and the game's single-string reply.
/// </summary>
/// <remarks>
/// The cache key is independent of the game host: a texture is assumed to be
/// stable for a given normalized file path and requested <c>maxSize</c>.
/// </remarks>
public static class TextureRequest
{
    /// <summary>The app name the request must target.</summary>
    public const string App = "main";

    /// <summary>The command the relay intercepts.</summary>
    public const string Command = "RequestTexture";

    /// <summary>Largest accepted <c>maxSize</c>; larger values are malformed.</summary>
    public const int MaxMaxSize = 16384;

    /// <summary>
    /// Parses <c>{"k":"...","d":{"a":"main","c":"RequestTexture","path":"...","maxSize":N}}</c>.
    /// Returns false for every other command or a malformed frame, so the relay
    /// forwards it untouched.
    /// </summary>
    public static bool TryParse(ReadOnlySpan<byte> payload, out string requestKey, out string cacheKey)
    {
        requestKey = string.Empty;
        cacheKey = string.Empty;

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

            if (AppFrameJson.GetString(request, "path") is not { Length: > 0 } path)
            {
                return false;
            }

            var maxSize = AppFrameJson.GetInt(request, "maxSize");
            if (maxSize is null or <= 0 or > MaxMaxSize)
            {
                return false;
            }

            requestKey = key;
            cacheKey = ComputeCacheKey(path, maxSize.Value);
            return true;
        }
    }

    /// <summary>
    /// Normalizes a texture path the same way the game does and appends
    /// <paramref name="maxSize"/>: <c>\a\b.paa</c>, <c>a/b.paa</c> and
    /// <c>A\B.PAA</c> share one entry.
    /// </summary>
    public static string ComputeCacheKey(string path, int maxSize)
    {
        ArgumentException.ThrowIfNullOrEmpty(path);

        var normalized = path.Replace('/', '\\').TrimStart('\\').ToLowerInvariant();
        return normalized + "\u0000" + maxSize;
    }

    /// <summary>
    /// Parses the game's reply <c>{"k":"...","d":"..."}</c>. Returns true for any
    /// <c>d</c> so an error reply still clears the pending correlation;
    /// <paramref name="data"/> is set only for a non-empty string.
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

            // A terrain chunk is an object too, but it is not a texture error reply.
            // Keep the two pending maps from consuming each other's frames.
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
}
