using System.Security.Cryptography;

namespace TacPhone.RemoteServer.Infrastructure;

/// <summary>
/// Crockford base32 helpers used for every user-visible identifier
/// (host ids, one-time codes, share keys, peer ids).
/// </summary>
public static class CrockfordBase32
{
    /// <summary>Crockford alphabet: no I, L, O or U.</summary>
    public const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    private const int BitsPerChar = 5;

    /// <summary>Length of a one-time pairing code, without the dashes.</summary>
    public const int PairCodeLength = 10;

    /// <summary>Length of a share key.</summary>
    public const int ShareKeyLength = 16;

    /// <summary>Length of a host id.</summary>
    public const int HostIdLength = 10;

    /// <summary>Length of the random part of a peer id (the id also has a "p_" prefix).</summary>
    public const int PeerIdLength = 12;

    /// <summary>Creates <paramref name="length"/> characters from a cryptographically secure RNG.</summary>
    public static string Random(int length)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(length);

        var byteCount = (length * BitsPerChar + 7) / 8;
        var bytes = RandomNumberGenerator.GetBytes(byteCount);
        return Encode(bytes, length);
    }

    /// <summary>Encodes <paramref name="data"/> as Crockford base32, five bits per character.</summary>
    public static string Encode(ReadOnlySpan<byte> data, int length)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(length);

        var chars = new char[length];
        var bit = 0;
        for (var i = 0; i < length; i++)
        {
            var value = 0;
            for (var b = 0; b < BitsPerChar; b++, bit++)
            {
                var byteIndex = bit / 8;
                var bitIndex = 7 - (bit % 8);
                var set = byteIndex < data.Length && ((data[byteIndex] >> bitIndex) & 1) != 0;
                value = (value << 1) | (set ? 1 : 0);
            }

            chars[i] = Alphabet[value];
        }

        return new string(chars);
    }

    /// <summary>Formats a raw 10 character code as <c>XXXX-XXXX-XX</c>.</summary>
    public static string FormatPairCode(string raw)
    {
        ArgumentNullException.ThrowIfNull(raw);
        if (raw.Length != PairCodeLength)
        {
            throw new ArgumentException($"A pairing code has {PairCodeLength} characters.", nameof(raw));
        }

        return $"{raw[..4]}-{raw[4..8]}-{raw[8..]}";
    }

    /// <summary>
    /// Normalizes user input to the canonical dashed pairing-code form, or returns
    /// <c>null</c> when it cannot be a pairing code. Accepts lower case, missing
    /// dashes/spaces, and the Crockford confusables (I/L -&gt; 1, O -&gt; 0).
    /// </summary>
    public static string? NormalizePairCode(string? input)
    {
        var raw = NormalizeRaw(input);
        return raw is { Length: PairCodeLength } ? FormatPairCode(raw) : null;
    }

    /// <summary>
    /// Normalizes a share key to 16 upper-case Crockford characters, or returns
    /// <c>null</c> when it cannot be a share key.
    /// </summary>
    public static string? NormalizeShareKey(string? input)
    {
        var raw = NormalizeRaw(input);
        return raw is { Length: ShareKeyLength } ? raw : null;
    }

    /// <summary>
    /// Upper-cases the input, drops separators and maps the Crockford aliases.
    /// Returns <c>null</c> when an unmappable character is present.
    /// </summary>
    public static string? NormalizeRaw(string? input)
    {
        if (string.IsNullOrEmpty(input))
        {
            return null;
        }

        Span<char> buffer = stackalloc char[input.Length];
        var length = 0;
        foreach (var ch in input)
        {
            if (ch is '-' or ' ' or '_' or '.' or '\t')
            {
                continue;
            }

            var upper = char.ToUpperInvariant(ch);
            upper = upper switch
            {
                'O' => '0',
                'I' or 'L' => '1',
                'U' => 'V',
                _ => upper,
            };

            if (!Alphabet.Contains(upper))
            {
                return null;
            }

            buffer[length++] = upper;
        }

        return length == 0 ? null : new string(buffer[..length]);
    }

    /// <summary>True when <paramref name="value"/> is a syntactically valid host id.</summary>
    public static bool IsHostId(string? value) => IsCanonical(value, HostIdLength);

    /// <summary>True when <paramref name="value"/> is a syntactically valid peer id.</summary>
    public static bool IsPeerId(string? value) =>
        value is not null
        && value.StartsWith("p_", StringComparison.Ordinal)
        && IsCanonical(value[2..], PeerIdLength);

    private static bool IsCanonical(string? value, int length)
    {
        if (value is null || value.Length != length)
        {
            return false;
        }

        foreach (var ch in value)
        {
            if (!Alphabet.Contains(ch))
            {
                return false;
            }
        }

        return true;
    }
}
