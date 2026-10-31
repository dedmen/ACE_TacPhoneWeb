/**
 * Public relay remote-share test.
 *
 * Arms the RemoteAccess relay through the debug bridge, creates a share link,
 * connects several clients to the same share, verifies they receive a message,
 * then closes one and verifies the host drops the dead target before the next
 * message.
 */

import { assert, equal, ok } from '../lib/assertions.mjs';
import { delay, uniqueRoomName } from '../lib/fake-players.mjs';
import { collectChatState, openClient } from '../lib/ws-client.mjs';

export const name = 'remote-share';
export const description = 'Remote relay share link, multiple clients and dead-peer cleanup.';

async function remoteCall(client, action, extra = {}) {
    client.clearPushes(['Debug.RemoteAccess', 'Error']);
    await client.request('Messaging.Debug.RemoteAccess', { action, ...extra }, { timeout: 15000 });

    const push = await client.waitForPush(
        'Debug.RemoteAccess',
        data => data.action === action,
        15000,
    );

    return push.result || {};
}

async function waitForStatus(client, predicate, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    let last;

    while (Date.now() < deadline) {
        last = await remoteCall(client, 'status');
        if (predicate(last)) return last;
        await delay(500);
    }

    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

export async function run(context) {
    const { client, fake } = context;

    await fake.reset();
    await fake.addFakePlayers();

    // Start from a clean relay session; a share left over from manual testing
    // is replaced by ShareCreate and cannot be used by the test clients.
    await remoteCall(client, 'stop').catch(() => {});

    const start = await remoteCall(client, 'start');

    if (start.ok === false) {
        throw new Error(`RemoteAccess.Start failed: ${start.error || 'unknown error'}`);
    }

    await waitForStatus(client, status => status.state === 'online', 'relay online');

    const shareCreate = await remoteCall(client, 'share', { ttlSeconds: 900 });

    if (shareCreate.ok === false) {
        throw new Error(`RemoteAccess.ShareCreate failed: ${shareCreate.error || 'unknown error'}`);
    }

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
                name: `share-${index + 1}`,
                origin: remoteOrigin,
                shareKey: share.key,
                connectTimeout: 30000,
                requestTimeout: 15000,
                pushTimeout: 15000,
                debug: false,
            });

            const hello = await remote.request('Hello', { visible: true }, { timeout: 15000 });
            assert(hello?.ok && hello.self?.uid, `Share client ${index + 1} should connect and get an identity.`);
            remotes.push(remote);
        }

        const room = await fake.createGroupRoom(uniqueRoomName('T7 remote'), ['fake_1']);
        const content = `Remote fanout ${Date.now()}`;

        // A remote page that opens after the room exists must receive the same
        // full room history as the in-game page, not only live pushes.
        for (const [index, remote] of remotes.entries()) {
            remote.clearPushes(['ChatState.Room', 'ChatState.Done']);
            await remote.request('RequestChatState', {}, { timeout: 15000 });
            const state = await collectChatState(remote, { clearBefore: false, timeout: 15000 });

            assert(
                state.rooms.has(room.id),
                `Share client ${index + 1} should receive room ${room.id} in its initial sync.`,
            );
        }

        client.clearPushes('Message.New');
        for (const remote of remotes) remote.clearPushes('Message.New');

        await fake.sendMessage(room.id, content);

        for (const [index, remote] of remotes.entries()) {
            const push = await remote.waitForPush(
                'Message.New',
                data => data.message?.content === content,
                15000,
            );
            equal(push.message.content, content, `Share client ${index + 1} should receive the message.`);
        }

        // Close one remote and wait until the host has removed its client id.
        const dead = remotes.pop();
        const deadPeer = dead.remotePeerId;
        await dead.close();
        ok(deadPeer, 'The relay should report the peer id for a share client.');

        const removalDeadline = Date.now() + 15000;
        let clients = [];

        while (Date.now() < removalDeadline) {
            const status = await client.request('Messaging.Debug.Status', {}, { timeout: 5000 });
            clients = Array.isArray(status?.clients) ? status.clients : [];

            if (!clients.includes(deadPeer)) break;

            await delay(200);
        }

        assert(
            !clients.includes(deadPeer),
            `The host should drop the disconnected share peer ${deadPeer}; still has ${clients.join(', ')}`,
        );

        const afterClose = `Remote fanout after close ${Date.now()}`;
        for (const remote of remotes) remote.clearPushes('Message.New');
        await fake.sendMessage(room.id, afterClose);

        for (const [index, remote] of remotes.entries()) {
            const push = await remote.waitForPush(
                'Message.New',
                data => data.message?.content === afterClose,
                15000,
            );
            equal(push.message.content, afterClose, `Remaining share client ${index + 1} should receive the message.`);
        }
    } finally {
        for (const remote of remotes) {
            await remote.close().catch(() => {});
        }

        await remoteCall(client, 'stop').catch(() => {});
    }
}
