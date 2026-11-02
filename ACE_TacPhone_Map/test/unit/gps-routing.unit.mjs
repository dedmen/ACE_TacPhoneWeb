/**
 * Unit tests for the routing split: route progress, turn instructions,
 * deviation/auto-repath decisions, vehicle-change parsing and the road graph's
 * 0.5 m node merge.
 *
 * All modules here are browser-free and timer-free. The road graph is fed
 * pre-built polylines so no SVG/DOMParser is involved.
 */

import { equal, ok, fail } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { buildRouteGeometry } from '../../src/MapGps/RouteSplice.ts';
import { computeRouteMetrics, remainingEta, arrivalRadius } from '../../src/routing/RouteMetrics.ts';
import {
    isRoadLeg,
    legStartDistances,
    nextManeuver,
    nextSurfaceTransition,
    nextWaypointAhead,
    pointAtDistance,
    spokenDistance,
    guidanceCue,
} from '../../src/routing/TurnInstructions.ts';
import { DeviationTracker, OFF_ROUTE_THRESHOLD_M } from '../../src/routing/DeviationTracker.ts';
import { followRadius, followResolution } from '../../src/routing/FollowZoom.ts';
import { parseVehicleChange, readPerformance } from '../../src/routing/VehicleChange.ts';
import { TerrainHeights, heightAt, slopeAt } from '../../src/routing/TerrainHeights.ts';
import { formatDistance, formatSharedSummary } from '../../src/MapGps/GpsFormat.ts';
import { RoadNetwork } from '../../src/roads/RoadNetwork.ts';
import { TerrainMasks } from '../../src/terrain/TerrainMasks.ts';

export const name = 'gps-routing';
export const description = 'route metrics, turns, deviation, vehicle parsing, road graph';

function approx(actual, expected, message) {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-6) {
        fail(`${message}: expected ≈ ${expected}, got ${actual}`);
    }
}

function metric(overrides = {}) {
    return {
        remaining: 1000,
        along: 0,
        distance: 0,
        segment: 0,
        legIndex: 0,
        bearing: 0,
        ...overrides,
    };
}

