using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Tests.Storage;

public sealed class PairCodeTests
{
    private static string NewCode() =>
        CrockfordBase32.Random(CrockfordBase32.PairCodeLength);

    [Fact]
    public async Task Consume_ReturnsTheHostOnce()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var code = NewCode();

        await db.Repository.CreatePairCodeAsync(hostId, code, db.Clock.UnixSeconds + 300);

        Assert.Equal(hostId, await db.Repository.ConsumePairCodeAsync(code));
        Assert.Null(await db.Repository.ConsumePairCodeAsync(code));
    }

    [Fact]
    public async Task Consume_ReturnsNullForAnExpiredCode()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var code = NewCode();
        var expires = db.Clock.UnixSeconds + 60;

        await db.Repository.CreatePairCodeAsync(hostId, code, expires);

        db.Clock.Advance(TimeSpan.FromSeconds(61));

        Assert.Null(await db.Repository.ConsumePairCodeAsync(code));
        Assert.Null(await db.Repository.ConsumePairCodeAsync(code));
    }

    [Fact]
    public async Task Consume_ReturnsNullForAnUnknownCode()
    {
        await using var db = await TempDatabase.CreateAsync();
        await db.CreateHostAsync();

        Assert.Null(await db.Repository.ConsumePairCodeAsync(NewCode()));
    }

    [Fact]
    public async Task CreateInvalidatesThePreviousCodeOfTheSameHost()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var first = NewCode();
        var second = NewCode();
        var expires = db.Clock.UnixSeconds + 300;

        await db.Repository.CreatePairCodeAsync(hostId, first, expires);
        await db.Repository.CreatePairCodeAsync(hostId, second, expires);

        Assert.Null(await db.Repository.ConsumePairCodeAsync(first));
        Assert.Equal(hostId, await db.Repository.ConsumePairCodeAsync(second));
    }

    [Fact]
    public async Task CodesOfDifferentHostsAreIndependent()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (firstHost, _) = await db.CreateHostAsync("first");
        var (secondHost, _) = await db.CreateHostAsync("second");
        var firstCode = NewCode();
        var secondCode = NewCode();
        var expires = db.Clock.UnixSeconds + 300;

        await db.Repository.CreatePairCodeAsync(firstHost, firstCode, expires);
        await db.Repository.CreatePairCodeAsync(secondHost, secondCode, expires);

        Assert.Equal(secondHost, await db.Repository.ConsumePairCodeAsync(secondCode));
        Assert.Equal(firstHost, await db.Repository.ConsumePairCodeAsync(firstCode));
    }

    [Fact]
    public async Task ACodeExpiringExactlyNowIsRejected()
    {
        await using var db = await TempDatabase.CreateAsync();
        var (hostId, _) = await db.CreateHostAsync();
        var code = NewCode();
        var expires = db.Clock.UnixSeconds;

        await db.Repository.CreatePairCodeAsync(hostId, code, expires);

        Assert.Null(await db.Repository.ConsumePairCodeAsync(code));
    }
}
