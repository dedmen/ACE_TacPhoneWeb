/**
 * Turn classification for road routes.
 *
 * The route is flattened to one polyline; a maneuver is the first bearing
 * change greater than 30 degrees within the next 250 m. No road names are
 * available, so the HUD only says left/right/straight.
 */

import { bearingBetween, distanceBetween, polylineLength } from '../MapGps/SharedRoute';

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

/** First turn in the next 250 m, or null/straight when there is none. */
export function nextManeuver(points: number[], along: number): Maneuver {
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

    for (let distance = 15; distance <= 250; distance += 10) {
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
