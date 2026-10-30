using TacPhone.RemoteServer.Infrastructure;
using TacPhone.RemoteServer.Tests.Storage;

namespace TacPhone.RemoteServer.Tests.Infrastructure;

public sealed class RateLimiterTests
{
    [Fact]
    public void TryAcquire_AllowsExactlyTheLimitThenResetsAfterTheWindow()
    {
        var clock = TestClock.Create();
        var limiter = new RateLimiter(clock);

        Assert.True(limiter.TryAcquire("ip:127.0.0.1", 2));
        Assert.True(limiter.TryAcquire("ip:127.0.0.1", 2));
        Assert.False(limiter.TryAcquire("ip:127.0.0.1", 2));
        Assert.False(limiter.TryAcquire("ip:127.0.0.1", 2));

        clock.Advance(TimeSpan.FromSeconds(61));

        Assert.True(limiter.TryAcquire("ip:127.0.0.1", 2));
        Assert.True(limiter.TryAcquire("ip:127.0.0.1", 2));
        Assert.False(limiter.TryAcquire("ip:127.0.0.1", 2));
    }

    [Fact]
    public void TryAcquire_KeepsIndependentCountersPerKey()
    {
        var clock = TestClock.Create();
        var limiter = new RateLimiter(clock);

        Assert.True(limiter.TryAcquire("a", 1));
        Assert.False(limiter.TryAcquire("a", 1));
        Assert.True(limiter.TryAcquire("b", 1));
        Assert.True(limiter.TryAcquire("c", 1));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(int.MinValue)]
    public void TryAcquire_IsUnlimitedForNonPositiveLimits(int limit)
    {
        var clock = TestClock.Create();
        var limiter = new RateLimiter(clock);

        for (var i = 0; i < 500; i++)
        {
            Assert.True(limiter.TryAcquire("unlimited", limit));
        }

        Assert.Equal(0, limiter.TrackedKeys);
    }

    [Fact]
    public void TryAcquire_IsThreadSafeForASingleKey()
    {
        var clock = TestClock.Create();
        var limiter = new RateLimiter(clock);
        var successes = 0;

        Parallel.For(0, 200, _ =>
        {
            if (limiter.TryAcquire("hot", 50))
            {
                Interlocked.Increment(ref successes);
            }
        });

        Assert.Equal(50, successes);
    }

    [Fact]
    public void Sweep_DropsStaleCounters()
    {
        var clock = TestClock.Create();
        var limiter = new RateLimiter(clock);

        Assert.True(limiter.TryAcquire("a", 5));
        Assert.True(limiter.TryAcquire("b", 5));
        Assert.Equal(2, limiter.TrackedKeys);

        limiter.Sweep();
        Assert.Equal(2, limiter.TrackedKeys);

        clock.Advance(TimeSpan.FromSeconds(61));
        limiter.Sweep();

        Assert.Equal(0, limiter.TrackedKeys);
    }

    [Fact]
    public void Sweep_KeepsCountersInsideTheWindow()
    {
        var clock = TestClock.Create();
        var limiter = new RateLimiter(clock);

        Assert.True(limiter.TryAcquire("fresh", 5));
        clock.Advance(TimeSpan.FromSeconds(30));
        limiter.Sweep();

        Assert.Equal(1, limiter.TrackedKeys);

        // The window is still open, so the counter is not reset by Sweep.
        Assert.False(limiter.TryAcquire("fresh", 1));
    }

    [Fact]
    public void AttachRateLimiters_ExposeIndependentLimiters()
    {
        var clock = TestClock.Create();
        var limiters = new AttachRateLimiters(clock);

        Assert.True(limiters.PerIp.TryAcquire("ip", 1));
        Assert.False(limiters.PerIp.TryAcquire("ip", 1));
        Assert.True(limiters.PerShare.TryAcquire("ip", 1));

        clock.Advance(TimeSpan.FromSeconds(61));
        limiters.Sweep();

        Assert.Equal(0, limiters.PerIp.TrackedKeys);
        Assert.Equal(0, limiters.PerShare.TrackedKeys);
    }
}
