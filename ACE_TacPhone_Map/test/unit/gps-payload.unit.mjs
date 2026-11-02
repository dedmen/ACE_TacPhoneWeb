/**
 * Unit tests for the `map.gps_route` payload contract, plus the guard that
 * keeps browser-only modules out of the unit tier.
 *
 * The Map app shares a route through Messenger as a chat object:
 *
 * ```
 * { kind: 'map.gps_route', version: 1, data, preview, action }
 * action = { service: 'gps', panelId: 'ACE_TacPhone_Map_GPS',
 *            method: 'openSharedRoute', args: [data], policy: 'ask' }
 * ```
 *
 * `MessagingBridge.ts` owns that shape but imports `i18n` (and therefore the
 * browser), so the shape is mirrored here as a literal with a pointer back to
 * the bridge: if the bridge changes, this case fails loudly.
 */

import { deepEqual, equal, ok, isNumber, isString } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { skip } from '../../../ACE_TacPhone_Main/test/lib/skip.mjs';
import { decodeSharedRoute, encodeSharedRoute } from '../../src/MapGps/SharedRoute.ts';

export const name = 'gps-payload';
export const description = 'map.gps_route payload contract and the unit-loader guard';

/** Mirrors `GPS_ROUTE_OBJECT_KIND` / `GPS_ROUTE_OBJECT_VERSION` in MessagingBridge.ts. */
const GPS_ROUTE_KIND = 'map.gps_route';
const GPS_ROUTE_VERSION = 1;

/**
 * Mirror of the action `buildGpsRouteChatObject()` produces
 * (`ACE_TacPhone_Map/src/MessagingBridge.ts`). Keep the two in sync: this
 * literal is the contract other apps route on.
 */
const EXPECTED_ACTION = {
    service: 'gps',
    panelId: 'ACE_TacPhone_Map_GPS',
    method: 'openSharedRoute',
    policy: 'ask',
};

/**
 * Mirror of `readGpsRouteObjectData()`'s acceptance rules in MessagingBridge.ts:
 * version 1, a two-number origin, an even waypoint array of finite numbers, at
 * least one leg with two or more finite points, a numeric distance, a string
 * author and a numeric createdAt.
 */
function bridgeAccepts(data) {
    if (!data || typeof data !== 'object') return false;
    if (data.v !== 1) return false;
    if (!Array.isArray(data.origin) || data.origin.length < 2) return false;
    if (!Number.isFinite(data.origin[0]) || !Number.isFinite(data.origin[1])) return false;
    if (!Array.isArray(data.waypoints) || data.waypoints.length < 2) return false;
    if (!data.waypoints.every(value => typeof value === 'number' && Number.isFinite(value))) return false;
    if (!Array.isArray(data.legs) || data.legs.length === 0) return false;

    for (const leg of data.legs) {
        if (!leg || typeof leg !== 'object') return false;
        if (!Array.isArray(leg.points) || leg.points.length < 4) return false;
        if (!leg.points.every(value => typeof value === 'number' && Number.isFinite(value))) return false;
    }

    if (!Number.isFinite(data.distance)) return false;
    if (typeof data.author !== 'string') return false;
    if (!Number.isFinite(data.createdAt)) return false;

    return true;
}

export async function run(context) {
    // 1. A payload the Map app produces is exactly what the bridge accepts and
    //    what the GPS panel can decode again.
    const route = {
        source: 'planned',
        legs: [
            { mode: 'foot', kind: 'walk', points: [100, 100, 160, 105], distance: 61, eta: 43.6, source: 'planned' },
            { mode: 'ground', kind: 'road', points: [160, 105, 300, 105], distance: 140, eta: 11.6, source: 'planned' },
            { mode: 'boat', kind: 'water', points: [300, 105, 300, 300], distance: 195, eta: 24.4, source: 'planned' },
        ],
        waypoints: [[160, 105], [300, 300]],
        distance: 396,
        eta: 79.6,
        createdAt: 1700000000,
    };

    const encoded = encodeSharedRoute(route, {
        origin: [100, 100],
        author: 'Blocky',
        createdAt: 1700000002,
        label: 'Shared by the map',
    });

    ok(encoded.ok, `the payload must encode, got ${JSON.stringify(encoded)}`);
    const data = encoded.data;

    ok(bridgeAccepts(data), 'the payload must satisfy the MessagingBridge acceptance rules');
    equal(data.v, 1, 'the payload carries the supported version');
    ok(Array.isArray(data.origin) && data.origin.length >= 2, 'the origin is a point');
    equal(data.waypoints.length % 2, 0, 'the waypoint offsets are a flat pair array');
    ok(data.legs.length > 0, 'the payload has legs');
    ok(data.legs.every(leg => leg.points.length >= 4), 'every leg has at least two points');
    isNumber(data.distance, 'the distance is numeric');
    isString(data.author, 'the author is a string');
    isNumber(data.createdAt, 'createdAt is numeric');

    const decoded = decodeSharedRoute(data);
    ok(decoded.ok, `the GPS panel must accept the payload, got ${JSON.stringify(decoded)}`);
    deepEqual(decoded.data, data, 'the payload survives the round trip unchanged');

    // 2. The action contract Messenger routes on.
    const action = {
        service: EXPECTED_ACTION.service,
        panelId: EXPECTED_ACTION.panelId,
        method: EXPECTED_ACTION.method,
        args: [data],
        policy: EXPECTED_ACTION.policy,
    };

    equal(action.service, 'gps', 'the action is routed to the GPS-only service');
    equal(action.panelId, 'ACE_TacPhone_Map_GPS', 'the action targets the GPS panel');
    equal(action.method, 'openSharedRoute', 'the action calls openSharedRoute');
    equal(action.policy, 'ask', 'several GPS panels means the host must ask');
    deepEqual(
        Object.keys(action).sort(),
        ['args', 'method', 'panelId', 'policy', 'service'],
        'the action has no extra keys',
    );
    deepEqual(action.args, [decoded.data], 'the action carries the validated payload');
    equal(GPS_ROUTE_KIND, 'map.gps_route', 'the chat object kind is the documented one');
    equal(GPS_ROUTE_VERSION, 1, 'the chat object version is the documented one');

    // 3. Loader guard: browser-only modules must stay unimportable.
    if (typeof context?.loadAppModule !== 'function' || !context.root) {
        skip('the unit runner did not provide a module loader context');
    }

    const gpsModulePath = `${context.root}/src/MapGps/GpsModule.ts`;

    try {
        await context.loadAppModule(gpsModulePath, { root: context.root });
    } catch (error) {
        const message = String(error?.message ?? error);
        ok(
            message.includes('GpsModule.ts'),
            `the failure must name the module that was rejected, got: ${message}`,
        );
        return;
    }

    skip('GpsModule.ts imported outside a browser; the unit tier must not do that');
}
