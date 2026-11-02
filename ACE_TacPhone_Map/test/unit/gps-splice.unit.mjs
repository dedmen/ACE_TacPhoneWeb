/**
 * Unit tests for the route geometry/splice helpers (`RouteSplice.ts`) and the
 * shared-route codec (`SharedRoute.ts`).
 *
 * These are the maths behind "accept the advisor alternative splices only up to
 * the next waypoint", the off-route/remaining calculation and `map.gps_route`
 * sharing. All of it is pure, so the cases here replace a live drive.
 */

import { deepEqual, equal, ok, fail } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    buildRouteGeometry,
    findLegIndex,
    flattenToCoordinates,
    projectionAlong,
    sliceLegsFrom,
} from '../../src/MapGps/RouteSplice.ts';
import {
    SHARED_ROUTE_MAX_POINTS,
    decodeSharedRoute,
    encodeSharedRoute,
    sharedRoutePointCount,
    sharedRoutePrimaryMode,
    sharedRouteUsesMode,
    sharedRouteWalkDistance,
    simplifyFlat,
} from '../../src/MapGps/SharedRoute.ts';
import { polylineLength, projectPointToPolyline } from '../../src/MapGps/SharedRoute.ts';

export const name = 'gps-splice';
export const description = 'Route geometry/splice helpers and the shared route codec';

const RELATIVE_TOLERANCE = 1e-9;

function approx(actual, expected, message) {
    if (!Number.isFinite(actual)) {
        fail(`${message}: expected ≈ ${expected}, got ${actual}`);
    }

    const tolerance = RELATIVE_TOLERANCE * Math.max(1, Math.abs(expected));
    if (Math.abs(actual - expected) > tolerance) {
        fail(`${message}: expected ≈ ${expected}, got ${actual} (tolerance ${tolerance})`);
    }
}

function leg(mode, kind, points, distance, eta, source) {
    const result = { mode, kind, points, distance, eta };
    if (source) {
        result.source = source;
    }
    return result;
}

