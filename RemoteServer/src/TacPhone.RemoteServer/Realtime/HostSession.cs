using System.Collections.Concurrent;
using TacPhone.RemoteServer.Infrastructure;

namespace TacPhone.RemoteServer.Realtime;

/// <summary>
/// In-memory state of one online game host: its socket, its attached peers and
/// the live share metadata. Mutations that need consistency (attach, detach,
/// kick, share replacement) take <see cref="Gate"/>; frame routing reads
/// <see cref="Clients"/> without it and never awaits a peer while the gate is
/// held.
/// </summary>
public sealed class HostSession
{
    /// <summary>Maximum number of one-time codes a host may mint per minute.</summary>
    public const int CodeMintsPerMinute = 10;

    public HostSession(string hostId, RelaySocket game, string shareBaseUrl, DateTimeOffset? shareExpiresAt = null, string? shareId = null)
    {
        ArgumentException.ThrowIfNullOrEmpty(hostId);
        ArgumentNullException.ThrowIfNull(game);
        HostId = hostId;
        Game = game;
        ShareBaseUrl = shareBaseUrl;
        ShareId = shareId;
        ShareExpiresAt = shareExpiresAt;
    }

    public string HostId { get; }

    public RelaySocket Game { get; }

    /// <summary>Scheme + authority used to build <c>#s=</c> links, without a trailing slash.</summary>
    public string ShareBaseUrl { get; }

    public ConcurrentDictionary<string, ClientSession> Clients { get; } = new(StringComparer.Ordinal);

    /// <summary>Guards the fields below and the attach/detach critical sections.</summary>
    public SemaphoreSlim Gate { get; } = new(1, 1);

    /// <summary>Id of the single active share, or <c>null</c>.</summary>
    public string? ShareId { get; set; }

    public DateTimeOffset? ShareExpiresAt { get; set; }

    /// <summary>Start of the current code-mint window (unix seconds).</summary>
    public long CodeMintWindowStartUnix { get; set; }

    public int CodeMintsInWindow { get; set; }

    public string NewPeerId()
    {
        for (var attempt = 0; attempt < 16; attempt++)
        {
            var peerId = "p_" + CrockfordBase32.Random(CrockfordBase32.PeerIdLength);
            if (!Clients.ContainsKey(peerId))
            {
                return peerId;
            }
        }

        // Astronomically unlikely; still unique because of the longer suffix.
        return "p_" + CrockfordBase32.Random(CrockfordBase32.PeerIdLength * 2);
    }

    /// <summary>Builds the public share URL for <paramref name="key"/>.</summary>
    public string BuildShareUrl(string key) => $"{ShareBaseUrl}/#s={key}";
}
