/**
 * Off-route detection, deviation zoom, waypoint progress and the auto-repath
 * trigger.
 *
 * The tracker owns only timers/counters and returns decisions; `GpsModule`
 * applies them to the OpenLayers view and the planner. This keeps the
 * thresholds testable without a map or a game.
 */

import { distanceBetween } from '../MapGps/SharedRoute';
import type { RouteMetrics } from './RouteMetrics';
import { arrivalRadius } from './RouteMetrics';
import type { TravelMode } from './RouteTypes';

export const OFF_ROUTE_THRESHOLD_M = 100;
export const OFF_ROUTE_DELAY_MS = 4000;
export const REPATH_COOLDOWN_MS = 15000;
export const OFF_ROUTE_ZOOM_INTERVAL_MS = 1000;

export interface DeviationView {
    resolution: number;
    maxResolution: number;
    /** Shorter viewport side in pixels, already reduced for the HUD. */
    viewportPixels: number;
}

export interface DeviationInput {
    now: number;
    metrics: RouteMetrics;
    mode: TravelMode;
    speed: number;
    navigating: boolean;
    following: boolean;
    autoRepath: boolean;
    waypointAlong: number[];
    nextWaypoint: [number, number] | null;
    position: [number, number] | null;
    view: DeviationView | null;
}

export interface DeviationResult {
    offRoute: boolean;
    /** True on the update that crossed a waypoint. */
    reachedWaypoint: boolean;
    /** True when the destination radius was entered. */
    arrived: boolean;
    /** True when the caller must start an auto-repath now. */
    repath: boolean;
    /** Target resolution when the caller should zoom out, else null. */
    zoomResolution: number | null;
}

/**
 * Keeps the next waypoint and the player visible without fitting the whole
 * terrain: resolution is capped at 2.5x the current zoom and grows only
 * enough that the waypoint fits inside the viewport.
 */
function fitNextWaypoint(
    position: [number, number],
    next: [number, number],
    view: DeviationView,
): number | null {
    if (!(view.resolution > 0) || !(view.viewportPixels > 0) || !(view.maxResolution > 0)) {
        return null;
    }

    const distanceToNext = distanceBetween(position[0], position[1], next[0], next[1]);
    const fitResolution = (distanceToNext * 2.4) / view.viewportPixels;
    const capped = Math.min(
        view.maxResolution,
        view.resolution * 2.5,
        Math.max(view.resolution, fitResolution),
    );

    return capped > view.resolution * 1.02 ? capped : null;
}

export class DeviationTracker {
    private offRoute = false;
    private offRouteSince = 0;
    private lastRepathAt = Number.NEGATIVE_INFINITY;
    private lastOffRouteZoomAt = Number.NEGATIVE_INFINITY;
    private waypointsReached = 0;

    public get isOffRoute(): boolean {
        return this.offRoute;
    }

    public get reachedCount(): number {
        return this.waypointsReached;
    }

    /** Clears the deviation timers; called when a new route is installed. */
    public reset(): void {
        this.offRoute = false;
        this.offRouteSince = 0;
        this.lastRepathAt = Number.NEGATIVE_INFINITY;
        this.lastOffRouteZoomAt = Number.NEGATIVE_INFINITY;
    }

    /** Resets only the waypoint counter (new route, new waypoint list). */
    public resetProgress(): void {
        this.waypointsReached = 0;
    }

    public update(input: DeviationInput): DeviationResult {
        const offRoute = input.metrics.distance > OFF_ROUTE_THRESHOLD_M;
        this.offRoute = offRoute;

        if (!offRoute) {
            this.offRouteSince = 0;
        } else if (this.offRouteSince === 0) {
            this.offRouteSince = input.now;
        }

        let reachedWaypoint = false;
        while (
            input.navigating
            && this.waypointsReached < input.waypointAlong.length
            && input.metrics.along >= input.waypointAlong[this.waypointsReached] - 5
        ) {
            this.waypointsReached += 1;
            reachedWaypoint = true;
        }

        let zoomResolution: number | null = null;
        if (
            offRoute
            && input.following
            && input.position
            && input.nextWaypoint
            && input.view
            && input.now - this.lastOffRouteZoomAt > OFF_ROUTE_ZOOM_INTERVAL_MS
        ) {
            zoomResolution = fitNextWaypoint(input.position, input.nextWaypoint, input.view);
            if (zoomResolution !== null) {
                this.lastOffRouteZoomAt = input.now;
            }
        }

        let repath = false;
        if (
            offRoute
            && input.autoRepath
            && this.offRouteSince > 0
            && input.now - this.offRouteSince > OFF_ROUTE_DELAY_MS
            && input.now - this.lastRepathAt > REPATH_COOLDOWN_MS
        ) {
            this.lastRepathAt = input.now;
            repath = true;
        }

        const arrived = input.metrics.remaining <= arrivalRadius(input.mode) && !offRoute;

        return {
            offRoute,
            reachedWaypoint,
            arrived,
            repath,
            zoomResolution,
        };
    }
}
