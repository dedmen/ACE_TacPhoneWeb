/**
 * Turn classification for road routes.
 *
 * The route is flattened to one polyline; a maneuver is the first bearing
 * change greater than 30 degrees within the next 250 m. No road names are
 * available, so the HUD only says left/right/straight.
 */

import { bearingBetween, distanceBetween, polylineLength } from '../MapGps/SharedRoute';
import type { RouteGeometry } from '../MapGps/RouteSplice';
import type { RouteLeg } from './RouteTypes';

export type TurnDirection = 'left' | 'right' | 'straight';

export interface Maneuver {
    turn: TurnDirection | null;
    /** Distance to the turn in metres, or null for "straight". */
    distance: number | null;
}

/** Signed shortest difference between two bearings, in degrees. */
export function normalizeSigned(value: number): number {
    const wrapped = ((value % 360) + 360) % 360;
    return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * Rounds a distance to the value a voice cue should say: the real distance in
 * 10 m steps, never below 10 m. Cues must not announce a fixed bucket distance
 * when the turn is actually closer.
 */
export function spokenDistance(meters: number): number {
    if (!Number.isFinite(meters)) {
        return 10;
    }
    return Math.max(10, Math.round(meters / 10) * 10);
}

/** Furthest distance for the advance ("turn left in 500 meters") cue. */
export const GUIDANCE_FAR_CUE_M = 500;
/** Distance for the final ("turn left in 100 meters") cue. */
export const GUIDANCE_NEAR_CUE_M = 100;

export type GuidanceCue = 'far' | 'near';

/**
 * Which voice cue applies at this distance: `near` just before the maneuver,
 * `far` earlier, or null when it is still too far away. Each cue is spoken at
 * most once per junction.
 */
export function guidanceCue(distance: number): GuidanceCue | null {
    if (!Number.isFinite(distance) || distance < 0) {
        return null;
    }
    if (distance <= GUIDANCE_NEAR_CUE_M) {
        return 'near';
    }
    if (distance <= GUIDANCE_FAR_CUE_M) {
        return 'far';
    }
    return null;
}

/** World point at a distance along a flat polyline. */
export function pointAtDistance(points: number[], distance: number): [number, number] | null {
    if (points.length < 2) {
        return null;
    }

    const total = polylineLength(points);
    const target = Math.max(0, Math.min(total, distance));
    let travelled = 0;

    for (let index = 0; index + 3 < points.length; index += 2) {
        const ax = points[index];
        const ay = points[index + 1];
        const bx = points[index + 2];
        const by = points[index + 3];
        const length = distanceBetween(ax, ay, bx, by);

        if (travelled + length >= target && length > 0) {
            const t = (target - travelled) / length;
            return [ax + (bx - ax) * t, ay + (by - ay) * t];
        }
        travelled += length;
    }

    const last = points.length - 2;
    return [points[last], points[last + 1]];
}

/** First turn in the next `maxDistance` metres, or null/straight when there is none. */
export function nextManeuver(points: number[], along: number, maxDistance = 250): Maneuver {
    if (points.length < 6) {
        return { turn: null, distance: null };
    }

    const total = polylineLength(points);
    if (along >= total - 10) {
        return { turn: null, distance: null };
    }

    const here = pointAtDistance(points, along);
    const ahead = pointAtDistance(points, along + 10);
    if (!here || !ahead) {
        return { turn: null, distance: null };
    }

    const previous = bearingBetween(here[0], here[1], ahead[0], ahead[1]);

    for (let distance = 15; distance <= maxDistance; distance += 10) {
        const from = along + distance - 10;
        const to = along + distance;
        if (to >= total) {
            break;
        }

        const a = pointAtDistance(points, from);
        const b = pointAtDistance(points, to);
        if (!a || !b) {
            break;
        }

        const delta = normalizeSigned(bearingBetween(a[0], a[1], b[0], b[1]) - previous);
        if (Math.abs(delta) > 30) {
            return { turn: delta > 0 ? 'right' : 'left', distance: to - along };
        }
    }

    return { turn: 'straight', distance: null };
}

/** True for road-graph legs (including tracks/trails); false for grid offroad. */
export function isRoadLeg(leg: RouteLeg | undefined): boolean {
    return leg !== undefined && (leg.kind === 'road' || leg.roadKind !== undefined);
}

/** Distance along the route at the start of each leg, metres. */
export function legStartDistances(geometry: RouteGeometry): number[] {
    const count = Math.floor(geometry.points.length / 2);
    const prefix = new Array<number>(count);
    prefix[0] = 0;
    for (let index = 1; index < count; index += 1) {
        prefix[index] = prefix[index - 1] + distanceBetween(
            geometry.points[(index - 1) * 2],
            geometry.points[(index - 1) * 2 + 1],
            geometry.points[index * 2],
            geometry.points[index * 2 + 1],
        );
    }

    return geometry.legStarts.map((start, index) => {
        const point = index === 0 ? 0 : Math.max(0, start - 1);
        return prefix[Math.min(point, count - 1)] ?? 0;
    });
}

export interface SurfaceTransition {
    /** Distance from the current position to the transition, metres. */
    distance: number;
    /** Along-route distance of the leg boundary. */
    boundaryAlong: number;
    /** True when moving from offroad onto a road. */
    enteringRoad: boolean;
    direction: TurnDirection;
}

/**
 * Next road/off-road transition ahead. Only the immediate leg boundary is
 * reported; road-to-road turns are handled by {@link nextManeuver}.
 */
export function nextSurfaceTransition(
    legs: RouteLeg[],
    geometry: RouteGeometry,
    along: number,
    legIndex: number,
    maxDistance = 550,
): SurfaceTransition | null {
    const current = legs[legIndex];
    const next = legs[legIndex + 1];
    if (!current || !next || isRoadLeg(current) === isRoadLeg(next)) {
        return null;
    }

    const starts = legStartDistances(geometry);
    const boundaryAlong = starts[legIndex + 1] ?? geometry.total;
    const distance = boundaryAlong - along;
    if (!(distance > 0) || distance > maxDistance) {
        return null;
    }

    const prior = pointAtDistance(geometry.points, Math.max(0, boundaryAlong - 20));
    const before = pointAtDistance(geometry.points, Math.max(0, boundaryAlong - 10));
    const after = pointAtDistance(geometry.points, Math.min(geometry.total, boundaryAlong + 10));
    if (!prior || !before || !after) {
        return null;
    }

    const delta = normalizeSigned(
        bearingBetween(before[0], before[1], after[0], after[1])
        - bearingBetween(prior[0], prior[1], before[0], before[1]),
    );

    return {
        distance,
        boundaryAlong,
        enteringRoad: isRoadLeg(next),
        direction: Math.abs(delta) > 30
            ? delta > 0 ? 'right' : 'left'
            : 'straight',
    };
}

/** Next waypoint after the player's current distance along the route. */
export function nextWaypointAhead(
    waypoints: Array<[number, number]>,
    waypointAlong: number[],
    along: number,
): [number, number] | null {
    for (let index = 0; index < waypoints.length; index += 1) {
        if ((waypointAlong[index] ?? 0) > along - 1) {
            return waypoints[index];
        }
    }

    return waypoints[waypoints.length - 1] ?? null;
}
