/**
 * Route geometry and route-splicing helpers.
 *
 * A route is an ordered list of legs; the GPS module needs one flattened
 * polyline for projection (distance remaining, off-route check, next leg) and
 * needs to cut that polyline at an arbitrary segment when it splices a new
 * head (a connector after a repath, an advisor alternative) onto the rest.
 *
 * These functions are pure and only depend on `./SharedRoute`, so they can be
 * unit tested without OpenLayers or the DOM.
 */

import type { RouteLeg } from './GpsTypes';
import { flatPointCount, polylineLength, projectPointToPolyline } from './SharedRoute';

/** Flattened route: one polyline plus where each leg starts in it. */
export interface RouteGeometry {
    points: number[];
    /** Point index in `points` where each leg starts. */
    legStarts: number[];
    total: number;
}

/**
 * Flattens the legs into one polyline.
 *
 * Shared vertices between consecutive legs are de-duplicated, so the polyline
 * is contiguous. `total` is the sum of the leg distances, but never less than
 * the polyline length (leg distances come from the planner's edge costs).
 */
export function buildRouteGeometry(legs: RouteLeg[]): RouteGeometry {
    const points: number[] = [];
    const legStarts: number[] = [];
    let total = 0;

    for (const leg of legs) {
        legStarts.push(flatPointCount(points));

        for (let index = 0; index + 1 < leg.points.length; index += 2) {
            const x = leg.points[index];
            const y = leg.points[index + 1];
            const count = flatPointCount(points);
            if (count > 0 && points[(count - 1) * 2] === x && points[(count - 1) * 2 + 1] === y) {
                continue;
            }
            points.push(x, y);
        }

        total += leg.distance;
    }

    return { points, legStarts, total: Math.max(total, polylineLength(points)) };
}

/** Index of the leg that owns a flattened segment (clamped to the first leg). */
export function findLegIndex(legStarts: number[], segment: number): number {
    let result = 0;
    for (let index = 0; index < legStarts.length; index += 1) {
        if (legStarts[index] <= segment) {
            result = index;
        } else {
            break;
        }
    }
    return result;
}

/**
 * Returns the legs from a flattened segment onward, preserving surface kinds.
 *
 * Vertices up to and including `segment` are dropped; when `prepend` is set its
 * point replaces them as the new start of the first kept leg. Legs that lose
 * all geometry (fewer than two points) are dropped. `eta` is scaled with the
 * remaining distance of each leg.
 */
export function sliceLegsFrom(
    legs: RouteLeg[],
    geometry: RouteGeometry,
    segment: number,
    prepend: [number, number] | null,
): RouteLeg[] {
    const legIndex = findLegIndex(geometry.legStarts, segment);
    const legStart = geometry.legStarts[legIndex] ?? 0;
    const localSegment = Math.max(0, segment - legStart);
    const result: RouteLeg[] = [];

    for (let index = legIndex; index < legs.length; index += 1) {
        const leg = legs[index];
        let points: number[];

        if (index === legIndex) {
            const tail = leg.points.slice((localSegment + 1) * 2);
            points = prepend ? [prepend[0], prepend[1], ...tail] : tail;
        } else {
            points = leg.points.slice();
        }

        if (points.length < 4) {
            continue;
        }

        const distance = polylineLength(points);
        result.push({
            ...leg,
            points,
            distance,
            eta: leg.distance > 0 ? leg.eta * (distance / leg.distance) : leg.eta,
        });
    }

    return result;
}

/** Distance along a flat polyline to the projection of `point`, or null. */
export function projectionAlong(point: [number, number], points: number[]): number | null {
    const projection = projectPointToPolyline(point[0], point[1], points);
    return projection ? projection.along : null;
}

/** Converts a flat `[x, y, ...]` array to coordinates for an OpenLayers geometry. */
export function flattenToCoordinates(flat: number[]): Array<[number, number]> {
    const coordinates: Array<[number, number]> = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
        coordinates.push([flat[index], flat[index + 1]]);
    }
    return coordinates;
}
