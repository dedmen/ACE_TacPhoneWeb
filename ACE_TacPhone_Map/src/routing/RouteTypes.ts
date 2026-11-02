/**
 * Pure routing value types.
 *
 * Kept free of React, OpenLayers and module state so the terrain grid, the
 * road graph, the speed model and the unit tier can share the exact shapes
 * without importing the GPS module.
 */

import type { SharedRouteData } from '../MapGps/SharedRoute';

/** Travel modes the GPS can plan and follow. */
export type TravelMode = 'foot' | 'ground' | 'boat' | 'air';

/** Surface class of one route leg. */
export type RouteLegKind = 'road' | 'offroad' | 'water' | 'walk' | 'air';

/**
 * Vehicle configuration snapshot returned by `GetPlayerTravelMode` and
 * `GPS.VehicleChanged`. Missing config values come back as `0`/`false`; treat
 * them as unavailable and fall back to the nominal mode speeds.
 */
export interface VehiclePerformance {
    maxSpeedKmh?: number;
    enginePowerKw?: number;
    massKg?: number;
    /** 0..1; 1 is an undamaged engine. Missing means 1. */
    engineHealth?: number;
    terrainCoef?: number;
    canFloat?: boolean;
    waterResistanceCoef?: number;
    waterSpeedCoef?: number;
    armor?: number;
    simulation?: string;
    maxTurnAngle?: number;
    turnCoef?: number;
    tankTurnForce?: number;
    precisionTurnCoef?: number;
    widthM?: number;
    lengthM?: number;
    heightM?: number;
}

/** One contiguous stretch of a route with a single surface class. */
export interface RouteLeg {
    mode: TravelMode;
    kind: RouteLegKind;
    /** Flat `[x, y, ...]` world coordinates. */
    points: number[];
    /** Length in metres. */
    distance: number;
    /** Travel time in seconds with the performance used at creation time. */
    eta: number;
    /** Where this leg came from: local planning, a shared route, the advisor. */
    source?: 'planned' | 'shared' | 'advisor' | 'connector';
}

/** A route that is currently displayed (planned or opened from a share). */
export interface ActiveRoute {
    source: 'planned' | 'shared';
    legs: RouteLeg[];
    /** Ordered world-space waypoints, including the destination. */
    waypoints: Array<[number, number]>;
    /** Total length in metres. */
    distance: number;
    /** Total travel time in seconds, or null when unknown. */
    eta: number | null;
    /** Mission/creation time in seconds; used for the shared payload. */
    createdAt: number;
    /** Optional destination label from a shared route. */
    label?: string;
    /** Author name of a shared route. */
    author?: string;
    /** Original shared payload, kept for the advisor and re-sharing. */
    shared?: SharedRouteData;
}

/** Input for one route calculation. */
export interface RoutePlanRequest {
    start: [number, number];
    waypoints: Array<[number, number]>;
    mode: TravelMode;
    waterCapable?: boolean;
    performance?: VehiclePerformance;
    /**
     * Validate the chosen path with fine height samples after it is built.
     * Off for live previews; on for an explicit Calculate/Recalculate.
     */
    validate?: boolean;
    /** Returns true when a newer request superseded this one. */
    cancelled?: () => boolean;
}

/** Debug-only route-planning overlay chosen in the GPS debug dialog. */
export type GpsDebugOverlayMode = 'none' | 'cost' | 'height' | 'both';

/** Surface code stored per cell of a {@link RouteDebugGrid}. */
export const ROUTE_DEBUG_WATER = 0;
export const ROUTE_DEBUG_ROAD = 1;
export const ROUTE_DEBUG_FOREST = 2;
export const ROUTE_DEBUG_OFFROAD = 3;

/** Coarse terrain height samples gathered for the debug overlays. */
export interface RouteDebugHeights {
    bbox: [number, number, number, number];
    width: number;
    height: number;
    /** Metres above sea level per sample, row-major; `NaN` when unknown. */
    values: Float32Array;
    min: number;
    max: number;
}

/**
 * Debug-only snapshot of the route-planning grid.
 *
 * Only produced when `RoutePlanner.setDebug(true)` is active, and only used by
 * the debug overlay: nothing in routing, ETAs or the HUD reads it.
 */
export interface RouteDebugGrid {
    bbox: [number, number, number, number];
    /** Metres per cell. */
    cell: number;
    width: number;
    height: number;
    /** One {@link ROUTE_DEBUG_WATER}...{@link ROUTE_DEBUG_OFFROAD} code per cell. */
    surface: Uint8Array;
    /** Surface-only travel cost in seconds per metre per cell. */
    cost: Float32Array;
    /** Slope cost multiplier (>= 1) per cell; 1 without slope data. */
    slope: Float32Array;
    /** 1 when the cell is reachable in the planned mode, 0 otherwise. */
    passable: Uint8Array;
    /** True when terrain heights were available for the slope component. */
    hasSlope: boolean;
    /** Coarse heights used by the height overlay; null when unavailable. */
    heights: RouteDebugHeights | null;
}

/** Result of one route calculation. */
export interface RoutePlanResult {
    ok: boolean;
    route?: ActiveRoute;
    reason?: 'no-path' | 'no-terrain' | 'cancelled' | 'error';
    /** Debug-only planning grid; present only while the planner debug flag is on. */
    debug?: RouteDebugGrid;
}
