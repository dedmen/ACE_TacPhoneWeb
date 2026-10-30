using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Tests.Infrastructure;

public sealed class CrockfordBase32Tests
{
    [Theory]
    [InlineData(10)]
    [InlineData(16)]
    [InlineData(12)]
    public void Random_ReturnsRequestedLengthFromTheAlphabet(int length)
    {
        var value = CrockfordBase32.Random(length);

        Assert.Equal(length, value.Length);
        Assert.All(value, ch => Assert.Contains(ch, CrockfordBase32.Alphabet));
    }

    [Fact]
    public void Random_IsNotConstant()
    {
        Assert.NotEqual(CrockfordBase32.Random(16), CrockfordBase32.Random(16));
    }

    [Fact]
    public void Encode_ProducesFiveBitsPerCharacter()
    {
        // The highest five bits of 0xFF are 11111 -> 31, the last alphabet character.
        Assert.Equal("Z", CrockfordBase32.Encode(new byte[] { 0xFF }, 1));
        Assert.Equal("0", CrockfordBase32.Encode(new byte[] { 0x00 }, 1));

        // 0xF8 = 11111 000 -> "Z0"; missing bits read as zero.
        Assert.Equal("Z0", CrockfordBase32.Encode(new byte[] { 0xF8 }, 2));
    }

    [Fact]
    public void FormatPairCode_InsertsDashes()
    {
        Assert.Equal("0123-4567-89", CrockfordBase32.FormatPairCode("0123456789"));
    }

    [Fact]
    public void FormatPairCode_RejectsWrongLength()
    {
        Assert.Throws<ArgumentException>(() => CrockfordBase32.FormatPairCode("012345678"));
    }

    [Theory]
    [InlineData("0123456789", "0123-4567-89")]
    [InlineData("0123-4567-89", "0123-4567-89")]
    [InlineData("0123 4567 89", "0123-4567-89")]
    [InlineData("abcd-efgh-jk", "ABCD-EFGH-JK")]
    [InlineData("  abcd efgh jk  ", "ABCD-EFGH-JK")]
    [InlineData("o123-4567-8i", "0123-4567-81")]
    [InlineData("0123-4567-8l", "0123-4567-81")]
    [InlineData("0123-4567-8u", "0123-4567-8V")]
    [InlineData("0123_4567_89", "0123-4567-89")]
    public void NormalizePairCode_AcceptsUserInput(string input, string expected)
    {
        Assert.Equal(expected, CrockfordBase32.NormalizePairCode(input));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("01234567")]        // too short
    [InlineData("012345678")]       // too short
    [InlineData("0123456789A")]     // too long
    [InlineData("0123-4567-8!")]    // illegal character
    [InlineData("0123-4567-8#")]
    public void NormalizePairCode_RejectsInvalidInput(string? input)
    {
        Assert.Null(CrockfordBase32.NormalizePairCode(input));
    }

    [Theory]
    [InlineData("0123456789ABCDEF")]
    [InlineData("abcd-efgh-jkmn-pqrs")]
    public void NormalizeShareKey_AcceptsSixteenCharacters(string input)
    {
        var normalized = CrockfordBase32.NormalizeShareKey(input);

        Assert.NotNull(normalized);
        Assert.Equal(CrockfordBase32.ShareKeyLength, normalized!.Length);
        Assert.All(normalized, ch => Assert.Contains(ch, CrockfordBase32.Alphabet));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0123456789")]                // 10
    [InlineData("0123456789ABCDE")]           // 15
    [InlineData("0123456789ABCDEFG")]         // 17
    public void NormalizeShareKey_RejectsOtherLengths(string? input)
    {
        Assert.Null(CrockfordBase32.NormalizeShareKey(input));
    }

    [Fact]
    public void NormalizeRaw_MapsConfusablesAndU()
    {
        Assert.Equal("0011V", CrockfordBase32.NormalizeRaw("oOilU"));
    }

    [Fact]
    public void IsHostId_AcceptsGeneratedIdentifiers()
    {
        Assert.True(CrockfordBase32.IsHostId(CrockfordBase32.Random(CrockfordBase32.HostIdLength)));
        Assert.True(CrockfordBase32.IsHostId("0123456789"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("012345678")]        // 9
    [InlineData("0123456789A")]      // 11
    [InlineData("abcdefghjk")]       // lower case
    [InlineData("01234567O9")]       // O is not in the alphabet
    [InlineData("01234567U9")]       // U is not in the alphabet
    public void IsHostId_RejectsInvalidIdentifiers(string? value)
    {
        Assert.False(CrockfordBase32.IsHostId(value));
    }

    [Fact]
    public void IsPeerId_AcceptsGeneratedIdentifiers()
    {
        var peerId = "p_" + CrockfordBase32.Random(CrockfordBase32.PeerIdLength);

        Assert.True(CrockfordBase32.IsPeerId(peerId));
        Assert.True(CrockfordBase32.IsPeerId("p_0123456789AB"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("p_")]
    [InlineData("p_short")]
    [InlineData("p_0123456789A")]     // 11 random characters
    [InlineData("p_0123456789ABC")]   // 13 random characters
    [InlineData("p_0123456789ab")]    // lower case
    [InlineData("q_0123456789AB")]    // wrong prefix
    [InlineData("0123456789AB")]      // missing prefix
    public void IsPeerId_RejectsInvalidIdentifiers(string? value)
    {
        Assert.False(CrockfordBase32.IsPeerId(value));
    }
}
