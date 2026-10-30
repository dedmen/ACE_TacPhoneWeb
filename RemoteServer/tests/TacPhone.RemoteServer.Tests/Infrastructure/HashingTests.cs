using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Tests.Infrastructure;

public sealed class HashingTests
{
    [Fact]
    public void Sha256_IsDeterministicAndThirtyTwoBytes()
    {
        var first = Hashing.Sha256("the same input");
        var second = Hashing.Sha256("the same input");

        Assert.Equal(Hashing.HashSizeBytes, first.Length);
        Assert.Equal(first, second);
    }

    [Fact]
    public void Sha256_DiffersForDifferentInput()
    {
        Assert.NotEqual(Hashing.Sha256("alpha"), Hashing.Sha256("beta"));
        Assert.NotEqual(Hashing.Sha256("café"), Hashing.Sha256("cafe"));
        Assert.NotEqual(Hashing.Sha256("café"), Hashing.Sha256("café "));
    }

    [Fact]
    public void Sha256_MatchesTheKnownUtf8Digest()
    {
        // echo -n "" | sha256sum
        Assert.Equal(
            "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855",
            Convert.ToHexString(Hashing.Sha256(string.Empty)));
    }

    [Fact]
    public void FixedTimeEquals_ComparesDigests()
    {
        var left = Hashing.Sha256("secret");

        Assert.True(Hashing.FixedTimeEquals(left, Hashing.Sha256("secret")));

        var changed = Hashing.Sha256("secret");
        changed[^1] ^= 0xFF;
        Assert.False(Hashing.FixedTimeEquals(left, changed));
    }

    [Fact]
    public void FixedTimeEquals_ReturnsFalseForDifferentLengthsWithoutThrowing()
    {
        Assert.False(Hashing.FixedTimeEquals(
            Hashing.Sha256("secret"),
            Hashing.Sha256("secret").AsSpan(0, 31)));
    }

    [Fact]
    public void NewToken_IsBase64UrlWithoutPadding()
    {
        var token = Hashing.NewToken();

        Assert.Equal(22, token.Length);
        Assert.DoesNotContain('=', token);
        Assert.DoesNotContain('+', token);
        Assert.DoesNotContain('/', token);
        Assert.All(token, ch => Assert.True(char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_'));
    }

    [Fact]
    public void NewToken_IsNotConstant()
    {
        Assert.NotEqual(Hashing.NewToken(), Hashing.NewToken());
    }

    [Fact]
    public void Base64Url_UsesUrlSafeAlphabetAndDropsPadding()
    {
        Assert.Equal("-_8", Hashing.Base64Url(new byte[] { 0xFB, 0xFF }));
        Assert.Equal(string.Empty, Hashing.Base64Url(ReadOnlySpan<byte>.Empty));
    }
}
