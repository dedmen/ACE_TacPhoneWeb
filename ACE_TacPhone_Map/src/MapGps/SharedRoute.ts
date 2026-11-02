/**
 * `map.gps_route` payload for sharing a planned route through Messenger.
 *
 * The payload stores geometry, not the sender's progress:
 * - one world-space `origin`;
 * - waypoints and leg points as flat integer metre offsets from that origin
 *   (keeps the JSON small);
 * - one ETA per leg from the speed model at share time.
 *
 * This module also owns the geometry helpers the GPS module and the planner
 * use: flat point conversion, Douglas-Peucker simplification, length, bbox and
 * projection onto a polyline.
 */

import type {
    ActiveRoute,
    RouteLeg,
    RouteLegKind,
    TravelMode,
    VehiclePerformance,
} from './GpsTypes';
import { isTravelMode } from './GpsTypes';

/** Chat object kind produced by the Map app and rendered by Messenger. */
export const SHARED_ROUTE_KIND = 'map.gps_route';

/** Version of the payload described here. */
export const SHARED_ROUTE_VERSION = 1;

/** Hard cap on the number of points in one payload, all legs included. */
export const SHARED_ROUTE_MAX_POINTS = 6000;

/** Maximum serialized size accepted by the share flow. */
export const SHARED_ROUTE_MAX_CHARS = 60000;

/** One route leg as stored in a shared payload. */
export interface SharedRouteLeg {
    mode: TravelMode;
    kind: RouteLegKind;
    /** Flat `[x, y, ...]` integer metre offsets from `origin`. */
    points: number[];
    /** Travel time in seconds at share time. */
    eta: number;
}

/** Route payload carried by a `map.gps_route` chat object. */
export interface SharedRouteData {
    v: typeof SHARED_ROUTE_VERSION;
    /** World-space origin the offsets are relative to. */
    origin: [number, number];
    /** Ordered waypoint offsets, flat `[x, y, ...]`, integer metres. */
    waypoints: number[];
    legs: SharedRouteLeg[];
    distance: number;
    eta: number | null;
    author: string;
    createdAt: number;
    label?: string;
    /** Author's vehicle snapshot; only used for ETA comparison. */
    vehicle?: VehiclePerformance;
}

/** Terrain bounds a received payload must fit into. */
export interface TerrainBounds {
    width: number;
    height: number;
}

/** Result of {@link encodeSharedRoute}. */
export type SharedRouteEncodeResult =
    | { ok: true; data: SharedRouteData }
    | { ok: false; reason: 'empty' | 'too-large' };

/** Result of {@link decodeSharedRoute}. */
export type SharedRouteDecodeResult =
    | { ok: true; data: SharedRouteData }
    | { ok: false; reason: string };

const LEG_KINDS: readonly RouteLegKind[] = ['road', 'offroad', 'water', 'walk', 'air'];

/** Runtime guard for a leg kind string. */
export function isRouteLegKind(value: unknown): value is RouteLegKind {
    return typeof value === 'string' && (LEG_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Flat point helpers
// ---------------------------------------------------------------------------

/** Converts `[[x, y], ...]` to a flat `[x, y, ...]` array. */
export function toFlatPoints(points: ReadonlyArray<readonly [number, number]>): number[] {
    const flat: number[] = [];
    for (const point of points) {
        flat.push(point[0], point[1]);
    }
    return flat;
}

/** Converts a flat `[x, y, ...]` array to point pairs, dropping a dangling value. */
export function fromFlatPoints(flat: readonly number[]): Array<[number, number]> {
    const points: Array<[number, number]> = [];
    const count = Math.floor(flat.length / 2);
    for (let index = 0; index < count; index += 1) {
        points.push([flat[index * 2], flat[index * 2 + 1]]);
    }
    return points;
}

/** Number of points in a flat array. */
export function flatPointCount(flat: readonly number[]): number {
    return Math.floor(flat.length / 2);
}

/** Offset a flat point array by a world-space origin. */
function offsetFlat(flat: readonly number[], origin: readonly [number, number], scale = 1): number[] {
    const result: number[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
        result.push(origin[0] + flat[index] * scale, origin[1] + flat[index + 1] * scale);
    }
    return result;
}

/** Copies global points into offsets, rounding to whole metres. */
function toOffsetFlat(points: readonly number[], origin: readonly [number, number]): number[] {
    const result: number[] = [];
    for (let index = 0; index + 1 < points.length; index += 2) {
        result.push(Math.round(points[index] - origin[0]), Math.round(points[index + 1] - origin[1]));
    }
    return result;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Euclidean distance between two world-space points. */
export function distanceBetween(ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
}

/** Total length of a flat polyline in metres. */
export function polylineLength(flat: readonly number[]): number {
    let total = 0;
    for (let index = 2; index + 1 < flat.length; index += 2) {
        total += distanceBetween(flat[index - 2], flat[index - 1], flat[index], flat[index + 1]);
    }
    return total;
}

/** Distance from a point to a segment. */
export function distanceToSegment(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared <= 0) {
        return distanceBetween(px, py, ax, ay);
    }

    let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));

    return distanceBetween(px, py, ax + dx * t, ay + dy * t);
}

