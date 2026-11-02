/**
 * Game-side GPS protocol checks for the Map app.
 *
 * Only the public request protocol is used (`a: "ACE_TacPhone_Map"` for the Map
 * app, `a: "main"` for interests and the travel mode), plus the Messenger
 * protocol for the `map.gps_route` round trip. No app or SQF source is imported.
 *
 * Covers:
 * 1. the `GetPlayerTravelMode` contract (foot baseline vs. vehicle performance),
 * 2. `Interest.Set` acquiring `ACE_TacPhone_Map.gps` starts `GPS.Update` pushes
 *    with the documented shape and the ~10 Hz rate,
 * 3. releasing the interest silences the handler, re-acquiring resumes it,
 *    and `Debug.GetInterests` (when present) shows the acquire/release state,
 * 4. a pre-encoded `map.gps_route` envelope (and a small plain object) is stored
 *    by the Messenger server byte-identically.
 *
 * The Messenger half needs a `__A3_DEBUG__` game (`Messaging.Debug.Status`); it
 * is skipped with a log message otherwise.
 *
 *   npm run test:map -- --scenario gps-protocol --verbose
 */

import { gzipSync, gunzipSync } from 'node:zlib';

import { assert, deepEqual, equal, isBoolean, isNumber, isObject, oneOf } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { skip } from '../../../ACE_TacPhone_Main/test/lib/skip.mjs';
import { WsClient, WsTimeoutError } from '../../../ACE_TacPhone_Main/test/lib/ws-client.mjs';

export const name = 'gps-protocol';
export const kind = 'node';
export const description = 'GetPlayerTravelMode, GPS.Update interest/rate/release + Debug.GetInterests, map.gps_route round trip';

const MAP_APP = 'ACE_TacPhone_Map';
const MESSAGING_APP = 'Messaging';
const GPS_INTEREST = 'ACE_TacPhone_Map.gps';
const GPS_COMMAND = 'GPS.Update';

/** Documented `GPS_UPDATE_INTERVAL` is 0.1 s; allow scheduling jitter. */
const MIN_PUSH_INTERVAL_MS = 80;
/** Pushes collected for the rate check. */
const RATE_SAMPLES = 5;
/** Silence window after releasing the interest (> 10 expected intervals). */
const SILENCE_MS = 1200;
/** Keys `GetPlayerTravelMode` promises for a vehicle. */
const PERFORMANCE_KEYS = ['maxSpeedKmh', 'massKg', 'widthM', 'lengthM', 'simulation'];
/** Property that marks a compressed chat object on the wire. */
const ENVELOPE_KEY = '__tacphoneObject';

function near(actual, expected, tolerance, message) {
    assert(
        Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
        `${message}\n  expected: ${expected} ± ${tolerance}\n  actual:   ${actual}`,
    );
}

/**
 * Builds the same envelope `objectCodec.encodeChatObjectsForStorage()` produces:
 * `{ kind, version, preview, __tacphoneObject: { v, codec, enc, d } }` where `d`
 * is gzip+base64 of `{ data, action }`.
 */
function buildStoredEnvelope(object) {
    const payloadJson = JSON.stringify({ data: object.data, action: object.action });
    const d = gzipSync(Buffer.from(payloadJson, 'utf8')).toString('base64');

    return {
        kind: object.kind,
        version: object.version,
        ...(object.preview === undefined ? {} : { preview: object.preview }),
        [ENVELOPE_KEY]: { v: 1, codec: 'gzip', enc: 'base64', d },
    };
}

/** Decodes an envelope produced by {@link buildStoredEnvelope}. */
function decodeStoredEnvelope(stored) {
    const envelope = stored?.[ENVELOPE_KEY];
    assert(envelope && typeof envelope.d === 'string', 'The stored object has no envelope payload');

    const json = gunzipSync(Buffer.from(envelope.d, 'base64')).toString('utf8');
    return JSON.parse(json);
}

