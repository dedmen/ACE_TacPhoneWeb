/**
 * Route progress: projection of the player onto the route, remaining
 * distance, current leg and the bearing to the next route point.
 *
 * Pure so the live GPS module and the unit tier share one implementation.
 */

import type { RouteGeometry } from '../MapGps/RouteSplice';
import { bearingBetween, flatPointCount, projectPointToPolyline } from '../MapGps/SharedRoute';
import type { TravelMode } from './RouteTypes';

export interface RouteMetrics {
    /** Metres left to the destination. */
    remaining: number;
    /** Metres travelled along the flattened route. */
    along: number;
    /** Perpendicular distance from the player to the route, metres. */
    distance: number;
    /** Segment index in the flattened polyline. */
    segment: number;
    /** Leg that owns `segment`. */
    legIndex: number;
    /** Bearing from the player to the next route point, degrees. */
    bearing: number | null;
}

/**
 * Leg that owns a flattened segment.
 *
 * `geometry.legStarts` stores point indices, while the projection reports a
 * segment index. A leg starting at point P owns the segment ending at P, so
 * the first leg starts at segment 0 and every later leg at `P - 1`.
 */
export function findLegIndexForSegment(legStarts: number[], segment: number): number {
    let result = 0;
    for (let index = 0; index < legStarts.length; index += 1) {
        const startSegment = index === 0 ? 0 : Math.max(0, legStarts[index] - 1);
        if (startSegment <= segment) {
            result = index;
        } else {
            break;
        }
    }
    return result;
}

/** Projects `position` onto the route, or null when there is no geometry. */
export function computeRouteMetrics(
    position: [number, number],
    geometry: RouteGeometry,
): RouteMetrics | null {
    const projection = projectPointToPolyline(position[0], position[1], geometry.points);
    if (!projection) {
        return null;
    }

    const count = flatPointCount(geometry.points);
    const nextIndex = Math.min(count - 1, projection.segment + 1);
    const bearing = count >= 2
        ? bearingBetween(
            position[0],
            position[1],
            geometry.points[nextIndex * 2],
            geometry.points[nextIndex * 2 + 1],
        )
        : null;

    return {
        remaining: Math.max(0, geometry.total - projection.along),
        along: projection.along,
        distance: projection.distance,
        segment: projection.segment,
        legIndex: findLegIndexForSegment(geometry.legStarts, projection.segment),
        bearing,
    };
}

/** Remaining ETA scaled by the remaining fraction of the route. */
export function remainingEta(
    totalEta: number | null,
    totalDistance: number,
    remaining: number,
): number | null {
    if (totalEta === null || !(totalDistance > 0)) {
        return null;
    }
    return totalEta * (remaining / totalDistance);
}

/** Arrival radius for a mode: vehicles stop farther from the point. */
export function arrivalRadius(mode: TravelMode): number {
    return mode === 'foot' ? 35 : 80;
}
