using Microsoft.AspNetCore.Http;
using TacPhone.RemoteServer.Web;

namespace TacPhone.RemoteServer.Tests.Web;

public sealed class RelayCorsTests
{
    [Theory]
    [InlineData("arma://ACE_TacPhone")]
    [InlineData("arma://some-other-addon")]
    public void ResolveAllowOrigin_EchoesArmaOrigins(string origin)
    {
        Assert.Equal(origin, RelayCors.ResolveAllowOrigin(origin));
    }

    [Fact]
    public void ResolveAllowOrigin_IsCaseInsensitiveOnTheScheme()
    {
        Assert.Equal("ARMA://ACE_TacPhone", RelayCors.ResolveAllowOrigin("ARMA://ACE_TacPhone"));
    }

    [Theory]
    [InlineData("https://tacphone.arma3.io")]
    [InlineData("http://127.0.0.1:5080")]
    [InlineData("null")]
    [InlineData("")]
    [InlineData(null)]
    public void ResolveAllowOrigin_UsesWildcardForEverythingElse(string? origin)
    {
        Assert.Equal("*", RelayCors.ResolveAllowOrigin(origin));
    }

    [Fact]
    public void ApplyPreflight_WritesTheDocumentedHeaders()
    {
        IHeaderDictionary headers = new HeaderDictionary();

        RelayCors.ApplyPreflight(headers, "arma://ACE_TacPhone");

        Assert.Equal("arma://ACE_TacPhone", headers.AccessControlAllowOrigin.ToString());
        Assert.Equal("GET, OPTIONS, UPGRADE, CONNECT", headers.AccessControlAllowMethods.ToString());
        Assert.Equal("*", headers.AccessControlAllowHeaders.ToString());
        Assert.Equal("600", headers.AccessControlMaxAge.ToString());
        Assert.Equal("Origin", headers.Vary.ToString());
    }

    [Fact]
    public void ApplyPreflight_WildcardOriginForNonArmaOrigins()
    {
        IHeaderDictionary headers = new HeaderDictionary();

        RelayCors.ApplyPreflight(headers, "https://example.com");

        Assert.Equal("*", headers.AccessControlAllowOrigin.ToString());
        Assert.Equal("Origin", headers.Vary.ToString());
    }

    [Fact]
    public void ApplyAllowOrigin_SetsOriginAndVaryOnTheWebSocketResponse()
    {
        IHeaderDictionary headers = new HeaderDictionary();

        RelayCors.ApplyAllowOrigin(headers, "arma://ACE_TacPhone");

        Assert.Equal("arma://ACE_TacPhone", headers.AccessControlAllowOrigin.ToString());
        Assert.Equal("Origin", headers.Vary.ToString());
        Assert.Equal(0, headers.AccessControlAllowMethods.Count);
    }
}
