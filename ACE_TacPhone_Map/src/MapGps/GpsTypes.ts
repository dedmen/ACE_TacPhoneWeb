/**
 * Shared value types for the GPS module.
 *
 * This file contains types only (plus the initial-state factory) so the
 * imperative module, the route planner, the sharing codec and the React
 * overlay can all agree on one shape without importing each other's
 * implementation.
 */

import type { TravelMode, VehiclePerformance } from '../routing/RouteTypes';

export type {
    ActiveRoute,
    GpsDebugOverlayMode,
    RouteDebugGrid,
    RouteDebugHeights,
    RouteLeg,
    RouteLegKind,
    RoutePlanRequest,
    RoutePlanResult,
    TravelMode,
    VehiclePerformance,
} from '../routing/RouteTypes';
export {
    ROUTE_DEBUG_FOREST,
    ROUTE_DEBUG_OFFROAD,
    ROUTE_DEBUG_ROAD,
    ROUTE_DEBUG_WATER,
} from '../routing/RouteTypes';

/** Current and detected transport state. */
export interface TravelModeState {
    /** Mode used for planning (the player may override the detected mode). */
    mode: TravelMode;
    /** Mode derived from the player's vehicle by the game. */
    detectedMode: TravelMode;
    /** Vehicle class name reported by the game; empty on foot. */
    vehicleClass: string;
    /** True when a ground vehicle may cross water (`canFloat`). */
    waterCapable: boolean;
    performance: VehiclePerformance;
}

/** High-level status the overlay renders with a `t()` lookup. */
export type GpsStatus =
    | { kind: 'analyzing' }
    | { kind: 'no-terrain' }
    | { kind: 'no-route' }
    | { kind: 'no-path' }
    | { kind: 'route-failed' }
    | { kind: 'vehicle-changed' }
    | { kind: 'advisor-unreachable'; mode: TravelMode };

/** One offer to switch to a faster route computed with the player's mode. */
export interface AdvisorPrompt {
    /** The mode the shared leg was authored for. */
    authoredMode: TravelMode;
    /** The player's current mode the alternative was planned with. */
    mode: TravelMode;
    /** Alternative travel time in seconds. */
    alternativeSeconds: number;
    /** Time saved compared with the authored remaining leg. */
    savesSeconds: number;
    /** Index of the next shared waypoint (0-based). */
    waypointIndex: number;
}

/** Read-only summary of the previewed shared route. */
export interface SharedPreviewInfo {
    author: string;
    mode: TravelMode;
    distance: number;
    eta: number | null;
    waypointCount: number;
    walkDistance: number;
    label?: string;
}

/** Route summary shown in the HUD/route panel. */
export interface RouteSummary {
    distance: number;
    remaining: number;
    eta: number | null;
    remainingEta: number | null;
    walkDistance: number;
    source: 'planned' | 'shared';
    author?: string;
    label?: string;
}

/**
 * Everything the overlay needs to render. Produced by `GpsModule`, never
 * mutated by React.
 */
export interface GpsViewState {
    hasFix: boolean;
    /** Camera heading in degrees clockwise from north; null before a fix. */
    heading: number | null;
    /** World-space player position. */
    position: [number, number] | null;
    /** Ground speed in metres per second. */
    speed: number;
    mode: TravelMode;
    detectedMode: TravelMode;
    waterCapable: boolean;
    /** True while the user is placing waypoints. */
    planning: boolean;
    /** True while navigation is active. */
    navigating: boolean;
    /** True while a route is being calculated or terrain is being parsed. */
    calculating: boolean;
    /** True when the map is rotated with the view direction. */
    rotating: boolean;
    /** Map rotation in degrees for the compass rose. */
    mapRotation: number;
    offRoute: boolean;
    stale: boolean;
    arrived: boolean;
    waypointCount: number;
    /** Ordered world-space waypoints for the route panel list. */
    waypoints: Array<[number, number]>;
    route: RouteSummary | null;
    /** Bearing from the player to the next route point, degrees; null if none. */
    routeBearing: number | null;
    /** Next maneuver at the next junction. */
    turn: 'left' | 'right' | 'straight' | null;
    /** Distance to the next maneuver in metres, or null. */
    turnDistance: number | null;
    status: GpsStatus | null;
    shared: SharedPreviewInfo | null;
    advisor: AdvisorPrompt | null;
}

/** Fresh overlay state before the first GPS update arrives. */
export function createInitialGpsViewState(): GpsViewState {
    return {
        hasFix: false,
        heading: null,
        position: null,
        speed: 0,
        mode: 'foot',
        detectedMode: 'foot',
        waterCapable: false,
        planning: false,
        navigating: false,
        calculating: false,
        rotating: true,
        mapRotation: 0,
        offRoute: false,
        stale: false,
        arrived: false,
        waypointCount: 0,
        waypoints: [],
        route: null,
        routeBearing: null,
        turn: null,
        turnDistance: null,
        status: null,
        shared: null,
        advisor: null,
    };
}

/** Runtime guard for a travel mode string. */
export function isTravelMode(value: unknown): value is TravelMode {
    return value === 'foot' || value === 'ground' || value === 'boat' || value === 'air';
}
