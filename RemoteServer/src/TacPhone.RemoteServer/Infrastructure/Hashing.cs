using System.Security.Cryptography;
using System.Text;

namespace TacPhone.RemoteServer.Infrastructure;

/// <summary>
/// Hashing and token helpers. Secrets never leave this process in plaintext
/// except in the frame that issues them; storage only ever sees SHA-256 hashes.
/// </summary>
public static class Hashing
{
    /// <summary>Size of every SHA-256 digest stored in the database.</summary>
    public const int HashSizeBytes = 32;

    /// <summary>Entropy of a host secret / device token.</summary>
    public const int TokenSizeBytes = 16;

    /// <summary>SHA-256 of the UTF-8 encoded value.</summary>
    public static byte[] Sha256(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        return SHA256.HashData(Encoding.UTF8.GetBytes(value));
    }

    /// <summary>Constant-time comparison of two digests.</summary>
    public static bool FixedTimeEquals(ReadOnlySpan<byte> left, ReadOnlySpan<byte> right) =>
        CryptographicOperations.FixedTimeEquals(left, right);

    /// <summary>
    /// Creates a new opaque secret (128 bits, base64url without padding). Used for
    /// host secrets and device tokens.
    /// </summary>
    public static string NewToken() => Base64Url(RandomNumberGenerator.GetBytes(TokenSizeBytes));

    /// <summary>RFC 4648 base64url without padding.</summary>
    public static string Base64Url(ReadOnlySpan<byte> data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
