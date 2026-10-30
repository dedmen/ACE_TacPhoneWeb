using TacPhone.RemoteServer.Infrastructure;
using TacPhone.RemoteServer.Storage;

namespace TacPhone.RemoteServer.Tests.Storage;

public sealed class DeviceTests
{
    [Fact]
    public async Task OwnerDevice_IsPermanentAndLabelled()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var now = db.Clock.UnixSeconds;

        var issued = await db.Repository.IssueDeviceAsync(hostId, null, "my phone", null);

        Assert.False(string.IsNullOrWhiteSpace(issued.Token));
        Assert.Equal(hostId, issued.Record.HostId);
        Assert.Null(issued.Record.ShareId);
        Assert.Null(issued.Record.ExpiresUtc);
        Assert.Equal("my phone", issued.Record.Label);
        Assert.False(string.IsNullOrWhiteSpace(issued.Record.Label));
        Assert.Equal(now, issued.Record.CreatedUtc);
        Assert.Equal(now, issued.Record.LastSeenUtc);
        Assert.Equal(Hashing.Sha256(issued.Token), issued.Record.TokenHash);

        var found = await db.Repository.FindDeviceAsync(Hashing.Sha256(issued.Token));
        Assert.NotNull(found);
        Assert.Equal(issued.Record.TokenHash, found!.TokenHash);
        Assert.Equal(issued.Record.HostId, found.HostId);
        Assert.Null(found.ShareId);
        Assert.Equal(now, found.LastSeenUtc);

        Assert.Null(await db.Repository.FindDeviceAsync(Hashing.Sha256("other")));
    }

    [Fact]
    public async Task ShareDevice_CarriesTheShareIdAndExpiry()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var share = await db.Repository.CreateShareReplacementAsync(hostId, db.Clock.UnixSeconds + 3600);

        var issued = await db.Repository.IssueDeviceAsync(hostId, share.ShareId, "phone", share.ExpiresUtc);

        var found = await db.Repository.FindDeviceAsync(Hashing.Sha256(issued.Token));
        Assert.NotNull(found);
        Assert.Equal(share.ShareId, found!.ShareId);
        Assert.Equal(share.ExpiresUtc, found.ExpiresUtc);
        Assert.Equal(share.ExpiresUtc, issued.Record.ExpiresUtc);
        Assert.Equal("phone", found.Label);
    }

    [Fact]
    public async Task TwoTokensDifferAndAreNotStoredInPlaintext()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();

        var first = await db.Repository.IssueDeviceAsync(hostId, null, "one", null);
        var second = await db.Repository.IssueDeviceAsync(hostId, null, "two", null);

        Assert.NotEqual(first.Token, second.Token);

        foreach (var issued in new[] { first, second })
        {
            // Storage only ever sees the hash.
            Assert.Equal(Hashing.Sha256(issued.Token), issued.Record.TokenHash);
            Assert.NotEqual(issued.Token, Convert.ToHexString(issued.Record.TokenHash));
            Assert.NotEqual(issued.Token, Convert.ToBase64String(issued.Record.TokenHash));
            Assert.NotEqual(issued.Token, Hashing.Base64Url(issued.Record.TokenHash));
        }

        var rawText = db.RawText();
        Assert.DoesNotContain(first.Token, rawText, StringComparison.Ordinal);
        Assert.DoesNotContain(second.Token, rawText, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TouchDevice_UpdatesLastSeenButNotCreated()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var created = db.Clock.UnixSeconds;
        var issued = await db.Repository.IssueDeviceAsync(hostId, null, "phone", null);

        db.Clock.Advance(TimeSpan.FromMinutes(5));
        await db.Repository.TouchDeviceAsync(Hashing.Sha256(issued.Token));

        var found = await db.Repository.FindDeviceAsync(Hashing.Sha256(issued.Token));
        Assert.NotNull(found);
        Assert.Equal(created, found!.CreatedUtc);
        Assert.Equal(created + 300, found.LastSeenUtc);
    }

    [Fact]
    public async Task DeleteExpired_KeepsPermanentOwnerDevices()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var owner = await db.Repository.IssueDeviceAsync(hostId, null, "owner", null);

        db.Clock.Advance(TimeSpan.FromDays(400));
        await db.Repository.DeleteExpiredAsync();

        Assert.NotNull(await db.Repository.FindDeviceAsync(Hashing.Sha256(owner.Token)));
    }

    [Fact]
    public async Task DeleteExpired_DropsAnOwnerDeviceWithAnExplicitExpiry()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var expiring = await db.Repository.IssueDeviceAsync(
            hostId,
            null,
            "temporary owner",
            db.Clock.UnixSeconds + 60);

        // Still there one second before the expiry.
        db.Clock.Advance(TimeSpan.FromSeconds(59));
        await db.Repository.DeleteExpiredAsync();
        Assert.NotNull(await db.Repository.FindDeviceAsync(Hashing.Sha256(expiring.Token)));

        db.Clock.Advance(TimeSpan.FromSeconds(2));
        var deleted = await db.Repository.DeleteExpiredAsync();

        Assert.True(deleted > 0);
        Assert.Null(await db.Repository.FindDeviceAsync(Hashing.Sha256(expiring.Token)));
    }

    [Fact]
    public async Task DeleteExpired_DropsAShareDeviceAfterTheShareExpires()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var share = await db.Repository.CreateShareReplacementAsync(hostId, db.Clock.UnixSeconds + 60);
        var device = await db.Repository.IssueDeviceAsync(hostId, share.ShareId, "phone", share.ExpiresUtc);

        db.Clock.Advance(TimeSpan.FromSeconds(61));
        await db.Repository.DeleteExpiredAsync();

        Assert.Null(await db.Repository.FindDeviceAsync(Hashing.Sha256(device.Token)));
    }

    [Fact]
    public async Task DeleteExpired_OnAFreshDatabaseDeletesNothing()
    {
        await using var db = await TempDatabase.CreateAsync();
        await db.CreateHostAsync();

        Assert.Equal(0, await db.Repository.DeleteExpiredAsync());
    }
}
