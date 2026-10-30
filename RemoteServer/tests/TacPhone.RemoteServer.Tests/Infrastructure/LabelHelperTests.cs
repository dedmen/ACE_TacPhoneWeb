using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Tests.Infrastructure;

public sealed class LabelHelperTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("   \t \r\n ")]
    public void FromUserAgent_UsesFallbackForMissingUserAgent(string? userAgent)
    {
        Assert.Equal(LabelHelper.Fallback, LabelHelper.FromUserAgent(userAgent));
    }

    [Fact]
    public void FromUserAgent_TruncatesToTheMaximumLength()
    {
        var label = LabelHelper.FromUserAgent(new string('a', 300));

        Assert.Equal(LabelHelper.MaxLength, label.Length);
        Assert.Equal(new string('a', LabelHelper.MaxLength), label);
    }

    [Fact]
    public void FromUserAgent_RespectsACustomMaximumLength()
    {
        Assert.Equal("abcde", LabelHelper.FromUserAgent("abcdefghij", 5));
        Assert.Equal("Unknown device", LabelHelper.FromUserAgent("abcdefghij", 0));
        Assert.Equal("Unknown device", LabelHelper.FromUserAgent("abcdefghij", -1));
    }

    [Fact]
    public void FromUserAgent_CollapsesControlCharactersAndWhitespace()
    {
        var label = LabelHelper.FromUserAgent("Mozilla/5.0\r\n\t(Windows  NT\t10.0)  ");

        Assert.Equal("Mozilla/5.0 (Windows NT 10.0)", label);
        Assert.DoesNotContain('\r', label);
        Assert.DoesNotContain('\n', label);
        Assert.DoesNotContain('\t', label);
        Assert.DoesNotContain("  ", label);
        Assert.Equal(label.Trim(), label);
    }

    [Fact]
    public void FromUserAgent_KeepsNormalUserAgentUnchanged()
    {
        const string userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

        Assert.Equal(userAgent, LabelHelper.FromUserAgent(userAgent));
    }

    [Fact]
    public void FromUserAgent_ReturnsFallbackForWhitespaceOnlyAfterSanitising()
    {
        Assert.Equal(LabelHelper.Fallback, LabelHelper.FromUserAgent("\u0001\u0002\u0003"));
    }
}
