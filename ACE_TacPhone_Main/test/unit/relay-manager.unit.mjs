/**
 * Unit tests for the in-game relay hub.
 *
 * `RelayManager` is deliberately browser-free: it owns the relay protocol and
 * all routing, while `NetworkingA3` supplies the request/terrain/texture
 * functions. These tests use a fake `RelayNetworking`, so they exercise the
 * wire decode, request rewrite/reply correlation, broadcast fan-out, interest
 * aggregation and the forbidden-command guard without Arma or a browser.
 */

import { assert, deepEqual, equal, includes, ok } from '../lib/assertions.mjs';
import { RelayManager } from '../../src/Backend/RelayManager.ts';

export const name = 'relay-manager';
export const description = 'hub transport decode, request correlation, broadcast, interests';

let keyCounter = 0;

// `Compression.ts` uses FileReader, which Node does not provide globally. The
// terrain branch of the hub uses it through `encodeTerrainChunks`.
if (typeof globalThis.FileReader === 'undefined') {
    globalThis.FileReader = class FileReader {
        result = null;
        onloadend = null;
        onerror = null;

        readAsDataURL(blob) {
            blob.arrayBuffer()
                .then(buffer => {
                    this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
                    this.onloadend?.();
                })
                .catch(error => this.onerror?.(error));
        }

        readAsArrayBuffer(blob) {
            blob.arrayBuffer()
                .then(buffer => {
                    this.result = buffer;
                    this.onloadend?.();
                })
                .catch(error => this.onerror?.(error));
        }
    };
}

function encode(text) {
    return Buffer.from(text, 'utf8').toString('base64');
}

function makeNet() {
    const direct = [];
    const tracked = [];

    const net = {
        async RequestDirect(data) {
            direct.push(data);

            if (data.c === 'RemoteAccess.GetAuthIdentity') return '';
            if (data.c === 'RemoteAccess.Start') {
                return { ok: true, webBase: 'https://relay.example' };
            }
            if (data.c === 'Interest.Set') return { ok: true };
            return { ok: true };
        },

        async RequestTracked(data, onKey, timeoutMs) {
            const key = `nr${keyCounter++}`;
            onKey(key);
            tracked.push({ data, key, timeoutMs });
            return { result: 'game-value' };
        },

        async LoadGameTerrain() {
            return {
                width: 16,
                height: 16,
                layers: [{ name: 'terrain', svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }],
            };
        },

        async LoadGameFileTexture() {
            return 'data:image/png;base64,AA==';
        },
    };

    return { net, direct, tracked };
}

function newManager(isDebug = true) {
    const state = makeNet();
    const manager = new RelayManager(state.net, () => isDebug);
    return { manager, ...state };
}

function relayMessage(text) {
    return `RELAY:${encode(text)}`;
}

function webhostMessage(text) {
    return `WEBHOST:${encode(text)}`;
}

function forwards(direct) {
    return direct.filter(entry => entry.c === 'RemoteAccess.Forward');
}

function forwardedFrames(direct) {
    return forwards(direct).map(entry => JSON.parse(entry.data));
}

async function waitFor(predicate, label, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    throw new Error(`Timed out waiting for ${label}`);
}

async function onlineManager() {
    const state = newManager();
    const start = await state.manager.TryHandleLocalRequest({
        a: 'main',
        c: 'RemoteAccess.Start',
        files: [{ path: 'addons/a.pbo', hash: 'abc' }],
    });

    ok(start, 'RemoteAccess.Start is handled by the hub');
    state.manager.OnRelayEvent('established');
    state.manager.OnTransportMessage(relayMessage(JSON.stringify({
        t: 'auth-ok',
        hostId: 'host-1',
        secret: 'secret-1',
    })));

    return state;
}

