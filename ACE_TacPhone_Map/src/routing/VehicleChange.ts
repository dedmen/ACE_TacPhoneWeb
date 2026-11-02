/**
 * `GPS.VehicleChanged` parsing and debouncing.
 *
 * `GetOutMan` + `GetInMan` fire back to back when the player switches
 * vehicles, so the module must coalesce a short burst into one mode/performance
 * update. The debouncer is injectable so the unit tier can test it with a fake
 * clock instead of real timers.
 */

import type { TravelMode, VehiclePerformance } from './RouteTypes';

export const VEHICLE_DEBOUNCE_MS = 350;

export interface ParsedVehicleChange {
    detectedMode: TravelMode;
    waterCapable: boolean;
    performance: VehiclePerformance;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isTravelMode(value: unknown): value is TravelMode {
    return value === 'foot' || value === 'ground' || value === 'boat' || value === 'air';
}

/** Validates the `performance` object; unknown/invalid fields are dropped. */
export function readPerformance(value: unknown): VehiclePerformance {
    if (!value || typeof value !== 'object') {
        return {};
    }

    const source = value as Record<string, unknown>;
    const numberKeys: Array<keyof VehiclePerformance> = [
        'maxSpeedKmh', 'enginePowerKw', 'engineHealth', 'massKg', 'terrainCoef', 'waterResistanceCoef',
        'waterSpeedCoef', 'armor', 'maxTurnAngle', 'turnCoef', 'tankTurnForce',
        'precisionTurnCoef', 'widthM', 'lengthM', 'heightM',
    ];
    const performance: VehiclePerformance = {};

    for (const key of numberKeys) {
        const entry = source[key];
        if (isFiniteNumber(entry)) {
            (performance as Record<string, unknown>)[key] = entry;
        }
    }

    if (typeof source.canFloat === 'boolean') {
        performance.canFloat = source.canFloat;
    }
    if (typeof source.simulation === 'string') {
        performance.simulation = source.simulation;
    }

    return performance;
}

/** Parses one `GetPlayerTravelMode` / `GPS.VehicleChanged` response. */
export function parseVehicleChange(
    payload: unknown,
    fallbackMode: TravelMode,
): ParsedVehicleChange | null {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const source = payload as Record<string, unknown>;
    const detectedMode = isTravelMode(source.mode) ? source.mode : fallbackMode;
    const performance = readPerformance(source.performance);

    return {
        detectedMode,
        waterCapable: source.waterCapable === true || performance.canFloat === true,
        performance,
    };
}

/** Coalesces rapid vehicle-change payloads into one apply call. */
export class VehicleChangeDebouncer {
    private timer: number | null = null;
    private pending: unknown = null;
    private readonly apply: (payload: unknown) => void;
    private readonly delayMs: number;

    constructor(
        apply: (payload: unknown) => void,
        delayMs: number = VEHICLE_DEBOUNCE_MS,
    ) {
        this.apply = apply;
        this.delayMs = delayMs;
    }

    /** Latest payload wins; the timer restarts on every call. */
    public push(payload: unknown): void {
        this.pending = payload;

        if (this.timer !== null) {
            window.clearTimeout(this.timer);
        }

        this.timer = window.setTimeout(() => {
            this.timer = null;
            const pending = this.pending;
            this.pending = null;
            this.apply(pending);
        }, this.delayMs);
    }

    /** Applies the pending payload now (destroy/teardown path). */
    public flush(): void {
        if (this.timer === null && this.pending === null) {
            return;
        }

        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }

        const pending = this.pending;
        this.pending = null;
        if (pending !== null) {
            this.apply(pending);
        }
    }

    /** Drops the pending payload without applying it. */
    public cancel(): void {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
        this.pending = null;
    }
}
