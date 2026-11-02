/**
 * Hover information for one route leg and the span to its next waypoint.
 *
 * Pure so the GPS module and the unit tier share the same calculation. The
 * average speed uses the leg's planned distance/ETA, so it already includes
 * slope, surface and forest effects from `SpeedModel`.
 */

import type { RouteGeometry } from '../MapGps/RouteSplice';
import { projectionAlong } from '../MapGps/RouteSplice';
import { flatPointCount } from '../MapGps/SharedRoute';
import type { RouteLeg, RouteLegKind, TravelMode } from './RouteTypes';

export interface RouteLegHoverInfo {
    legIndex: number;
    kind: RouteLegKind;
    /** Planned ground surface (`road`/`forest`/`offroad`); absent otherwise. */
    surface?: 'water' | 'road' | 'forest' | 'offroad';
    /** Road graph class for road-graph legs. */
    roadKind?: 'main' | 'road' | 'track' | 'rail' | 'trail';
    /** False when the current vehicle cannot traverse the leg. */
    passable?: boolean;
    mode: TravelMode;
    /** Planned length of the hovered leg, metres. */
    distance: number;
    /** Planned time for the hovered leg, seconds; null when unknown. */
    eta: number | null;
    /** Average speed for the hovered leg, metres per second. */
    speed: number | null;
    /** Zero-based index of the waypoint this leg is heading to. */
    nextWaypointIndex: number;
    /** True when the span starts at the player instead of the previous waypoint. */
    fromPlayer: boolean;
    /** Distance from the chosen start to the next waypoint, metres. */
    spanDistance: number;
    /** Time from the chosen start to the next waypoint, seconds. */
    spanEta: number | null;
    /** Average speed for the whole span, metres per second. */
    spanSpeed: number | null;
}

function legPointStart(geometry: RouteGeometry, legIndex: number): number {
    if (legIndex === 0) {
        return 0;
    }
    // `legStarts` counts the duplicated shared vertex; the real first point of
    // a later leg is the vertex before that count.
    return Math.max(0, (geometry.legStarts[legIndex] ?? 0) - 1);
}

function legEndAlong(
    geometry: RouteGeometry,
    legIndex: number,
    prefix: number[],
): number {
    const nextStart = geometry.legStarts[legIndex + 1];
    return nextStart === undefined
        ? prefix[prefix.length - 1]
        : prefix[Math.max(0, nextStart - 1)];
}

/** Distance from a point on the route to a [start, end] interval. */
function distanceToInterval(along: number, start: number, end: number): number {
    if (along < start) {
        return start - along;
    }
    if (along > end) {
        return along - end;
    }
    return 0;
}

function safeSpeed(distance: number, eta: number): number | null {
    return distance > 0 && eta > 0 && Number.isFinite(eta) ? distance / eta : null;
}

/**
 * Describes the hovered leg plus the legs from the previous waypoint or the
 * player (whichever is closer) to the next waypoint.
 */
export function describeRouteLegHover(
    legs: RouteLeg[],
    geometry: RouteGeometry,
    legIndex: number,
    player: [number, number] | null,
    waypoints: Array<[number, number]>,
): RouteLegHoverInfo | null {
    const leg = legs[legIndex];
    const count = flatPointCount(geometry.points);
    if (!leg || count < 2) {
        return null;
    }

    const prefix = new Array<number>(count);
    prefix[0] = 0;
    for (let index = 1; index < count; index += 1) {
        const ax = geometry.points[(index - 1) * 2];
        const ay = geometry.points[(index - 1) * 2 + 1];
        const bx = geometry.points[index * 2];
        const by = geometry.points[index * 2 + 1];
        prefix[index] = prefix[index - 1] + Math.hypot(bx - ax, by - ay);
    }

    const legStart = prefix[legPointStart(geometry, legIndex)] ?? 0;
    const legEnd = legEndAlong(geometry, legIndex, prefix);
    const legEta = leg.eta > 0 && Number.isFinite(leg.eta) ? leg.eta : null;
    const legSpeed = legEta === null ? null : safeSpeed(leg.distance, legEta);

    const waypointAlong = waypoints.map((waypoint) => (
        projectionAlong(waypoint, geometry.points)
    ));
    let nextWaypointIndex = waypointAlong.findIndex((along) => (
        along !== null && along > legStart + 0.5
    ));
    if (nextWaypointIndex < 0) {
        nextWaypointIndex = Math.max(0, waypoints.length - 1);
    }

    const previousIndex = nextWaypointIndex - 1;
    const previousAlong = previousIndex >= 0 && waypointAlong[previousIndex] !== null
        ? waypointAlong[previousIndex] as number
        : 0;
    const nextAlongRaw = waypointAlong[nextWaypointIndex];
    const nextAlong = waypointAlong.length > 0 && nextAlongRaw !== null
        ? nextAlongRaw
        : prefix[prefix.length - 1];

    let startAlong = previousAlong;
    let fromPlayer = false;
    if (player) {
        const playerAlong = projectionAlong(player, geometry.points);
        if (playerAlong !== null) {
            const playerDistance = distanceToInterval(playerAlong, legStart, legEnd);
            const previousDistance = distanceToInterval(previousAlong, legStart, legEnd);
            const playerInside = playerAlong >= legStart && playerAlong <= legEnd;
            if (playerDistance < previousDistance || (playerInside && playerDistance === previousDistance)) {
                startAlong = playerAlong;
                fromPlayer = true;
            }
        }
    }

    startAlong = Math.max(0, Math.min(startAlong, nextAlong));
    const spanDistance = Math.max(0, nextAlong - startAlong);
    let spanEta = 0;

    for (let index = 0; index < legs.length; index += 1) {
        const start = prefix[legPointStart(geometry, index)] ?? 0;
        const end = legEndAlong(geometry, index, prefix);
        const overlap = Math.max(0, Math.min(end, nextAlong) - Math.max(start, startAlong));
        if (overlap <= 0) {
            continue;
        }

        const speed = safeSpeed(legs[index].distance, legs[index].eta);
        if (speed === null) {
            spanEta = Number.NaN;
            break;
        }
        spanEta += overlap / speed;
    }

    const spanEtaValue = Number.isFinite(spanEta) ? spanEta : null;
    const spanSpeed = spanEtaValue === null ? null : safeSpeed(spanDistance, spanEtaValue);

    return {
        legIndex,
        kind: leg.kind,
        surface: leg.surface,
        roadKind: leg.roadKind,
        passable: leg.passable,
        mode: leg.mode,
        distance: leg.distance,
        eta: legEta,
        speed: legSpeed,
        nextWaypointIndex,
        fromPlayer,
        spanDistance,
        spanEta: spanEtaValue,
        spanSpeed,
    };
}
