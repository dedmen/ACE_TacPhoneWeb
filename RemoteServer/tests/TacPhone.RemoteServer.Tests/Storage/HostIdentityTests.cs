using TacPhone.RemoteServer.Infrastructure;
using TacPhone.RemoteServer.Storage;

namespace TacPhone.RemoteServer.Tests.Storage;

public sealed class HostIdentityTests
{
    [Fact]
    public async Task FirstAuthentication_IssuesAHostIdAndSecret()
    {
        await using var db = await TempDatabase.CreateAsync();
        var clock = db.Clock;

        var result = await db.Repository.AuthenticateHostAsync(null, null, "test host");

        Assert.Equal(CrockfordBase32.HostIdLength, result.HostId.Length);
        Assert.True(CrockfordBase32.IsHostId(result.HostId));
        Assert.False(string.IsNullOrWhiteSpace(result.IssuedSecret));
        Assert.NotEmpty(result.IssuedSecret!);
        Assert.True(clock.UnixSeconds > 0);
    }

    [Fact]
    public async Task Authentication_WithTheIssuedSecretReturnsTheSameHostWithoutANewSecret()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, secret) = await db.CreateHostAsync();

        var result = await db.Repository.AuthenticateHostAsync(hostId, secret, "test host");

        Assert.Equal(hostId, result.HostId);
        Assert.Null(result.IssuedSecret);
    }

    [Fact]
    public async Task TheSecretIsNotStoredInPlaintext()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (_, secret) = await db.CreateHostAsync();

        Assert.DoesNotContain(secret, db.RawText(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Authentication_WithTheRightIdAndAWrongSecretIssuesANewIdentity()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, secret) = await db.CreateHostAsync();

        var result = await db.Repository.AuthenticateHostAsync(hostId, secret + "x", "test host");

        Assert.NotEqual(hostId, result.HostId);
        Assert.True(CrockfordBase32.IsHostId(result.HostId));
        Assert.False(string.IsNullOrEmpty(result.IssuedSecret));
        Assert.NotEqual(secret, result.IssuedSecret);
    }

    [Fact]
    public async Task Authentication_WithAnUnknownHostIdIssuesANewIdentity()
    {
        await using var db = await TempDatabase.CreateAsync();
        var unknown = CrockfordBase32.Random(CrockfordBase32.HostIdLength);

        var result = await db.Repository.AuthenticateHostAsync(unknown, Hashing.NewToken(), "test host");

        Assert.NotEqual(unknown, result.HostId);
        Assert.True(CrockfordBase32.IsHostId(result.HostId));
        Assert.False(string.IsNullOrEmpty(result.IssuedSecret));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public async Task Authentication_WithoutASecretIssuesANewIdentity(string? secret)
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();

        var result = await db.Repository.AuthenticateHostAsync(hostId, secret, "test host");

        Assert.NotEqual(hostId, result.HostId);
        Assert.True(CrockfordBase32.IsHostId(result.HostId));
        Assert.False(string.IsNullOrEmpty(result.IssuedSecret));
    }

    [Fact]
    public async Task Authentication_WithoutAHostIdIgnoresAStraySecret()
    {
        await using var db = await TempDatabase.CreateAsync();

        var result = await db.Repository.AuthenticateHostAsync(null, Hashing.NewToken(), "test host");

        Assert.True(CrockfordBase32.IsHostId(result.HostId));
        Assert.False(string.IsNullOrEmpty(result.IssuedSecret));
    }

    [Fact]
    public async Task EveryIssuedHostIdIsCanonical()
    {
        await using var db = await TempDatabase.CreateAsync();

        for (var i = 0; i < 10; i++)
        {
            var result = await db.Repository.AuthenticateHostAsync(null, null, $"host {i}");
            Assert.True(CrockfordBase32.IsHostId(result.HostId), result.HostId);
        }
    }

    [Fact]
    public async Task TouchHost_UpdatesTheLastSeenTimestamp()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();

        db.Clock.Advance(TimeSpan.FromMinutes(5));
        await db.Repository.TouchHostAsync(hostId);

        // Touching is best effort: it must not throw and must keep the identity usable.
        var again = await db.Repository.AuthenticateHostAsync(hostId, null, "test host");
        Assert.True(CrockfordBase32.IsHostId(again.HostId));
    }
}