/** A route payload the GPS decoder accepts, in metres relative to `origin`. */
function buildRouteData(origin) {
    const legPoints = [80, 0, 320, 120, 560, 260];
    const eta = Math.round((Math.hypot(240, 120) + Math.hypot(240, 140)) / 1.4);

    return {
        v: 1,
        origin: [origin[0], origin[1]],
        waypoints: [0, 0, 320, 120, 560, 260],
        legs: [{ mode: 'foot', kind: 'walk', points: legPoints, eta }],
        distance: Math.hypot(240, 120) + Math.hypot(240, 140),
        eta,
        author: 'GPS protocol',
        createdAt: 1234,
        label: 'Protocol route',
    };
}

/** The chat object the Map app sends into a room. */
function buildRouteObject(data) {
    return {
        kind: 'map.gps_route',
        version: 1,
        data,
        preview: {
            title: 'Protocol route',
            subtitle: 'Foot · 470 m · 2 waypoints',
            color: '#22d3ee',
        },
        action: {
            service: 'gps',
            panelId: 'ACE_TacPhone_Map_GPS',
            method: 'openSharedRoute',
            args: [data],
            policy: 'ask',
        },
    };
}

/** Minimal Messenger protocol helper: a room, one message, one cleanup. */
class MessengerProbe {
    constructor(client, { log } = {}) {
        this.client = client;
        this.log = log;
        this.timeout = 8000;
    }

    async identify() {
        const hello = await this.client.request('Hello', { visible: true }, { timeout: this.timeout });

        if (!hello?.ok || !hello.self?.uid) {
            throw new Error(`Hello did not return a usable identity: ${JSON.stringify(hello)}`);
        }

        return hello.self;
    }

    /** True when the game was built with `__A3_DEBUG__`. */
    async isDebugBuild() {
        try {
            const status = await this.client.request(
                'Messaging.Debug.Status',
                {},
                { timeout: this.timeout },
            );
            return status?.debug === true;
        } catch {
            return false;
        }
    }

    async _waitForReply(command, predicate) {
        const push = await this.client.waitForPush(
            null,
            (data) => {
                if (data?.c === 'Error' && data.request === command) {
                    return true;
                }

                return predicate(data);
            },
            this.timeout,
        );

        if (push.c === 'Error') {
            throw new Error(`${command} failed: ${push.message || 'unknown game error'}`);
        }

        return push;
    }

    /** Creates an empty group room owned by the local player. */
    async createRoom(name) {
        this.client.clearPushes(['Room.Upsert', 'Error']);
        await this.client.request(
            'CreateRoom',
            { room: { kind: 'group', name, playerUids: [], groupIds: [] } },
            { timeout: this.timeout },
        );

        const push = await this._waitForReply('CreateRoom', (data) =>
            data?.c === 'Room.Upsert' && data.room?.name === name);

        return push.room;
    }