export async function run() {
    // ------------------------------------------------------------------
    // Start / auth / file manifest
    // ------------------------------------------------------------------
    {
        const { manager, direct } = await onlineManager();

        const identity = direct.find(entry => entry.c === 'RemoteAccess.SetAuthIdentity');
        ok(identity, 'auth-ok stores the host identity');
        deepEqual(JSON.parse(identity.identity), { hostId: 'host-1', secret: 'secret-1' });

        const auth = forwardedFrames(direct).find(frame => frame.t === 'auth');
        ok(auth, 'established sends the auth frame');
        equal(auth.role, 'game');
        equal(auth.hostId, undefined);

        const files = forwardedFrames(direct).find(frame => frame.t === 'files');
        ok(files, 'auth-ok sends the file manifest');
        equal(files.files.length, 1);

        const status = await manager.TryHandleLocalRequest({ a: 'main', c: 'RemoteAccess.Status' });
        equal(status.state, 'online');
        equal(status.hostId, 'host-1');
        equal(status.webBase, 'https://relay.example');
    }

    // ------------------------------------------------------------------
    // Duplicate established events send auth only once.
    // ------------------------------------------------------------------
    {
        const { manager, direct } = newManager();

        await manager.TryHandleLocalRequest({ a: 'main', c: 'RemoteAccess.Start' });
        manager.OnRelayEvent('established');
        manager.OnRelayEvent('established');

        const authFrames = forwardedFrames(direct).filter(frame => frame.t === 'auth');
        equal(authFrames.length, 1, 'one auth frame per socket');
    }

    // ------------------------------------------------------------------
    // Stop reports connected relay peers as disconnected.
    // ------------------------------------------------------------------
    {
        const { manager, direct } = await onlineManager();

        manager.OnTransportMessage(relayMessage(JSON.stringify({
            t: 'peer-joined',
            peerId: 'p_stop',
            label: 'phone',
            via: 'share',
            connectedAt: '2026-11-05T10:00:00Z',
            firstSeenAt: '2026-11-05T09:00:00Z',
        })));

        await manager.TryHandleLocalRequest({ a: 'main', c: 'RemoteAccess.Stop' });

        await waitFor(
            () => direct.some(entry => entry.c === 'Client.Disconnected' && entry.clientId === 'p_stop'),
            'the stopped peer disconnect',
        );
        ok(direct.some(entry => entry.c === 'RemoteAccess.Stop'), 'stop reaches SQF');
    }

    // ------------------------------------------------------------------
    // Remote request: one new A3API key, reply to the original client key.
    // ------------------------------------------------------------------
    {
        const { manager, direct, tracked } = await onlineManager();

        manager.OnTransportMessage(relayMessage(
            'p_client\n' + JSON.stringify({
                k: 'browser-key',
                d: { a: 'main', c: 'GetGameInfo' },
            }),
        ));

        await waitFor(() => tracked.length === 1, 'the forwarded request');
        const forwarded = tracked[0];
        deepEqual(forwarded.data, { a: 'main', c: 'GetGameInfo' });
        assert(!('__client' in forwarded.data), 'the hub must not send __client');
        assert(!('__requestKey' in forwarded.data), 'the hub must not send __requestKey');
        assert(!('__silent' in forwarded.data), 'the hub must not send __silent');

        await waitFor(
            () => forwardedFrames(direct).some(frame => frame.t === 'send'),
            'the routed reply',
        );
        const send = forwardedFrames(direct).find(frame => frame.t === 'send');
        deepEqual(send.targets, ['p_client']);
        deepEqual(JSON.parse(send.data), { k: 'browser-key', d: { result: 'game-value' } });
    }

    // ------------------------------------------------------------------
    // LAN request: reply through WebHost.Send, then disconnect removes it.
    // ------------------------------------------------------------------
    {
        const { manager, direct, tracked } = await onlineManager();

        manager.OnTransportMessage(webhostMessage(JSON.stringify({
            s: 'LOCAL_1',
            k: 'lan-key',
            d: { a: 'main', c: 'GetGameInfo' },
        })));

        await waitFor(() => tracked.length === 1, 'the LAN request');
        await waitFor(
            () => direct.some(entry => entry.c === 'WebHost.Send'),
            'the LAN reply',
        );

        const lanReply = direct.find(entry => entry.c === 'WebHost.Send');
        const payload = JSON.parse(lanReply.payload);
        deepEqual(payload.targets, ['LOCAL_1']);
        deepEqual(JSON.parse(payload.data), { k: 'lan-key', d: { result: 'game-value' } });

        manager.OnTransportMessage('WEBHOST_DISCONNECT:LOCAL_1');
        const before = direct.filter(entry => entry.c === 'WebHost.Send').length;
        manager.BroadcastGameMessage({ a: 'main', c: 'Ping' });
        await new Promise(resolve => setTimeout(resolve, 20));
        equal(
            direct.filter(entry => entry.c === 'WebHost.Send').length,
            before,
            'a disconnected LAN client receives no broadcast',
        );
    }

    // ------------------------------------------------------------------
    // Game push broadcast to all relay and LAN clients.
    // ------------------------------------------------------------------
    {
        const { manager, direct } = await onlineManager();

        manager.OnTransportMessage(webhostMessage(JSON.stringify({
            s: 'LOCAL_2',
            k: 'lan-key',
            d: { a: 'main', c: 'GetGameInfo' },
        })));

        manager.BroadcastGameMessage({ a: 'main', c: 'GPS.Update', position: [1, 2, 3] });
        await waitFor(
            () => forwardedFrames(direct).some(frame => frame.t === 'send' && frame.targets[0] === '*'),
            'the relay broadcast',
        );

        const relay = forwardedFrames(direct).find(frame => frame.t === 'send' && frame.targets[0] === '*');
        deepEqual(JSON.parse(relay.data), {
            k: 'command',
            d: { a: 'main', c: 'GPS.Update', position: [1, 2, 3] },
        });

        const lan = direct
            .filter(entry => entry.c === 'WebHost.Send')
            .find(entry => JSON.parse(entry.payload).targets[0] === '*');
        ok(lan, 'the LAN broadcast is sent');
        const lanPayload = JSON.parse(lan.payload);
        deepEqual(lanPayload.targets, ['*']);
        deepEqual(JSON.parse(lanPayload.data), {
            k: 'command',
            d: { a: 'main', c: 'GPS.Update', position: [1, 2, 3] },
        });
    }

    // ------------------------------------------------------------------
    // Interest aggregation uses Interest.Set active:false, not Interest.Clear.
    // ------------------------------------------------------------------
    {
        const { manager, direct } = await onlineManager();

        await manager.TryHandleLocalRequest({
            a: 'main',
            c: 'Interest.Set',
            interest: 'ACE_TacPhone_Map.gps',
            active: true,
        });
        await manager.TryHandleLocalRequest({
            a: 'main',
            c: 'Interest.Set',
            interest: 'ACE_TacPhone_Map.gps',
            active: false,
        });

        const interestCalls = direct.filter(entry => entry.c === 'Interest.Set');
        equal(interestCalls.length, 2, 'one activate and one deactivate request');
        equal(interestCalls[0].active, true);
        equal(interestCalls[1].active, false);
        assert(
            !direct.some(entry => entry.c === 'Interest.Clear'),
            'Interest.Clear must not be used for a single interest',
        );
    }

    // ------------------------------------------------------------------
    // Local-only commands are not laundered through the hub.
    // ------------------------------------------------------------------
    {
        const { manager, direct, tracked } = await onlineManager();

        for (const command of ['GetHostLog', 'WebHost.Send', 'Client.Disconnected', 'RemoteAccess.Status']) {
            manager.OnTransportMessage(relayMessage(
                'p_forbidden\n' + JSON.stringify({
                    k: command,
                    d: { a: 'main', c: command },
                }),
            ));
        }

        await waitFor(
            () => forwardedFrames(direct).filter(frame => frame.t === 'send').length >= 4,
            'the forbidden replies',
        );

        const replies = forwardedFrames(direct)
            .filter(frame => frame.t === 'send')
            .map(frame => JSON.parse(frame.data));
        for (const reply of replies) {
            equal(reply.d.ok, false);
            equal(reply.d.error, 'forbidden');
        }

        equal(tracked.length, 0, 'forbidden commands never reach SQF');
    }

    // ------------------------------------------------------------------
    // Texture reply is the texture string, not a ReplyRequestTexture wrapper.
    // ------------------------------------------------------------------
    {
        const { manager, direct } = await onlineManager();

        manager.OnTransportMessage(relayMessage(
            'p_texture\n' + JSON.stringify({
                k: 'texture-key',
                d: { a: 'main', c: 'RequestTexture', path: 'a.paa', maxSize: 128 },
            }),
        ));

        await waitFor(
            () => forwardedFrames(direct).some(frame => frame.t === 'send'),
            'the texture reply',
        );
        const send = forwardedFrames(direct).find(frame => frame.t === 'send');
        deepEqual(JSON.parse(send.data), {
            k: 'texture-key',
            d: 'data:image/png;base64,AA==',
        });
    }

    // ------------------------------------------------------------------
    // Terrain reply is streamed as ReplyRequestTerrainSVG chunks.
    // ------------------------------------------------------------------
    {
        const { manager, direct } = await onlineManager();

        manager.OnTransportMessage(relayMessage(
            'p_terrain\n' + JSON.stringify({
                k: 'terrain-key',
                d: { a: 'main', c: 'RequestTerrainSVG', config: { drawGrid: false } },
            }),
        ));

        await waitFor(
            () => forwardedFrames(direct).some(frame => {
                if (frame.t !== 'send') return false;
                const data = JSON.parse(frame.data);
                return data.d?.c === 'ReplyRequestTerrainSVG';
            }),
            'the terrain chunk',
            5000,
        );

        const frame = forwardedFrames(direct).find(item => {
            if (item.t !== 'send') return false;
            const data = JSON.parse(item.data);
            return data.d?.c === 'ReplyRequestTerrainSVG';
        });
        const data = JSON.parse(frame.data);
        equal(data.k, 'terrain-key');
        equal(data.d.count, 1);
        equal(data.d.index, 0);
        equal(data.d.name, 'terrain');
        assert(typeof data.d.data === 'string' && data.d.data.length > 0, 'the chunk has base64 data');
        includes(frame.targets, 'p_terrain');
    }
}
