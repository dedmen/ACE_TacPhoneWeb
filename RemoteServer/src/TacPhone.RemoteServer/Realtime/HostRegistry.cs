using System.Collections.Concurrent;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// The single in-memory owner of online hosts. Only one process may host a
/// registry (no clustering), which is why the server is documented as a
/// single-instance deployment.
/// </summary>
public sealed class HostRegistry
{
    private readonly ConcurrentDictionary<string, HostSession> _hosts = new(StringComparer.Ordinal);

    public int HostCount => _hosts.Count;

    public int ClientCount
    {
        get
        {
            var count = 0;
            foreach (var host in _hosts.Values)
            {
                count += host.Clients.Count;
            }

            return count;
        }
    }

    public HostSession? Get(string hostId) =>
        _hosts.TryGetValue(hostId, out var host) ? host : null;

    public bool Contains(string hostId) => _hosts.ContainsKey(hostId);

    /// <summary>
    /// Registers <paramref name="session"/>, replacing (and returning) a previous
    /// session for the same host id. The caller closes the displaced socket.
    /// </summary>
    public HostSession? AddOrReplace(HostSession session)
    {
        ArgumentNullException.ThrowIfNull(session);
        HostSession? displaced = null;

        _hosts.AddOrUpdate(
            session.HostId,
            session,
            (_, existing) =>
            {
                displaced = existing;
                return session;
            });

        return displaced;
    }

    /// <summary>Removes the session only when it is still the registered one.</summary>
    public bool Remove(string hostId, HostSession session) =>
        _hosts.TryRemove(new KeyValuePair<string, HostSession>(hostId, session));

    public IReadOnlyList<HostSession> Snapshot() => _hosts.Values.ToArray();

    public void Clear() => _hosts.Clear();
}
