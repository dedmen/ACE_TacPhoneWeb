using TacPhone.RemoteServer.Protocol;

namespace TacPhone.RemoteServer.Tests.Protocol;

public sealed class RelaySendPlanTests
{
    private static readonly string[] Connected = ["p_a", "p_b"];

    [Fact]
    public void Expand_AllTargetsExpandsToEveryConnectedPeerInOrder()
    {
        var plan = RelaySendPlan.Expand(["*"], Connected);

        Assert.Equal(Connected, plan.Targets);
        Assert.Empty(plan.Unknown);
        Assert.Equal(2, plan.Requested);
    }

    [Fact]
    public void Expand_DedupesWhileKeepingTheFirstSeenOrder()
    {
        var plan = RelaySendPlan.Expand(["p_b", "p_a", "p_b", "*", "p_a"], Connected);

        Assert.Equal(new[] { "p_b", "p_a" }, plan.Targets);
        Assert.Empty(plan.Unknown);
        Assert.Equal(2, plan.Requested);
    }

    [Fact]
    public void Expand_ReportsUnknownPeersWithoutDroppingThemFromRequested()
    {
        var plan = RelaySendPlan.Expand(["p_a", "p_gone", "p_gone", "p_other"], Connected);

        Assert.Equal(new[] { "p_a" }, plan.Targets);
        Assert.Equal(new[] { "p_gone", "p_other" }, plan.Unknown);
        Assert.Equal(3, plan.Requested);
    }

    [Fact]
    public void Expand_KeepsKnownAndUnknownInTheirFirstSeenOrder()
    {
        var plan = RelaySendPlan.Expand(["p_gone", "p_b", "*"], Connected);

        Assert.Equal(new[] { "p_b", "p_a" }, plan.Targets);
        Assert.Equal(new[] { "p_gone" }, plan.Unknown);
        Assert.Equal(3, plan.Requested);
    }

    [Fact]
    public void Expand_EmptyTargetsProduceAnEmptyPlan()
    {
        var plan = RelaySendPlan.Expand([], Connected);

        Assert.Empty(plan.Targets);
        Assert.Empty(plan.Unknown);
        Assert.Equal(0, plan.Requested);
    }

    [Fact]
    public void Expand_AllTargetsWithNoConnectedPeersIsEmpty()
    {
        var plan = RelaySendPlan.Expand(["*"], []);

        Assert.Empty(plan.Targets);
        Assert.Empty(plan.Unknown);
        Assert.Equal(0, plan.Requested);
    }
}