export async function run() {
    // 1. buildRouteGeometry de-duplicates the shared vertex between legs.
    const walk = leg('foot', 'walk', [0, 0, 10, 0, 20, 0], 20, 14.3, 'shared');
    const road = leg('ground', 'road', [20, 0, 20, 10], 10, 1.2, 'shared');
    const geometry = buildRouteGeometry([walk, road]);

    deepEqual(geometry.points, [0, 0, 10, 0, 20, 0, 20, 10], 'shared vertices are de-duplicated');
    equal(geometry.legStarts.length, 2, 'one start index per leg');
    deepEqual(geometry.legStarts, [0, 3], 'leg starts point at flat point indices');
    ok(
        geometry.total >= polylineLength(geometry.points),
        'the total is never below the polyline length',
    );
    approx(geometry.total, 30, 'the total is the sum of the leg distances');

    // 2. Slicing at the very first segment with the first point prepended is a no-op.
    const fromStart = sliceLegsFrom([walk, road], geometry, 0, [0, 0]);
    equal(fromStart.length, 2, 'both legs survive a slice at segment 0');
    deepEqual(fromStart[0].points, walk.points, 'the first leg keeps its geometry');
    deepEqual(fromStart[1].points, road.points, 'the second leg is untouched');
    equal(fromStart[0].mode, 'foot', 'the modes are kept');
    equal(fromStart[1].mode, 'ground', 'the modes are kept');

    // 3. Slicing mid-leg keeps the remaining piece and scales its eta.
    const midSlice = sliceLegsFrom([walk, road], geometry, 1, [12, 0]);
    equal(midSlice.length, 2, 'the cut leg and the next leg survive');
    deepEqual(midSlice[0].points, [12, 0, 20, 0], 'the cut leg starts at the prepended point');
    approx(midSlice[0].distance, 8, 'the cut leg keeps only its remaining length');
    approx(midSlice[0].eta, 14.3 * (8 / 20), 'the eta is scaled by distance / leg.distance');
    deepEqual(midSlice[1].points, road.points, 'legs after the cut are unchanged');
    approx(midSlice[1].distance, 10, 'legs after the cut keep their distance');
    approx(midSlice[1].eta, 1.2, 'legs after the cut keep their eta');

    // 4. Slicing at a waypoint drops everything before it.
    const connector = leg('foot', 'walk', [0, 0, 0, 10], 10, 7.1, 'connector');
    const toWaypoint = leg('ground', 'road', [0, 10, 40, 10], 40, 4.8, 'shared');
    const destination = leg('boat', 'water', [40, 10, 40, 50], 40, 6.7, 'shared');
    const waypointGeometry = buildRouteGeometry([connector, toWaypoint, destination]);
    deepEqual(waypointGeometry.legStarts, [0, 2, 3], 'three legs with the shared vertices dropped');

    const waypointSlice = sliceLegsFrom(
        [connector, toWaypoint, destination],
        waypointGeometry,
        2,
        null,
    );
    equal(waypointSlice.length, 1, 'only the destination leg survives the waypoint cut');
    equal(waypointSlice[0].kind, 'water', 'the leg containing the waypoint is kept');
    deepEqual(waypointSlice[0].points, [40, 10, 40, 50], 'the destination leg keeps its geometry');
    approx(waypointSlice[0].distance, 40, 'the destination distance is unchanged');
    deepEqual(waypointSlice[0].points.slice(-2), [40, 50], 'the destination survives');

    // With a prepended point the cut leg is kept from that point, which can be
    // a zero-length stub when the cut lands exactly on its next vertex.
    const prepended = sliceLegsFrom(
        [connector, toWaypoint, destination],
        waypointGeometry,
        2,
        [40, 10],
    );
    equal(prepended.length, 2, 'the cut leg and the destination survive with a prepend');
    deepEqual(prepended[0].points, [40, 10, 40, 10], 'the cut leg starts at the prepended point');
    approx(prepended[0].distance, 0, 'the stub has no length left');
    equal(prepended[0].eta, 0, 'the stub eta scales to zero');
    deepEqual(prepended[1].points, destination.points, 'the destination leg is untouched');

    // 5. findLegIndex.
    equal(findLegIndex([0, 3, 5], -1), 0, 'a negative segment clamps to the first leg');
    equal(findLegIndex([0, 3, 5], 0), 0, 'the first point belongs to the first leg');
    equal(findLegIndex([0, 3, 5], 2), 0, 'a segment inside the first leg');
    equal(findLegIndex([0, 3, 5], 3), 1, 'the boundary belongs to the next leg');
    equal(findLegIndex([0, 3, 5], 4), 1, 'a segment inside the second leg');
    equal(findLegIndex([0, 3, 5], 5), 2, 'the last leg start');
    equal(findLegIndex([0, 3, 5], 99), 2, 'an out-of-range segment clamps to the last leg');
    equal(findLegIndex([], 2), 0, 'no legs still resolves to index 0');

    // 6. Projection onto a known zig-zag.
    const zigzag = [0, 0, 10, 0, 10, 10, 0, 10];
    const near = projectPointToPolyline(5, 1, zigzag);
    deepEqual(near.point, [5, 0], 'the nearest point is the projection on the first segment');
    approx(near.distance, 1, 'the distance is perpendicular');
    approx(near.along, 5, 'the along distance is the travelled length');
    equal(near.segment, 0, 'the segment index is the start point index');

    const past = projectPointToPolyline(5, 20, zigzag);
    deepEqual(past.point, [5, 10], 'a point past the end clamps to the final segment');
    equal(past.segment, 2, 'the clamped projection reports the final segment');
    approx(past.along, 25, 'the clamped along distance is the whole polyline minus 5 m');
    approx(past.distance, 10, 'the clamped distance is the perpendicular offset');

    approx(projectionAlong([5, 20], zigzag), past.along, 'projectionAlong agrees with the projection');
    approx(projectionAlong([0, 0], zigzag), 0, 'the first point is at along 0');
    equal(projectionAlong([0, 0], []), null, 'an empty polyline has no projection');
    equal(flattenToCoordinates([0, 0, 1, 2]).length, 2, 'flattenToCoordinates pairs the values');
    deepEqual(flattenToCoordinates([0, 0, 1, 2]), [[0, 0], [1, 2]], 'flattenToCoordinates keeps order');

    // 7. encode/decode round trip of a three-leg route.
    const route = {
        source: 'planned',
        legs: [
            leg('foot', 'walk', [100, 200, 150, 200, 160, 205], 51.1, 36.5, 'planned'),
            leg('ground', 'road', [160, 205, 300, 205], 140, 11.6, 'planned'),
            leg('boat', 'water', [300, 205, 300, 400], 195, 24.4, 'planned'),
        ],
        waypoints: [[160, 205], [300, 400]],
        distance: 386.1,
        eta: 72.5,
        createdAt: 1700000000,
    };

    const encoded = encodeSharedRoute(route, {
        origin: [100, 200],
        author: 'Tester',
        createdAt: 1700000001,
        label: 'Test route',
        vehicle: { maxSpeedKmh: 60 },
    });

    ok(encoded.ok, `the synthetic route must encode, got ${JSON.stringify(encoded)}`);
    const data = encoded.data;

    equal(data.v, 1, 'payload version');
    deepEqual(data.origin, [100, 200], 'the origin is the requested point');
    deepEqual(data.waypoints, [60, 5, 200, 200], 'waypoints are integer offsets from the origin');
    ok(data.waypoints.every(Number.isInteger), 'all waypoint offsets are integers');
    equal(data.legs.length, 3, 'one leg per route leg');
    equal(data.legs[0].mode, 'foot', 'leg modes are kept');
    equal(data.legs[0].kind, 'walk', 'leg kinds are kept');
    equal(data.legs[2].kind, 'water', 'leg kinds are kept');
    equal(data.legs[0].eta, Math.round(36.5), 'leg etas are rounded');
    equal(data.distance, 386.1, 'the distance is copied');
    equal(data.eta, Math.round(72.5), 'the total eta is rounded');
    equal(data.author, 'Tester', 'the author is copied');
    equal(data.createdAt, 1700000001, 'createdAt is copied');
    equal(data.label, 'Test route', 'the label is copied');
    deepEqual(data.vehicle, { maxSpeedKmh: 60 }, 'the vehicle snapshot is copied');

    const decoded = decodeSharedRoute(data);
    ok(decoded.ok, `the encoded payload must validate, got ${JSON.stringify(decoded)}`);
    deepEqual(decoded.data, data, 'decode restores the encoded payload');

    // 8. Simplification.
    const zig = [0, 0, 10, 5, 20, 0, 30, 5, 40, 0];
    const simplified = simplifyFlat(zig, 1);
    deepEqual(simplified.slice(0, 2), [0, 0], 'simplification keeps the first point');
    deepEqual(simplified.slice(-2), [40, 0], 'simplification keeps the last point');
    ok(
        polylineLength(simplified) <= polylineLength(zig) + RELATIVE_TOLERANCE,
        'simplification never increases the length',
    );
    deepEqual(simplifyFlat(zig, 0), zig, 'tolerance 0 returns the input unchanged');

    const tooLarge = encodeSharedRoute(route, {
        origin: [100, 200],
        author: 'Tester',
        createdAt: 1,
        budget: 100,
    });
    equal(tooLarge.ok, false, 'an impossible budget must fail');
    equal(tooLarge.reason, 'too-large', 'an impossible budget reports too-large');

    const emptyRoute = encodeSharedRoute({ ...route, legs: [] }, {
        origin: [100, 200],
        author: 'Tester',
        createdAt: 1,
    });
    equal(emptyRoute.ok, false, 'a route without legs cannot be shared');
    equal(emptyRoute.reason, 'empty', 'a route without legs reports empty');

    // 9. Validation rejects.
    const valid = {
        v: 1,
        origin: [100, 200],
        waypoints: [0, 0, 60, 5],
        legs: [{ mode: 'foot', kind: 'walk', points: [0, 0, 60, 5], eta: 36 }],
        distance: 61,
        eta: 36,
        author: 'A',
        createdAt: 1,
    };

    const reject = (mutate, reason, bounds, message) => {
        const copy = structuredClone(valid);
        mutate(copy);
        const result = decodeSharedRoute(copy, bounds);
        equal(result.ok, false, message ?? `expected a ${reason} rejection`);
        equal(result.reason, reason, message ?? `expected reason ${reason}`);
    };

    reject((copy) => { copy.v = 2; }, 'unsupported-version', undefined, 'version 2 is rejected');
    reject((copy) => { copy.origin = [Number.NaN, 0]; }, 'bad-origin', undefined, 'a NaN origin is rejected');
    reject((copy) => { copy.waypoints = [0, 0, 1]; }, 'bad-waypoints', undefined, 'an odd waypoint array is rejected');
    reject((copy) => { copy.legs = []; }, 'bad-legs', undefined, 'a payload without legs is rejected');
    reject((copy) => { copy.legs[0].points = [0, 0]; }, 'bad-leg-points', undefined, 'a one-point leg is rejected');
    reject((copy) => { copy.legs[0].points = [0, 0, Number.NaN, 5]; }, 'bad-leg-points', undefined, 'a NaN point is rejected');
    reject((copy) => { copy.legs[0].eta = -1; }, 'bad-leg-eta', undefined, 'a negative leg eta is rejected');
    reject((copy) => { copy.eta = -5; }, 'bad-eta', undefined, 'a negative total eta is rejected');
    reject((copy) => { copy.author = 7; }, 'bad-author', undefined, 'a non-string author is rejected');
    reject((copy) => { copy.createdAt = Number.NaN; }, 'bad-created-at', undefined, 'a NaN createdAt is rejected');

    const farAway = structuredClone(valid);
    farAway.origin = [5000, 5000];
    const outside = decodeSharedRoute(farAway, { width: 1000, height: 1000 });
    equal(outside.ok, false, 'a payload outside the terrain is rejected');
    equal(outside.reason, 'outside-terrain', 'an origin outside the terrain margin is rejected');

    const tooManyPoints = structuredClone(valid);
    const bigPoints = [];
    for (let index = 0; index <= SHARED_ROUTE_MAX_POINTS; index += 1) {
        bigPoints.push(index, 0);
    }
    tooManyPoints.legs = [{ mode: 'foot', kind: 'walk', points: bigPoints, eta: 1 }];
    const tooMany = decodeSharedRoute(tooManyPoints);
    equal(tooMany.ok, false, 'a payload above the point cap is rejected');
    equal(tooMany.reason, 'too-many-points', 'the point cap is enforced');

    // 10. Derived helpers.
    const derived = {
        v: 1,
        origin: [0, 0],
        waypoints: [0, 0, 100, 0, 100, 100],
        legs: [
            { mode: 'ground', kind: 'road', points: [0, 0, 100, 0], eta: 10 },
            { mode: 'foot', kind: 'walk', points: [100, 0, 110, 0], eta: 7 },
            { mode: 'boat', kind: 'water', points: [110, 0, 110, 100], eta: 12 },
        ],
        distance: 210,
        eta: 29,
        author: 'A',
        createdAt: 1,
    };

    approx(sharedRouteWalkDistance(derived), 10, 'only walk legs count as walking');
    equal(sharedRoutePrimaryMode(derived), 'ground', 'the first non-walk leg decides the primary mode');
    equal(sharedRouteUsesMode(derived, 'boat'), true, 'the boat leg is detected');
    equal(sharedRouteUsesMode(derived, 'ground'), true, 'the road leg is detected');
    equal(sharedRouteUsesMode(derived, 'foot'), false, 'walk legs do not count as a mode use');
    equal(sharedRoutePointCount(derived), 9, 'waypoint and leg points are counted');
}