/** Bearing in degrees clockwise from north. */
export function bearingBetween(ax: number, ay: number, bx: number, by: number): number {
    const degrees = (Math.atan2(bx - ax, by - ay) * 180) / Math.PI;
    return normalizeDegrees(degrees);
}

/** Wraps an angle in degrees into `[0, 360)`. */
export function normalizeDegrees(value: number): number {
    const wrapped = value % 360;
    return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Result of projecting a point onto a polyline. */
export interface PolylineProjection {
    /** Nearest point on the polyline. */
    point: [number, number];
    /** Distance from the input point to the polyline in metres. */
    distance: number;
    /** Distance along the polyline to the projected point. */
    along: number;
    /** Index of the segment start point. */
    segment: number;
}

/** Projects a world-space point onto a flat polyline. */
export function projectPointToPolyline(
    x: number,
    y: number,
    flat: readonly number[],
): PolylineProjection | null {
    const count = flatPointCount(flat);
    if (count === 0) {
        return null;
    }

    if (count === 1) {
        const point: [number, number] = [flat[0], flat[1]];
        return { point, distance: distanceBetween(x, y, point[0], point[1]), along: 0, segment: 0 };
    }

    let bestDistance = Number.POSITIVE_INFINITY;
    let bestPoint: [number, number] = [flat[0], flat[1]];
    let bestAlong = 0;
    let bestSegment = 0;
    let travelled = 0;

    for (let index = 0; index + 3 < flat.length; index += 2) {
        const ax = flat[index];
        const ay = flat[index + 1];
        const bx = flat[index + 2];
        const by = flat[index + 3];
        const dx = bx - ax;
        const dy = by - ay;
        const segmentLength = Math.sqrt(dx * dx + dy * dy);
        const lengthSquared = segmentLength * segmentLength;

        let t = 0;
        if (lengthSquared > 0) {
            t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
        }

        const px = ax + dx * t;
        const py = ay + dy * t;
        const distance = distanceBetween(x, y, px, py);

        if (distance < bestDistance) {
            bestDistance = distance;
            bestPoint = [px, py];
            bestAlong = travelled + segmentLength * t;
            bestSegment = index / 2;
        }

        travelled += segmentLength;
    }

    return { point: bestPoint, distance: bestDistance, along: bestAlong, segment: bestSegment };
}

/** World-space bounding box of a shared payload: `[minX, minY, maxX, maxY]`. */
export function sharedRouteBBox(data: SharedRouteData): [number, number, number, number] {
    const [originX, originY] = data.origin;
    let minX = originX;
    let minY = originY;
    let maxX = originX;
    let maxY = originY;

    const include = (x: number, y: number): void => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    };

    for (let index = 0; index + 1 < data.waypoints.length; index += 2) {
        include(originX + data.waypoints[index], originY + data.waypoints[index + 1]);
    }

    for (const leg of data.legs) {
        for (let index = 0; index + 1 < leg.points.length; index += 2) {
            include(originX + leg.points[index], originY + leg.points[index + 1]);
        }
    }

    return [minX, minY, maxX, maxY];
}

/** Point count of a shared payload, waypoints included. */
export function sharedRoutePointCount(data: SharedRouteData): number {
    let count = flatPointCount(data.waypoints);
    for (const leg of data.legs) {
        count += flatPointCount(leg.points);
    }
    return count;
}

/** Total walking distance in a shared payload. */
export function sharedRouteWalkDistance(data: SharedRouteData): number {
    let total = 0;
    for (const leg of data.legs) {
        if (leg.kind === 'walk') {
            total += polylineLength(offsetFlat(leg.points, data.origin));
        }
    }
    return total;
}

/** Shared waypoint offsets as world-space points. */
export function sharedRouteWaypoints(data: SharedRouteData): Array<[number, number]> {
    return fromFlatPoints(offsetFlat(data.waypoints, data.origin));
}

/** Shared legs as world-space route legs. */
export function sharedRouteLegs(data: SharedRouteData): RouteLeg[] {
    return data.legs.map((leg) => {
        const points = offsetFlat(leg.points, data.origin);
        return {
            mode: leg.mode,
            kind: leg.kind,
            points,
            distance: polylineLength(points),
            eta: leg.eta,
            source: 'shared',
        };
    });
}