    /** Sends one message with chat objects and returns the server echo. */
    async sendMessage(roomId, objects) {
        const clientMessageId = `gps-protocol-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

        this.client.clearPushes(['Message.New', 'Error']);
        await this.client.request('SendMessage', {
            roomId,
            clientMessageId,
            content: '',
            objects,
        }, { timeout: this.timeout });

        const push = await this._waitForReply('SendMessage', (data) =>
            data?.c === 'Message.New' && data.message?.clientMessageId === clientMessageId);

        return push.message;
    }

    /** Removes the local player; the last participant deletes the room. */
    async leaveRoom(roomId, uid) {
        await this.client.request(
            'RemoveParticipants',
            { roomId, playerUids: [uid] },
            { timeout: this.timeout },
        ).catch((error) => {
            this.log?.(`Could not remove the test room participant: ${error.message}`);
        });
    }
}

/** Asserts the shape of one `GPS.Update` push. */
function assertGpsUpdate(push) {
    equal(push.a, MAP_APP, 'GPS.Update must be sent by the Map app');
    equal(push.c, GPS_COMMAND, 'The push command must be GPS.Update');

    assert(Array.isArray(push.position) && push.position.length >= 2, 'GPS.Update.position must be an array');
    for (const value of push.position.slice(0, 3)) {
        isNumber(value, 'GPS.Update.position entries must be numbers');
        assert(Number.isFinite(value), 'GPS.Update.position entries must be finite');
    }

    assert(Array.isArray(push.view) && push.view.length === 3, 'GPS.Update.view must be a 3-component array');
    for (const value of push.view) {
        assert(Number.isFinite(value), 'GPS.Update.view entries must be finite');
    }

    assert(Number.isFinite(push.direction), 'GPS.Update.direction must be finite');
    assert(Number.isFinite(push.speed), 'GPS.Update.speed must be finite');
    assert(Array.isArray(push.velocity) && push.velocity.length === 3, 'GPS.Update.velocity must be a 3-component array');

    for (const value of push.velocity) {
        assert(Number.isFinite(value), 'GPS.Update.velocity entries must be finite');
    }

    // `speed` is km/h from `speed player`, `velocity` is m/s. Only compare them
    // when the player actually moves; both are independent engine values.
    if (push.speed > 1) {
        const derived = Math.hypot(push.velocity[0], push.velocity[1]) * 3.6;
        near(derived, push.speed, Math.max(2, push.speed * 0.5), 'GPS.Update speed/velocity disagree');
    }
}

/** True when the running mission serves the Map app. */
async function requireMapApp(client) {
    const available = await client.request('GetAvailableApps', {}, { app: 'main' }).catch(() => undefined);

    if (!available || !available[MAP_APP]) {
        skip(`The running mission does not serve the ${MAP_APP} app (old PBO?).`);
    }
}

/** §1: the travel-mode request contract. */
async function checkTravelMode(client, log) {
    const reply = await client.request('GetPlayerTravelMode', {}, { app: MAP_APP });
    isObject(reply, 'GetPlayerTravelMode must return an object');

    oneOf(reply.mode, ['foot', 'ground', 'boat', 'air'], 'GetPlayerTravelMode.mode is not a travel mode');
    isBoolean(reply.waterCapable, 'GetPlayerTravelMode.waterCapable must be a boolean');
    isObject(reply.performance, 'GetPlayerTravelMode.performance must be an object');
    assert(typeof reply.vehicleClass === 'string', 'GetPlayerTravelMode.vehicleClass must be a string');

    if (reply.mode === 'foot') {
        equal(reply.vehicleClass, '', 'On foot the vehicle class must be empty');
        equal(reply.waterCapable, false, 'On foot waterCapable must be false');
        deepEqual(reply.performance, {}, 'On foot the performance must be empty');
        log?.('Travel mode: foot baseline (no vehicle performance)');
        return reply;
    }

    assert(reply.vehicleClass !== '', 'A vehicle mode must report its config class');
    assert(
        Number.isFinite(reply.performance.maxSpeedKmh) && reply.performance.maxSpeedKmh > 0,
        'A vehicle must report a positive maxSpeedKmh',
    );

    for (const key of PERFORMANCE_KEYS) {
        assert(
            Object.prototype.hasOwnProperty.call(reply.performance, key),
            `Vehicle performance is missing ${key}: ${JSON.stringify(Object.keys(reply.performance))}`,
        );
    }

    if (reply.waterCapable) {
        equal(reply.mode, 'ground', 'Only a ground vehicle can be water capable');
    }

    log?.(`Travel mode: ${reply.mode} (${reply.vehicleClass}, max ${reply.performance.maxSpeedKmh} km/h)`);
    return reply;
}

/** §2/§3: interest acquisition, push shape and rate, release and re-acquire. */
async function debugInterests(client) {
    try {
        const reply = await client.request(
            'Debug.GetInterests',
            {},
            { app: 'main', timeout: 4000 },
        );
        return reply?.ok === true ? reply : null;
    } catch {
        return null;
    }
}

async function checkGpsInterest(client, log) {
    const setInterest = (active) => client.request(
        'Interest.Set',
        { interest: GPS_INTEREST, active },
        { app: 'main' },
    );

    const beforeInterests = await debugInterests(client);
    if (!beforeInterests) {
        log?.('Debug.GetInterests is not available in this PBO; interest snapshot checks skipped');
    }

    const acquired = await setInterest(true);
    equal(acquired?.ok, true, `Interest.Set active=true failed: ${JSON.stringify(acquired)}`);

    if (beforeInterests) {
        const during = await debugInterests(client);
        assert(during, 'Debug.GetInterests disappeared after Interest.Set');
        assert(
            JSON.stringify(during).includes(GPS_INTEREST),
            `Debug.GetInterests does not list ${GPS_INTEREST} after acquisition: ${JSON.stringify(during)}`,
        );
        log?.('Debug.GetInterests lists the acquired GPS interest');
    }

    try {
        // The game pushes one immediate fix on activation, then 10 Hz.
        const first = await client.waitForPush(GPS_COMMAND, (push) => Array.isArray(push?.position), 5000);
        assertGpsUpdate(first);
        log?.(`First GPS.Update: ${first.position.map((value) => value.toFixed(0)).join(',')} @ ${first.speed} km/h`);

        client.clearPushes([GPS_COMMAND]);
        const stamps = [];

        for (let index = 0; index < RATE_SAMPLES; index += 1) {
            const push = await client.waitForPush(GPS_COMMAND, (entry) => Array.isArray(entry?.position), 5000);
            assertGpsUpdate(push);
            stamps.push(Date.now());
        }

        const span = stamps[stamps.length - 1] - stamps[0];
        const average = span / (RATE_SAMPLES - 1);
        assert(
            average >= MIN_PUSH_INTERVAL_MS,
            `GPS.Update arrived every ${average.toFixed(0)} ms; the interval must be at least ${MIN_PUSH_INTERVAL_MS} ms`,
        );
        assert(span <= 3000, `Collecting ${RATE_SAMPLES} GPS.Update pushes took ${span} ms (expected < 3000)`);
        log?.(`GPS.Update rate: ${RATE_SAMPLES} pushes in ${span} ms (${average.toFixed(0)} ms average)`);

        // ---- release: the per-frame handler must stop --------------------
        const released = await setInterest(false);
        equal(released?.ok, true, `Interest.Set active=false failed: ${JSON.stringify(released)}`);

        client.clearPushes([GPS_COMMAND]);
        let silence = null;

        try {
            await client.waitForPush(GPS_COMMAND, undefined, SILENCE_MS);
        } catch (error) {
            silence = error;
        }

        assert(
            silence instanceof WsTimeoutError,
            'GPS.Update kept arriving after the interest was released (the per-frame handler is stuck)',
        );
        log?.(`No GPS.Update for ${SILENCE_MS} ms after releasing the interest`);

        if (beforeInterests) {
            const after = await debugInterests(client);
            assert(after, 'Debug.GetInterests disappeared after releasing the interest');
            const beforeJson = JSON.stringify(beforeInterests);
            const afterJson = JSON.stringify(after);
            if (beforeJson.includes(GPS_INTEREST)) {
                assert(
                    afterJson === beforeJson,
                    `The GPS interest did not return to its pre-acquire state: before=${beforeJson} after=${afterJson}`,
                );
            } else {
                assert(
                    !afterJson.includes(GPS_INTEREST),
                    `Debug.GetInterests still lists ${GPS_INTEREST} after release: ${afterJson}`,
                );
            }
            log?.('Debug.GetInterests no longer lists the released GPS interest');
        }

        // ---- re-acquire: pushes must resume ------------------------------
        const reacquired = await setInterest(true);
        equal(reacquired?.ok, true, 'Re-acquiring the GPS interest failed');
        const resumed = await client.waitForPush(GPS_COMMAND, (push) => Array.isArray(push?.position), 5000);
        assertGpsUpdate(resumed);
        log?.('GPS.Update resumed after re-acquiring the interest');
    } finally {
        await setInterest(false).catch(() => undefined);
    }
}

/** §4: the `map.gps_route` object survives the Messenger server unchanged. */
async function checkRouteRoundTrip(url, options, log) {
    const client = new WsClient(url, {
        app: MESSAGING_APP,
        name: 'gps-protocol-messaging',
        connectTimeout: options?.timeout ?? 8000,
        requestTimeout: options?.timeout ?? 8000,
        pushTimeout: options?.timeout ?? 8000,
        debug: options?.verbose === true,
    });

    const probe = new MessengerProbe(client, { log });
    let room = null;
    let self = null;

    try {
        await client.open();
        self = await probe.identify();

        if (!(await probe.isDebugBuild())) {
            log?.('Messaging.Debug.Status is unavailable; skipping the map.gps_route round trip');
            return;
        }

        room = await probe.createRoom(`TacPhone GPS protocol ${Date.now()}`);

        // ---- compressed envelope ----------------------------------------
        const origin = [1000, 2000];
        const data = buildRouteData(origin);
        const object = buildRouteObject(data);
        const stored = buildStoredEnvelope(object);

        const echo = await probe.sendMessage(room.id, [stored]);
        assert(Array.isArray(echo?.objects) && echo.objects.length === 1, 'The echo should carry one object');

        const echoed = echo.objects[0];
        equal(echoed.kind, 'map.gps_route', 'The stored object kind changed');
        equal(echoed.version, 1, 'The stored object version changed');
        deepEqual(echoed.preview, stored.preview, 'The stored preview changed');
        assert(echoed[ENVELOPE_KEY], 'The stored object lost its envelope');
        equal(echoed[ENVELOPE_KEY].d, stored[ENVELOPE_KEY].d, 'The stored envelope payload changed');
        deepEqual(
            Object.keys(echoed).sort(),
            Object.keys(stored).sort(),
            'The server added or removed keys on the stored object',
        );
        equal(echoed.data, undefined, 'A compressed stored object must not keep data');
        equal(echoed.action, undefined, 'A compressed stored object must not keep the action');

        const decoded = decodeStoredEnvelope(echoed);
        deepEqual(decoded.data, data, 'Decoding the stored envelope did not restore the route data');
        deepEqual(decoded.action, object.action, 'Decoding the stored envelope did not restore the action');
        deepEqual(decoded.data.legs, data.legs, 'The decoded legs changed');
        deepEqual(decoded.data.waypoints, data.waypoints, 'The decoded waypoints changed');
        log?.(`Stored envelope round-trips unchanged (${stored[ENVELOPE_KEY].d.length} base64 characters)`);

        // ---- plain small object -----------------------------------------
        const plain = {
            kind: 'map.gps_route',
            version: 1,
            data: {
                v: 1,
                origin: [0, 0],
                waypoints: [0, 0, 10, 10],
                legs: [{ mode: 'foot', kind: 'walk', points: [0, 0, 10, 10], eta: 10 }],
                distance: 14.142,
                eta: 10,
                author: 'GPS protocol',
                createdAt: 99,
            },
            preview: { title: 'Plain route', color: '#22d3ee' },
        };

        const payloadLength = JSON.stringify({ data: plain.data, action: plain.action }).length;
        assert(payloadLength < 512, `The plain test payload should stay below the compress threshold (${payloadLength})`);

        const plainEcho = await probe.sendMessage(room.id, [plain]);
        const plainStored = plainEcho?.objects?.[0];
        assert(plainStored, 'The plain object echo is missing');
        deepEqual(plainStored, plain, 'A small plain object must round-trip unchanged (no envelope added)');
        equal(plainStored[ENVELOPE_KEY], undefined, 'The server must not add an envelope to a plain object');
        log?.('A plain map.gps_route object round-trips byte-identically');
    } finally {
        if (room && self) {
            await probe.leaveRoom(room.id, self.uid);
        }

        await client.close().catch(() => undefined);
    }
}

export async function run(context) {
    const { client, url, options, log } = context;

    await requireMapApp(client);

    await checkTravelMode(client, log);
    await checkGpsInterest(client, log);
    await checkRouteRoundTrip(url, options, log);
}
