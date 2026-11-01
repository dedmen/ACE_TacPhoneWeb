/**
 * Remote Access runtime test.
 *
 * The root RemoteAccess.* commands are deliberately local-only, so this uses
 * the `Debug.RemoteAccess` bridge in the main app. The bridge requires the
 * server-controlled "Allow debug mode" CBA setting; without it the runner skips
 * this scenario. It arms the relay, creates a share link, opens real relay
 * clients and verifies they can call a main command, then checks that a
 * disconnected peer is dropped.
 */

import { assert, equal, includes, isType, ok } from '../lib/assertions.mjs';
import { openClient } from '../lib/ws-client.mjs';

export const name = 'remote-access';
export const description = 'RemoteAccess start, share link, relay clients and dead-peer cleanup';
export const requiresDebug = true;

const DEBUG_COMMAND = 'Debug.RemoteAccess';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function remoteCall(client, action, extra = {}) {
    const result = await client.request(
        DEBUG_COMMAND,
        { action, ...extra },
        { timeout: 15000 },
    );

    isType(result, 'object', `RemoteAccess debug action "${action}" must return an object`);
    return result;
}

async function waitForStatus(client, predicate, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    let last;

    while (Date.now() < deadline) {
        last = await remoteCall(client, 'status');
        if (predicate(last))
            return last;

        await delay(500);
    }

    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

export async function run({ client }) {
    // A leftover relay session from manual testing must not be reused.
    await remoteCall(client, 'stop').catch(() => {});

    const start = await remoteCall(client, 'start');
    if (start.ok === false)
        throw new Error(`RemoteAccess.Start failed: ${start.error || 'unknown error'}`);

    await waitForStatus(client, status => status.state === 'online', 'relay online');

    const shareReply = await remoteCall(client, 'share', { ttlSeconds: 900 });
    if (shareReply.ok === false)
        throw new Error(`RemoteAccess.ShareCreate failed: ${shareReply.error || 'unknown error'}`);

    const statusWithShare = await waitForStatus(
        client,
        status => typeof status.share?.key === 'string' && status.share.key.length > 0,
        'share key',
    );

    const share = statusWithShare.share;
    const shareUrl = new URL(share.url);
    const remoteUrl = `wss://${shareUrl.host}/ws`;
    const remoteOrigin = shareUrl.origin;

    const remotes = [];

    try {
        for (let index = 0; index < 3; index += 1) {
            const remote = await openClient(remoteUrl, {
                app: 'main',
                name: `share-${index + 1}`,
                origin: remoteOrigin,
                shareKey: share.key,
                connectTimeout: 30000,
                requestTimeout: 15000,
                pushTimeout: 15000,
            });

            // A relay client must be able to reach the game through the share.
            const info = await remote.request('GetGameInfo', {}, { timeout: 15000 });
            isType(info, 'object', `Share client ${index + 1} did not reach the game`);
            assert(
                typeof info.terrainName === 'string' && info.terrainName.length > 0,
                `Share client ${index + 1} received an invalid GetGameInfo reply`,
            );

            ok(remote.remotePeerId, `Share client ${index + 1} did not receive a relay peer id`);
            remotes.push(remote);
        }

        const peersStatus = await waitForStatus(
            client,
            status => (status.peers?.length ?? 0) >= 3,
            'three connected relay peers',
        );

        const peerIds = peersStatus.peers.map(peer => peer.id);

        for (const [index, remote] of remotes.entries()) {
            includes(
                peerIds,
                remote.remotePeerId,
                `RemoteAccess.Status is missing share client ${index + 1} (${remote.remotePeerId})`,
            );
        }

        // Closing a relay client must drop it from the host's peer list.
        // Abort instead of sending a close frame: this reproduces a killed
        // browser/tab, which must also be treated as a normal disconnect.
        const dead = remotes.pop();
        const deadPeer = dead.remotePeerId;
        dead.abort();

        const removalDeadline = Date.now() + 15000;
        let remaining = [];

        while (Date.now() < removalDeadline) {
            const status = await remoteCall(client, 'status');
            remaining = Array.isArray(status.peers) ? status.peers.map(peer => peer.id) : [];

            if (!remaining.includes(deadPeer))
                break;

            await delay(200);
        }

        assert(
            !remaining.includes(deadPeer),
            `The host should drop the disconnected share peer ${deadPeer}; still has ${remaining.join(', ')}`,
        );

        // The remaining share clients must still work after the dead peer is gone.
        for (const [index, remote] of remotes.entries()) {
            const info = await remote.request('GetGameInfo', {}, { timeout: 15000 });
            isType(info, 'object', `Remaining share client ${index + 1} stopped reaching the game`);
        }

        equal(remotes.length, 2, 'Two share clients should remain connected');
    } finally {
        for (const remote of remotes) {
            await remote.close().catch(() => {});
        }

        await remoteCall(client, 'stop').catch(() => {});
    }
}