// ---------------------------------------------------------------------------
// Douglas-Peucker
// ---------------------------------------------------------------------------

/** Simplifies a flat polyline, always keeping the first and last point. */
export function simplifyFlat(points: readonly number[], tolerance: number): number[] {
    const count = flatPointCount(points);
    if (count <= 2 || tolerance <= 0) {
        return points.slice(0, count * 2);
    }

    const keep = new Uint8Array(count);
    keep[0] = 1;
    keep[count - 1] = 1;

    const stack: Array<[number, number]> = [[0, count - 1]];

    while (stack.length > 0) {
        const entry = stack.pop();
        if (!entry) {
            break;
        }

        const [first, last] = entry;
        if (last <= first + 1) {
            continue;
        }

        const ax = points[first * 2];
        const ay = points[first * 2 + 1];
        const bx = points[last * 2];
        const by = points[last * 2 + 1];

        let maxDistance = -1;
        let maxIndex = -1;

        for (let index = first + 1; index < last; index += 1) {
            const distance = distanceToSegment(
                points[index * 2],
                points[index * 2 + 1],
                ax,
                ay,
                bx,
                by,
            );
            if (distance > maxDistance) {
                maxDistance = distance;
                maxIndex = index;
            }
        }

        if (maxIndex >= 0 && maxDistance > tolerance) {
            keep[maxIndex] = 1;
            stack.push([first, maxIndex], [maxIndex, last]);
        }
    }

    const result: number[] = [];
    for (let index = 0; index < count; index += 1) {
        if (keep[index] === 1) {
            result.push(points[index * 2], points[index * 2 + 1]);
        }
    }
    return result;
}

