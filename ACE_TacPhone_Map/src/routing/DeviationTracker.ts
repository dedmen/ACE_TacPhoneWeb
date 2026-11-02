/**
 * Off-route detection, waypoint progress and the auto-repath trigger.
 *
 * The tracker owns only timers/counters and returns decisions; `GpsModule`
 * applies them to the planner. This keeps the thresholds testable without a
 * map or a game.
 */

import type { RouteMetrics } from './RouteMetrics';
import { arrivalRadius } from './RouteMetrics';
import type { TravelMode } from './RouteTypes';

export const OFF_ROUTE_THRESHOLD_M = 100;
export const OFF_ROUTE_DELAY_MS = 4000;
export const REPATH_COOLDOWN_MS = 15000;

export interface DeviationInput {
    now: number;
    metrics: RouteMetrics;
    mode: TravelMode;
    navigating: boolean;
    autoRepath: boolean;
    waypointAlong: number[];
}

export interface DeviationResult {
    offRoute: boolean;
    /** True on the update that crossed a waypoint. */
    reachedWaypoint: boolean;
    /** True when the destination radius was entered. */
    arrived: boolean;
    /** True when the caller must start an auto-repath now. */
    repath: boolean;
}

export class DeviationTracker {
    private offRoute = false;
    private offRouteSince = 0;
    private lastRepathAt = Number.NEGATIVE_INFINITY;
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
        };
    }
}
