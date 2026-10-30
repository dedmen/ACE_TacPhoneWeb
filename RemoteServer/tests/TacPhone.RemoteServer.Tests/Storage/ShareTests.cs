using TacPhone.RemoteServer.Infrastructure;
using TacPhone.RemoteServer.Storage;

namespace TacPhone.RemoteServer.Tests.Storage;

public sealed class ShareTests
{
    [Fact]
    public async Task CreateShare_ProducesAUsableShare()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var expires = db.Clock.UnixSeconds + 3600;

        var share = await db.Repository.CreateShareReplacementAsync(hostId, expires);

        Assert.False(string.IsNullOrWhiteSpace(share.ShareId));
        Assert.Equal(CrockfordBase32.ShareKeyLength, share.Key.Length);
        Assert.All(share.Key, ch => Assert.Contains(ch, CrockfordBase32.Alphabet));
        Assert.Equal(expires, share.ExpiresUtc);
        Assert.Empty(share.ReplacedShareIds);

        var active = await db.Repository.GetActiveShareAsync(hostId);
        Assert.NotNull(active);
        Assert.Equal(share.ShareId, active!.ShareId);
        Assert.Equal(hostId, active.HostId);
        Assert.Equal(expires, active.ExpiresUtc);
        Assert.Equal(db.Clock.UnixSeconds, active.CreatedUtc);
        Assert.Null(active.RevokedUtc);
        Assert.Equal(Hashing.Sha256(share.Key), active.KeyHash);

        var byKey = await db.Repository.FindShareByKeyHashAsync(Hashing.Sha256(share.Key));
        Assert.NotNull(byKey);
        Assert.Equal(share.ShareId, byKey!.ShareId);
        Assert.Equal(share.ShareId, (await db.Repository.FindShareByIdAsync(share.ShareId))!.ShareId);
    }

    [Fact]
    public async Task ReplacingAShare_RemovesTheOldShareAndItsDevicesButKeepsOwnerDevices()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();

        var shareA = await db.Repository.CreateShareReplacementAsync(hostId, db.Clock.UnixSeconds + 3600);
        var shareDevice = await db.Repository.IssueDeviceAsync(hostId, shareA.ShareId, "phone", shareA.ExpiresUtc);
        var ownerDevice = await db.Repository.IssueDeviceAsync(hostId, null, "owner", null);

        var shareB = await db.Repository.CreateShareReplacementAsync(hostId, db.Clock.UnixSeconds + 7200);

        Assert.Equal(new[] { shareA.ShareId }, shareB.ReplacedShareIds);
        Assert.Null(await db.Repository.FindShareByIdAsync(shareA.ShareId));
        Assert.Null(await db.Repository.FindShareByKeyHashAsync(Hashing.Sha256(shareA.Key)));

        var active = await db.Repository.GetActiveShareAsync(hostId);
        Assert.NotNull(active);
        Assert.Equal(shareB.ShareId, active!.ShareId);

        Assert.Null(await db.Repository.FindDeviceAsync(Hashing.Sha256(shareDevice.Token)));
        Assert.NotNull(await db.Repository.FindDeviceAsync(Hashing.Sha256(ownerDevice.Token)));
    }

    [Fact]
    public async Task ReplacingAShareAgain_ReportsOnlyTheShareItReplaced()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var now = db.Clock.UnixSeconds;

        var a = await db.Repository.CreateShareReplacementAsync(hostId, now + 100);
        var b = await db.Repository.CreateShareReplacementAsync(hostId, now + 200);
        var c = await db.Repository.CreateShareReplacementAsync(hostId, now + 300);

        Assert.Empty(a.ReplacedShareIds);
        Assert.Equal(new[] { a.ShareId }, b.ReplacedShareIds);
        Assert.Equal(new[] { b.ShareId }, c.ReplacedShareIds);
    }

    [Fact]
    public async Task Revoke_DeletesTheShareAndItsDevices()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();

        var share = await db.Repository.CreateShareReplacementAsync(hostId, db.Clock.UnixSeconds + 3600);
        var device = await db.Repository.IssueDeviceAsync(hostId, share.ShareId, "phone", share.ExpiresUtc);

        var revocation = await db.Repository.RevokeSharesAsync(hostId);

        Assert.Equal(new[] { share.ShareId }, revocation.RevokedShareIds);
        Assert.Null(await db.Repository.GetActiveShareAsync(hostId));
        Assert.Null(await db.Repository.FindShareByIdAsync(share.ShareId));
        Assert.Null(await db.Repository.FindDeviceAsync(Hashing.Sha256(device.Token)));

        var again = await db.Repository.RevokeSharesAsync(hostId);
        Assert.Empty(again.RevokedShareIds);
    }

    [Fact]
    public async Task Revoke_KeepsOwnerDevices()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();

        var share = await db.Repository.CreateShareReplacementAsync(hostId, db.Clock.UnixSeconds + 3600);
        var owner = await db.Repository.IssueDeviceAsync(hostId, null, "owner", null);

        await db.Repository.RevokeSharesAsync(hostId);

        Assert.Null(await db.Repository.FindShareByIdAsync(share.ShareId));
        Assert.NotNull(await db.Repository.FindDeviceAsync(Hashing.Sha256(owner.Token)));
    }

    [Fact]
    public async Task Expiry_DeleteExpiredAsyncDropsTheShareAndItsDevices()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();

        var share = await db.Repository.CreateShareReplacementAsync(hostId, db.Clock.UnixSeconds + 100);
        var shareDevice = await db.Repository.IssueDeviceAsync(hostId, share.ShareId, "phone", share.ExpiresUtc);
        var ownerDevice = await db.Repository.IssueDeviceAsync(hostId, null, "owner", null);

        db.Clock.Advance(TimeSpan.FromSeconds(101));
        Assert.Null(await db.Repository.GetActiveShareAsync(hostId));

        var deleted = await db.Repository.DeleteExpiredAsync();
        Assert.True(deleted > 0);

        Assert.Null(await db.Repository.FindShareByIdAsync(share.ShareId));
        Assert.Null(await db.Repository.FindDeviceAsync(Hashing.Sha256(shareDevice.Token)));
        Assert.NotNull(await db.Repository.FindDeviceAsync(Hashing.Sha256(ownerDevice.Token)));
    }

    [Fact]
    public async Task ExpiredShareIsNotActiveButStillFindableByKeyUntilSwept()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var expires = db.Clock.UnixSeconds + 60;

        var share = await db.Repository.CreateShareReplacementAsync(hostId, expires);
        db.Clock.Advance(TimeSpan.FromSeconds(61));

        Assert.Null(await db.Repository.GetActiveShareAsync(hostId));
        Assert.NotNull(await db.Repository.FindShareByKeyHashAsync(Hashing.Sha256(share.Key)));
    }

    [Fact]
    public async Task TheShareKeyIsNotStoredInPlaintext()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();

        var share = await db.Repository.CreateShareReplacementAsync(hostId, db.Clock.UnixSeconds + 3600);

        Assert.DoesNotContain(share.Key, db.RawText(), StringComparison.Ordinal);
    }
}