/** Share-time simplification tolerance for one leg kind. */
function baseTolerance(kind: RouteLegKind): number {
    if (kind === 'air') {
        return 0;
    }
    if (kind === 'walk' || kind === 'water') {
        // A geometric shortcut can leave a walk leg and cross water. The
        // planner already emitted a surface-safe path, so do not simplify it
        // again at share time.
        return 0;
    }
    return 8;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Options for {@link encodeSharedRoute}. */
export interface EncodeSharedRouteOptions {
    origin: [number, number];
    author: string;
    createdAt: number;
    label?: string;
    vehicle?: VehiclePerformance;
    /** Serialized-size budget; defaults to {@link SHARED_ROUTE_MAX_CHARS}. */
    budget?: number;
}

/** Builds a shared payload, increasing the tolerance until it fits the budget. */
export function encodeSharedRoute(
    route: ActiveRoute,
    options: EncodeSharedRouteOptions,
): SharedRouteEncodeResult {
    if (route.legs.length === 0) {
        return { ok: false, reason: 'empty' };
    }

    const origin: [number, number] = [options.origin[0], options.origin[1]];
    const budget = options.budget ?? SHARED_ROUTE_MAX_CHARS;
    const waypoints = toOffsetFlat(toFlatPoints(route.waypoints), origin);

    const passes = [1, 1.5, 2, 3, 4, 6, 8, 12];

    for (const pass of passes) {
        const legs: SharedRouteLeg[] = [];

        for (const leg of route.legs) {
            const tolerance = baseTolerance(leg.kind) * pass;
            const simplified = tolerance > 0 ? simplifyFlat(leg.points, tolerance) : leg.points.slice();
            legs.push({
                mode: leg.mode,
                kind: leg.kind,
                points: toOffsetFlat(simplified, origin),
                eta: Math.max(0, Math.round(leg.eta)),
            });
        }

        const data: SharedRouteData = {
            v: SHARED_ROUTE_VERSION,
            origin,
            waypoints,
            legs,
            distance: Math.max(0, route.distance),
            eta: route.eta === null ? null : Math.max(0, Math.round(route.eta)),
            author: options.author,
            createdAt: options.createdAt,
        };

        if (options.label) {
            data.label = options.label;
        }
        if (options.vehicle) {
            data.vehicle = options.vehicle;
        }

        if (sharedRoutePointCount(data) > SHARED_ROUTE_MAX_POINTS) {
            continue;
        }

        if (JSON.stringify(data).length <= budget) {
            return { ok: true, data };
        }
    }

    return { ok: false, reason: 'too-large' };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isEvenLengthArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.length >= 2 && value.length % 2 === 0
        && value.every(isFiniteNumber);
}

function insideBounds(x: number, y: number, bounds: TerrainBounds | undefined): boolean {
    if (!bounds) {
        return true;
    }
    const margin = 50;
    return x >= -margin && y >= -margin
        && x <= bounds.width + margin
        && y <= bounds.height + margin;
}

/**
 * Validates a received payload. Rejects wrong versions, non-finite numbers,
 * odd flat arrays, empty legs, out-of-terrain coordinates and oversized point
 * counts.
 */
export function decodeSharedRoute(
    value: unknown,
    bounds?: TerrainBounds,
): SharedRouteDecodeResult {
    if (!value || typeof value !== 'object') {
        return { ok: false, reason: 'not-an-object' };
    }

    const candidate = value as Partial<SharedRouteData>;

    if (candidate.v !== SHARED_ROUTE_VERSION) {
        return { ok: false, reason: 'unsupported-version' };
    }

    const origin = candidate.origin;
    if (
        !Array.isArray(origin)
        || origin.length !== 2
        || !isFiniteNumber(origin[0])
        || !isFiniteNumber(origin[1])
    ) {
        return { ok: false, reason: 'bad-origin' };
    }

    if (!isEvenLengthArray(candidate.waypoints)) {
        return { ok: false, reason: 'bad-waypoints' };
    }

    if (!Array.isArray(candidate.legs) || candidate.legs.length === 0) {
        return { ok: false, reason: 'bad-legs' };
    }

    const legs: SharedRouteLeg[] = [];

    for (const entry of candidate.legs) {
        if (!entry || typeof entry !== 'object') {
            return { ok: false, reason: 'bad-leg' };
        }

        const leg = entry as Partial<SharedRouteLeg>;
        if (!isTravelMode(leg.mode) || !isRouteLegKind(leg.kind)) {
            return { ok: false, reason: 'bad-leg' };
        }
        if (!isEvenLengthArray(leg.points) || leg.points.length < 4) {
            return { ok: false, reason: 'bad-leg-points' };
        }
        if (!isFiniteNumber(leg.eta) || leg.eta < 0) {
            return { ok: false, reason: 'bad-leg-eta' };
        }

        for (let index = 0; index + 1 < leg.points.length; index += 2) {
            if (!insideBounds(origin[0] + leg.points[index], origin[1] + leg.points[index + 1], bounds)) {
                return { ok: false, reason: 'outside-terrain' };
            }
        }

        legs.push({
            mode: leg.mode,
            kind: leg.kind,
            points: leg.points.map(Math.round),
            eta: leg.eta,
        });
    }

    for (let index = 0; index + 1 < candidate.waypoints.length; index += 2) {
        if (!insideBounds(origin[0] + candidate.waypoints[index], origin[1] + candidate.waypoints[index + 1], bounds)) {
            return { ok: false, reason: 'outside-terrain' };
        }
    }

    if (!isFiniteNumber(candidate.distance) || candidate.distance < 0) {
        return { ok: false, reason: 'bad-distance' };
    }

    const eta = candidate.eta;
    if (eta !== null && (!isFiniteNumber(eta) || eta < 0)) {
        return { ok: false, reason: 'bad-eta' };
    }

    if (typeof candidate.author !== 'string') {
        return { ok: false, reason: 'bad-author' };
    }

    if (!isFiniteNumber(candidate.createdAt)) {
        return { ok: false, reason: 'bad-created-at' };
    }

    if (candidate.label !== undefined && typeof candidate.label !== 'string') {
        return { ok: false, reason: 'bad-label' };
    }

    const data: SharedRouteData = {
        v: SHARED_ROUTE_VERSION,
        origin: [origin[0], origin[1]],
        waypoints: candidate.waypoints.map(Math.round),
        legs,
        distance: candidate.distance,
        eta,
        author: candidate.author,
        createdAt: candidate.createdAt,
    };

    if (candidate.label) {
        data.label = candidate.label;
    }
    if (candidate.vehicle && typeof candidate.vehicle === 'object') {
        data.vehicle = candidate.vehicle;
    }

    if (sharedRoutePointCount(data) > SHARED_ROUTE_MAX_POINTS) {
        return { ok: false, reason: 'too-many-points' };
    }

    return { ok: true, data };
}

/** True when the payload uses a supported mode anywhere (used by the advisor). */
export function sharedRouteUsesMode(data: SharedRouteData, mode: TravelMode): boolean {
    return data.legs.some((leg) => leg.mode === mode && leg.kind !== 'walk');
}

/** Mode of the first non-walk leg; convenient for the preview summary. */
export function sharedRoutePrimaryMode(data: SharedRouteData): TravelMode {
    const nonWalk = data.legs.find((leg) => leg.kind !== 'walk');
    return (nonWalk ?? data.legs[0]).mode;
}
