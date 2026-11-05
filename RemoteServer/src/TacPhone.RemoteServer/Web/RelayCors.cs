using System.Globalization;

namespace TacPhone.RemoteServer.Web;

/// <summary>
/// CORS headers for <c>/ws</c>. The in-game browser reaches the relay through
/// Arma's native <c>webRequest</c>, which sends an <c>arma://</c> origin. Those
/// origins are echoed back; every other origin gets <c>*</c> (the relay has no
/// cookie auth, so a wildcard is safe).
/// </summary>
public static class RelayCors
{
    public const string A3OriginScheme = "arma://";
    public const string AllowedMethods = "GET, OPTIONS, UPGRADE, CONNECT";
    public const string AllowedHeaders = "*";
    public const int MaxAgeSeconds = 600;

    /// <summary>The <c>Access-Control-Allow-Origin</c> value for an origin header.</summary>
    public static string ResolveAllowOrigin(string? origin) =>
        !string.IsNullOrEmpty(origin) && origin.StartsWith(A3OriginScheme, StringComparison.OrdinalIgnoreCase)
            ? origin
            : "*";

    /// <summary>Headers for the <c>OPTIONS /ws</c> preflight.</summary>
    public static void ApplyPreflight(IHeaderDictionary headers, string? origin)
    {
        ArgumentNullException.ThrowIfNull(headers);

        headers.AccessControlAllowOrigin = ResolveAllowOrigin(origin);
        headers.AccessControlAllowMethods = AllowedMethods;
        headers.AccessControlAllowHeaders = AllowedHeaders;
        headers.AccessControlMaxAge = MaxAgeSeconds.ToString(CultureInfo.InvariantCulture);
        headers.Vary = "Origin";
    }

    /// <summary>Origin headers on the <c>GET /ws</c> response.</summary>
    public static void ApplyAllowOrigin(IHeaderDictionary headers, string? origin)
    {
        ArgumentNullException.ThrowIfNull(headers);

        headers.AccessControlAllowOrigin = ResolveAllowOrigin(origin);
        headers.Vary = "Origin";
    }
}