export async function run() {
    // ---- RouteMetrics -----------------------------------------------------
    const geometry = buildRouteGeometry([
        { mode: 'ground', kind: 'road', points: [0, 0, 100, 0], distance: 100, eta: 10 },
        { mode: 'ground', kind: 'offroad', points: [100, 0, 200, 0], distance: 100, eta: 20 },
    ]);

    const first = computeRouteMetrics([50, 10], geometry);
    ok(first !== null, 'a position near the route projects onto it');
    approx(first.along, 50, 'along is the projected distance');
    approx(first.remaining, 150, 'remaining is total minus along');
    approx(first.distance, 10, 'distance is the perpendicular offset');
    equal(first.segment, 0, 'the first segment owns x=50');
    equal(first.legIndex, 0, 'the first leg owns x=50');
    ok(Number.isFinite(first.bearing), 'the bearing is finite');
    const onRoute = computeRouteMetrics([50, 0], geometry);
    approx(onRoute.bearing, 90, 'the bearing points at the next route point (east)');

    const second = computeRouteMetrics([150, 0], geometry);
    ok(second !== null, 'a position on the second leg projects');
    equal(second.segment, 1, 'x=150 is on segment 1');
    equal(second.legIndex, 1, 'x=150 belongs to the second leg');
    approx(second.remaining, 50, 'remaining on the second leg');

    approx(remainingEta(30, 200, 150), 22.5, 'remaining ETA scales with distance');
    equal(remainingEta(null, 200, 150), null, 'a null ETA stays null');
    equal(remainingEta(30, 0, 0), null, 'a zero-length route has no ETA');
    equal(arrivalRadius('foot'), 35, 'foot arrives within 35 m');
    equal(arrivalRadius('ground'), 80, 'vehicles arrive within 80 m');

    // ---- TurnInstructions -------------------------------------------------
    // East then south: a right turn.
    const turnPoints = [0, 0, 100, 0, 100, -100];
    const right = nextManeuver(turnPoints, 0);
    equal(right.turn, 'right', 'east -> south is a right turn');
    ok(right.distance !== null && right.distance > 90, 'the turn distance is the junction');

    // East then north: a left turn.
    const left = nextManeuver([0, 0, 100, 0, 100, 100], 0);
    equal(left.turn, 'left', 'east -> north is a left turn');

    const straight = nextManeuver([0, 0, 100, 0, 200, 0], 0);
    equal(straight.turn, 'straight', 'a straight line has no turn');
    equal(straight.distance, null, 'straight has no turn distance');

    const at = pointAtDistance([0, 0, 100, 0], 25);
    ok(at !== null, 'pointAtDistance returns a point');
    approx(at[0], 25, 'pointAtDistance interpolates x');
    approx(at[1], 0, 'pointAtDistance interpolates y');

    const waypoints = [[0, 0], [100, 0], [200, 0]];
    const next = nextWaypointAhead(waypoints, [50, 150], 60);
    equal(next?.[0], 100, 'the next waypoint after 60 m is the 150 m one');
    equal(nextWaypointAhead([], [], 0), null, 'no waypoints returns null');

    // Spoken cues use the real distance, not a fixed threshold bucket.
    equal(spokenDistance(203), 200, 'a nearby turn is spoken as its real distance');
    equal(spokenDistance(497), 500, 'the distance is rounded to 10 m');
    equal(spokenDistance(24), 20, 'short distances round to 10 m');
    equal(spokenDistance(4), 10, 'a spoken distance never goes below 10 m');
    equal(spokenDistance(Number.NaN), 10, 'a missing distance falls back to 10 m');

    // A junction gets one advance cue and one final cue.
    equal(guidanceCue(600), null, 'no cue beyond the advance range');
    equal(guidanceCue(500), 'far', 'the advance cue starts at 500 m');
    equal(guidanceCue(300), 'far', 'the advance cue covers the approach');
    equal(guidanceCue(100), 'near', 'the final cue starts at 100 m');
    equal(guidanceCue(50), 'near', 'the final cue covers the last stretch');
    equal(guidanceCue(Number.NaN), null, 'a missing distance has no cue');

    // ---- road/off-road surface transitions -------------------------------
    const transitionLegs = [
        { mode: 'ground', kind: 'offroad', points: [0, 0, 100, 0], distance: 100, eta: 10 },
        { mode: 'ground', kind: 'road', roadKind: 'road', points: [100, 0, 100, 100], distance: 100, eta: 5 },
    ];
    const transitionGeometry = buildRouteGeometry(transitionLegs);
    const starts = legStartDistances(transitionGeometry);
    approx(starts[0], 0, 'first leg starts at 0');
    approx(starts[1], 100, 'second leg starts after the first');
    equal(isRoadLeg(transitionLegs[0]), false, 'grid offroad is not a road leg');
    equal(isRoadLeg(transitionLegs[1]), true, 'a road-graph leg is a road leg');
    const enter = nextSurfaceTransition(transitionLegs, transitionGeometry, 50, 0, 100);
    ok(enter, 'entering the road is detected');
    approx(enter.distance, 50, 'transition distance is measured along the route');
    equal(enter.enteringRoad, true, 'offroad -> road is entering');
    equal(enter.direction, 'left', 'the turn onto the road is left');

    const leaving = nextSurfaceTransition(
        [transitionLegs[1], transitionLegs[0]],
        buildRouteGeometry([transitionLegs[1], transitionLegs[0]]),
        0,
        0,
        100,
    );
    ok(leaving, 'leaving the road is detected');
    equal(leaving.enteringRoad, false, 'road -> offroad is leaving');

    // ---- follow zoom: one minute ahead, 200 m while stationary -----------
    approx(followRadius(0), 200, 'a stationary player keeps a 200 m radius');
    approx(followRadius(10), 600, 'ten metres per second shows one minute of travel');
    approx(followRadius(-5), 200, 'a negative speed uses the stationary radius');
    approx(followRadius(Number.NaN), 200, 'an unknown speed uses the stationary radius');
    approx(followResolution(0, 400, 0.1, 100), 1, '200 m each way fills a 400 px side');
    approx(followResolution(20, 600, 0.1, 100), 4, '1200 m each way fills a 600 px side');
    approx(followResolution(0, 4000, 1, 100), 1, 'the view minimum resolution wins');
    approx(followResolution(60, 100, 0.1, 10), 10, 'the view maximum resolution wins');
    equal(followResolution(0, 0, 0.1, 100), null, 'no viewport means no target');
    equal(followResolution(0, 400, 0, 100), null, 'an invalid minimum means no target');
    approx(
        followResolution(0, 400, 0.1, 100, 300),
        1.5,
        'an explicit radius overrides the speed rule',
    );

    // ---- DeviationTracker ------------------------------------------------
    const tracker = new DeviationTracker();
    const offRoute = tracker.update({
        now: 1000,
        metrics: metric({ distance: OFF_ROUTE_THRESHOLD_M + 1 }),
        mode: 'ground',
        navigating: true,
        autoRepath: true,
        waypointAlong: [100, 500],
    });
    equal(offRoute.offRoute, true, 'beyond the threshold is off-route');
    equal(offRoute.repath, false, 'no repath before the delay');

    ok(
        !tracker.update({
            now: 4500,
            metrics: metric({ distance: OFF_ROUTE_THRESHOLD_M + 1 }),
            mode: 'ground',
            navigating: true,
            autoRepath: true,
            waypointAlong: [100, 500],
        }).repath,
        'the 4 s off-route delay is respected',
    );

    const repath = tracker.update({
        now: 5001,
        metrics: metric({ distance: OFF_ROUTE_THRESHOLD_M + 1 }),
        mode: 'ground',
        navigating: true,
        autoRepath: true,
        waypointAlong: [100, 500],
    });
    equal(repath.repath, true, 'after the delay the tracker asks for a repath');
    equal(
        tracker.update({
            now: 6000,
            metrics: metric({ distance: OFF_ROUTE_THRESHOLD_M + 1 }),
            mode: 'ground',
            navigating: true,
            autoRepath: true,
            waypointAlong: [100, 500],
        }).repath,
        false,
        'the repath cooldown suppresses a second request',
    );

    const reached = tracker.update({
        now: 7000,
        metrics: metric({ distance: 0, along: 100 }),
        mode: 'ground',
        navigating: true,
        autoRepath: false,
        waypointAlong: [100, 500],
    });
    equal(reached.reachedWaypoint, true, 'crossing a waypoint raises the event');
    equal(tracker.reachedCount, 1, 'the reached counter advances');

    const arrived = tracker.update({
        now: 9000,
        metrics: metric({ distance: 0, remaining: 70 }),
        mode: 'ground',
        navigating: true,
        autoRepath: false,
        waypointAlong: [100, 500],
    });
    equal(arrived.arrived, true, 'a vehicle within 80 m has arrived');

    tracker.reset();
    equal(tracker.isOffRoute, false, 'reset clears the off-route state');

    // ---- VehicleChange ----------------------------------------------------
    const parsed = parseVehicleChange({
        mode: 'ground',
        waterCapable: true,
        performance: {
            maxSpeedKmh: 100,
            enginePowerKw: 50,
            massKg: 2000,
            canFloat: true,
            simulation: 'carx',
            cost: 999,
        },
    }, 'foot');
    ok(parsed !== null, 'a valid vehicle payload parses');
    equal(parsed.detectedMode, 'ground', 'the reported mode is used');
    equal(parsed.waterCapable, true, 'water capability is preserved');
    approx(parsed.performance.maxSpeedKmh, 100, 'numeric performance fields survive');
    equal(parsed.performance.canFloat, true, 'canFloat is a boolean');
    equal(parsed.performance.simulation, 'carx', 'simulation is a string');
    equal(parsed.performance.cost, undefined, 'the opaque cost value is never read');

    const fallback = parseVehicleChange({ performance: {} }, 'boat');
    ok(fallback !== null, 'a payload without a mode still parses');
    equal(fallback.detectedMode, 'boat', 'the previous mode is the fallback');
    equal(parseVehicleChange(null, 'foot'), null, 'null payloads are ignored');
    equal(readPerformance({ massKg: 'heavy' }).massKg, undefined, 'non-numeric fields are dropped');

    // ---- RoadNetwork node merge ------------------------------------------
    const merge = new RoadNetwork([{
        points: [[0, 0], [0.2, 0]],
        strokeWidth: 8,
        width: 6,
        kind: 'road',
        paint: 'road',
    }]);
    equal(merge.nodeCount, 1, 'vertices within 0.5 m collapse to one node');
    equal(merge.segmentCount, 0, 'a collapsed zero-length segment is dropped');

    const split = new RoadNetwork([{
        points: [[0, 0], [0.8, 0]],
        strokeWidth: 8,
        width: 6,
        kind: 'road',
        paint: 'road',
    }]);
    equal(split.nodeCount, 2, 'vertices farther than 0.5 m stay separate');

    const network = new RoadNetwork([
        { points: [[0, 0], [100, 0]], strokeWidth: 12, width: 10, kind: 'main', paint: 'main' },
        { points: [[100, 5], [200, 5]], strokeWidth: 8, width: 6, kind: 'road', paint: 'road' },
    ]);
    const path = network.findPath([0, 0], [200, 5], () => 10);
    ok(path !== null, 'width-aware snapping connects two roads 5 m apart');
    ok(path.length > 200, 'the connected path is longer than the direct gap');
    ok(path.kinds.length > 0, 'the path carries its road classes');

    // ---- junctions: bends and head-to-head ends are not crossings ---------
    const polyline = (points, kind = 'road') => ({
        points,
        strokeWidth: 8,
        width: 6,
        kind,
        paint: kind,
    });
    const bend = new RoadNetwork([
        polyline([[0, 0], [100, 0]]),
        polyline([[100, 0], [100, 100]]),
    ]);
    equal(bend.isJunction([100, 0], 20), false, 'a road bend is not a junction');
    equal(bend.isJunction([50, 0], 20), false, 'a straight road point is not a junction');

    const tee = new RoadNetwork([
        polyline([[0, 0], [100, 0]]),
        polyline([[50, 0], [50, 50]]),
    ]);
    equal(tee.isJunction([50, 0], 20), true, 'a side road joining a road is a junction');
    equal(tee.isJunction([50, 40], 20), false, 'a point along the side road is not a junction');

    const cross = new RoadNetwork([
        polyline([[0, 0], [100, 0]]),
        polyline([[50, -50], [50, 50]]),
    ]);
    equal(cross.isJunction([50, 0], 20), true, 'a road crossing is a junction');

    // An extra polyline that ends on the same road and points along it only
    // adds a collinear branch; it must not look like a T junction.
    const overlap = new RoadNetwork([
        polyline([[0, 0], [100, 0]]),
        polyline([[0, 0], [50, 0]]),
    ]);
    equal(
        overlap.isJunction([50, 0], 20),
        false,
        'a collinear split of the same road is not a junction',
    );

    // ---- TerrainHeights cache and peak ring ------------------------------
    const heights = new TerrainHeights({ lruMax: 2, peakMax: 8, peakProminenceM: 2 });
    heights.set(0, 0, 10);
    heights.set(10, 0, 20);
    heights.set(20, 0, 30);
    equal(heights.stats.lru, 2, 'the ordinary cache is bounded');
    equal(heights.get(0, 0), undefined, 'the oldest ordinary sample is evicted');
    equal(heights.get(20, 0), 30, 'the newest sample survives');

    // 5x5 grid with one clear peak in the middle.
    const values = new Float32Array(25);
    for (let index = 0; index < values.length; index += 1) {
        values[index] = 10;
    }
    values[12] = 40;
    const grid = {
        bbox: [0, 0, 50, 50],
        cell: 10,
        width: 5,
        height: 5,
        values,
        min: 10,
        max: 40,
    };
    heights.recordPeaks(grid);
    ok(heights.stats.peaks > 0, 'a local maximum becomes a long-lived peak');
    ok(heights.stats.ring > 0, 'the peak stores a ring of neighbours');

    const peak = heights.get(25, 25);
    equal(peak, 40, 'the peak height is available without a game request');
    approx(heightAt(grid, 25, 25), 40, 'bilinear height at the peak');
    ok((slopeAt(grid, 15, 25) ?? 0) > 0, 'slope is derived from neighbouring heights');

    // ---- GPS formatting: units and separators are not translated ----------
    equal(formatDistance(850), '850 m', 'metres use the raw m unit');
    equal(formatDistance(12_400), '12.4 km', 'kilometres use the raw km unit');
    equal(formatDistance(0), '0 m', 'a zero distance keeps a unit');
    equal(
        formatSharedSummary('Ground vehicle', 12_400, '3 waypoints'),
        'Ground vehicle · 12.4 km · 3 waypoints',
        'the shared summary is only mode · distance · waypoints',
    );

    // ---- boat start may be inland: nearestPassable searches the bbox --------
    const width = 100;
    const height = 100;
    const cell = 10;
    const data = new Uint8Array(width * height).fill(1); // all land
    data[50] = 0; // one water cell at column 50, row 0
    const rasters = {
        terrain: { bbox: [0, 0, 1000, 1000], cell, width, height, data },
        roads: null,
        forests: null,
        objects: null,
        fences: null,
    };
    const masks = new TerrainMasks(null);
    const boatStart = masks.nearestPassable(
        'boat',
        [5, 5],
        rasters,
        [0, 0, 1000, 1000],
        cell,
        false,
    );
    ok(boatStart !== null, 'nearestPassable finds water more than 60 cells from an inland start');
    approx(boatStart[0], 505, 'the nearest water cell is returned');

    // ---- terrain raster rows are top-down, map Y is bottom-up ------------
    const rowData = new Uint8Array(100);
    rowData[0] = 1; // row 0, column 0 => world y near maxY
    rowData[99] = 1; // row 9, column 9 => world y near minY
    const rowRaster = {
        bbox: [0, 0, 100, 100],
        cell: 10,
        width: 10,
        height: 10,
        data: rowData,
    };
    equal(masks.sample(rowRaster, 5, 95), true, 'row 0 is the top (maxY) of the raster');
    equal(masks.sample(rowRaster, 95, 5), true, 'the last row is the bottom (minY)');
    equal(masks.sample(rowRaster, 5, 5), false, 'the top-left cell does not bleed to the bottom');
}
