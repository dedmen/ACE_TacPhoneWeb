using System.Text;

namespace TacPhone.RemoteServer.Infrastructure;

/// <summary>
/// Builds the human readable device label from a User-Agent header.
/// </summary>
/// <remarks>
/// TODO: device labels are derived from the User-Agent only. Making them
/// user-editable (or pairing them with a friendly name from the panel) is a
/// known follow-up; see the server README.
/// </remarks>
public static class LabelHelper
{
    /// <summary>Default label when no User-Agent is available.</summary>
    public const string Fallback = "Unknown device";

    /// <summary>Maximum label length, in characters.</summary>
    public const int MaxLength = 80;

    /// <summary>
    /// Collapses control characters and whitespace and truncates the result.
    /// Never returns an empty string.
    /// </summary>
    public static string FromUserAgent(string? userAgent, int maxLength = MaxLength)
    {
        if (maxLength <= 0)
        {
            return Fallback;
        }

        if (string.IsNullOrWhiteSpace(userAgent))
        {
            return Fallback;
        }

        var builder = new StringBuilder(Math.Min(userAgent.Length, maxLength));
        var lastWasSpace = false;
        foreach (var ch in userAgent)
        {
            if (builder.Length >= maxLength)
            {
                break;
            }

            var c = char.IsControl(ch) ? ' ' : ch;
            if (char.IsWhiteSpace(c))
            {
                if (lastWasSpace || builder.Length == 0)
                {
                    continue;
                }

                lastWasSpace = true;
                builder.Append(' ');
                continue;
            }

            lastWasSpace = false;
            builder.Append(c);
        }

        var label = builder.ToString().TrimEnd();
        return label.Length == 0 ? Fallback : label;
    }
}
