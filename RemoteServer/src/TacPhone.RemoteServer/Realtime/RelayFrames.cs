using System.Text.Json;
using System.Text.RegularExpressions;
using TacPhone.RemoteServer.Protocol;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// RelayEndpoint partial: control-frame parsing. Everything shared (object
/// parsing, property getters) comes from <see cref="AppFrameJson"/>.
/// </summary>
public sealed partial class RelayEndpoint
{
    /// <summary>Redacts credential values when a bad frame is logged.</summary>
    private static readonly Regex SensitiveJsonValue = new(
        "\"(secret|hostSecret|deviceToken|code|share|password)\"\\s*:\\s*\"[^\"]*\"",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static bool TryGetControlType(string text, out string controlType)
    {
        controlType = string.Empty;

        if (!AppFrameJson.TryParseObject(text, out var document))
        {
            return false;
        }

        using (document)
        {
            var value = AppFrameJson.GetString(document.RootElement, "t");
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            controlType = value;
            return true;
        }
    }

    /// <summary>
    /// A short, redacted preview for a bad frame log. Control frames can carry
    /// secrets (a malformed auth), so values of known credential fields are hidden.
    /// </summary>
    private static string PreviewFrame(string text, int max = 512)
    {
        if (string.IsNullOrEmpty(text))
        {
            return "(empty)";
        }

        var redacted = SensitiveJsonValue.Replace(text, "\"$1\":\"<redacted>\"");
        return redacted.Length <= max
            ? redacted
            : redacted[..max] + $"… ({redacted.Length} chars)";
    }

    private static FirstFrame? ParseFirstFrame(string json)
    {
        if (!AppFrameJson.TryParseObject(json, out var document))
        {
            return null;
        }

        using (document)
        {
            var root = document.RootElement;
            var type = AppFrameJson.GetString(root, "t");
            if (string.IsNullOrEmpty(type))
            {
                return null;
            }

            return new FirstFrame(
                type,
                AppFrameJson.GetInt(root, "proto"),
                AppFrameJson.GetString(root, "role"),
                AppFrameJson.GetString(root, "hostId"),
                AppFrameJson.GetString(root, "secret"),
                AppFrameJson.GetString(root, "deviceToken"),
                AppFrameJson.GetString(root, "code"),
                AppFrameJson.GetString(root, "share"),
                AppFrameJson.GetString(root, "label"));
        }
    }

    private static bool TryGetStringArray(JsonElement element, string name, out List<string> values)
    {
        values = [];

        if (!element.TryGetProperty(name, out var array) || array.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        foreach (var item in array.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            var value = item.GetString();
            if (value is null)
            {
                return false;
            }

            values.Add(value);
        }

        return true;
    }

    private static List<(string Path, string Hash)>? ParseFileManifest(JsonElement root)
    {
        if (!root.TryGetProperty("files", out var files) || files.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var manifest = new List<(string Path, string Hash)>();
        foreach (var item in files.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var path = AppFrameJson.GetString(item, "path");
            var hash = AppFrameJson.GetString(item, "hash");
            if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(hash))
            {
                continue;
            }

            manifest.Add((path, hash));
        }

        return manifest;
    }
}
