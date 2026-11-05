namespace TacPhone.RemoteServer.Protocol;

/// <summary>
/// Result of expanding a <c>send</c> frame's target list: the peers to forward
/// to, plus the ids that are not attached to this host. <see cref="Expand"/>
/// holds the pure target logic: <c>"*"</c> becomes every attached peer, the
/// first-seen order is kept, duplicates are dropped and unknown ids are
/// reported instead of silently discarded.
/// </summary>
public sealed record RelaySendPlan(IReadOnlyList<string> Targets, IReadOnlyList<string> Unknown)
{
    public const string AllTargets = "*";

    /// <summary>Targets after expansion and dedupe, including the unknown ids.</summary>
    public int Requested => Targets.Count + Unknown.Count;

    public static RelaySendPlan Expand(
        IEnumerable<string> requested,
        IEnumerable<string> connected)
    {
        ArgumentNullException.ThrowIfNull(requested);
        ArgumentNullException.ThrowIfNull(connected);

        var available = new HashSet<string>(StringComparer.Ordinal);
        var availableOrder = new List<string>();
        foreach (var peer in connected)
        {
            if (available.Add(peer))
            {
                availableOrder.Add(peer);
            }
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var targets = new List<string>();
        var unknown = new List<string>();

        foreach (var id in requested)
        {
            if (string.Equals(id, AllTargets, StringComparison.Ordinal))
            {
                foreach (var peer in availableOrder)
                {
                    if (seen.Add(peer))
                    {
                        targets.Add(peer);
                    }
                }

                continue;
            }

            if (!seen.Add(id))
            {
                continue;
            }

            if (available.Contains(id))
            {
                targets.Add(id);
            }
            else
            {
                unknown.Add(id);
            }
        }

        return new RelaySendPlan(targets, unknown);
    }
}
