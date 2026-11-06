// The JSON status object of the relay hub.
//
// The fields mirror the C# relay's status builder; keep them in lockstep with
// the game side but do not try to share code across the C# boundary.

import type { RelayPeer } from "./RelayPeers";

/** Connection state reported in the status object. */
export type RelayState = "idle" | "connecting" | "online" | "error";

/** Protocol version advertised by the hub. */
export const PROTOCOL_VERSION = 1;

/** Every field the status object reports, read from the hub at call time. */
export interface RelayStatusInput {
    state: RelayState;
    hostId: string;
    webBase: string;
    error: string;
    code: string;
    codeTtl: number;
    codeExpiresAt: number;
    shareKey: string;
    shareUrl: string;
    shareExpiresAt: number;
    peers: readonly RelayPeer[];
}

export function buildRelayStatus(input: RelayStatusInput): Record<string, unknown> {
    const now = Date.now();

    const peers = [...input.peers]
        .sort((a, b) => (a.connectedAt || a.firstSeenAt).localeCompare(b.connectedAt || b.firstSeenAt))
        .map(peer => ({ ...peer }));

    return {
        ok: true,
        proto: PROTOCOL_VERSION,
        state: input.state,
        hostId: input.hostId,
        webBase: input.webBase,
        error: input.error,
        code: now < input.codeExpiresAt ? input.code : "",
        codeExpiresIn: now < input.codeExpiresAt
            ? Math.max(0, Math.floor((input.codeExpiresAt - now) / 1000))
            : 0,
        codeTtl: input.codeTtl,
        share: input.shareKey && now < input.shareExpiresAt
            ? {
                url: input.shareUrl,
                key: input.shareKey,
                expiresIn: Math.max(0, Math.floor((input.shareExpiresAt - now) / 1000)),
            }
            : null,
        peerCount: peers.length,
        peers,
    };
}
