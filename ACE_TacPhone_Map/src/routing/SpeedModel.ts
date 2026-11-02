/**
 * Travel-time model shared by the route planner, the HUD ETA, shared-route
 * legs and the transport-mode advisor.
 *
 * Costs are seconds: every consumer must use these functions so the A* edge
 * cost and the displayed ETA agree. Ground vehicles use a force balance, not a
 * single nominal speed:
 *
 * ```
 * vMax   = maxSpeedKmh / 3.6
 * vClimb = enginePowerKw * 1000 * drivetrainEfficiency
 *          / (massKg * g * (sin(slope) + rollingResistance * cos(slope)))
 * v      = min(vMax * averageSpeedFactor, vClimb)
 *          * surfaceMultiplier * terrainCoefMultiplier * forestFactor
 * ```
 *
 * The rolling-resistance and surface constants are deliberately named and
 * grouped here so they can be tuned without touching the planner.
 */

import type { RouteLegKind, TravelMode, VehiclePerformance } from './RouteTypes';

/** Surface class used by the masks and the edge cost. */
export type RouteSurface = 'water' | 'road' | 'forest' | 'offroad';

/** Flat-ground jogging average, 14 km/h. */
export const FOOT_SPEED = 14 / 3.6;
/** Walking speed used once the slope exceeds the run limits, 5 km/h. */
export const FOOT_WALK_SPEED = 5 / 3.6;
/**
 * Arma character slope thresholds (rise/run, not degrees). Kept named so they
 * can be tuned without touching the formula.
 */
export const FOOT_MAX_RUN_SLOPE = 0.6;
export const FOOT_MIN_RUN_SLOPE = -0.8;
export const FOOT_MAX_SPRINT_SLOPE = 0.3;
export const FOOT_MIN_SPRINT_SLOPE = -0.5;
export const SWIM_SPEED = 0.5;
export const NOMINAL_AIR_SPEED = 55;
export const NOMINAL_BOAT_SPEED = 8;
export const NOMINAL_GROUND_ROAD_SPEED = 12;
export const NOMINAL_GROUND_OFFROAD_SPEED = 5;

export const GRAVITY = 9.81;
export const DRIVETRAIN_EFFICIENCY = 0.85;
/** Fraction of `maxSpeed` a vehicle can sustain on average (acceleration,
 * braking, corners and traffic). */
export const AVERAGE_SPEED_FACTOR = 0.8;
/** Level-surface rolling resistance; asphalt is lower than dirt. */
export const ROLLING_RESISTANCE = 0.08;
/** Below this speed a climb is treated as impassable. */
export const CRAWL_SPEED = 0.5;
/** Steepest slope the model still considers drivable (about 35 degrees). */
export const MAX_GROUND_SLOPE = 0.7;
/** Typical ground-vehicle acceleration used to price short legs, m/s². */
export const GROUND_ACCELERATION = 3;

/**
 * Caps a leg's average speed by the distance available to accelerate from
 * rest. A 40 m road section cannot reach a 136 km/h top speed even when the
 * surface and slope model allow it.
 */
export function accelerationLimitedSpeed(
    distance: number,
    speed: number,
    acceleration = GROUND_ACCELERATION,
): number {
    if (!(distance > 0) || !(speed > 0) || !(acceleration > 0)) {
        return speed;
    }
    return Math.min(speed, Math.sqrt(2 * acceleration * distance));
}

/**
 * Recomputes a ground leg ETA with the acceleration distance limit.
 *
 * `entrySpeed` is the previous leg's average speed: a car entering a short
 * road from an off-road section is already moving and accelerates from there,
 * so the road never becomes slower than the track it just left.
 */
export function limitGroundEta(distance: number, eta: number, entrySpeed = 0): number {
    if (!(distance > 0) || !(eta > 0)) {
        return eta;
    }

    const speed = distance / eta;
    const start = Math.max(0, Math.min(entrySpeed, speed));
    const acceleration = GROUND_ACCELERATION;
    const accelerationDistance = (speed * speed - start * start) / (2 * acceleration);

    let averageLimit: number;
    if (distance >= accelerationDistance) {
        const accelerationTime = (speed - start) / acceleration;
        const cruiseTime = (distance - accelerationDistance) / speed;
        averageLimit = distance / Math.max(1e-6, accelerationTime + cruiseTime);
    } else {
        const exit = Math.sqrt(start * start + 2 * acceleration * distance);
        averageLimit = (start + exit) / 2;
    }

    return averageLimit < speed ? Math.max(eta, distance / averageLimit) : eta;
}

/** Relative speed on each road class, before the vehicle model. */
export function roadClassFactor(kind: RouteLegKind): number {
    switch (kind) {
        case 'road':
            return 1;
        case 'walk':
            return 0.4;
        case 'water':
            return 0.3;
        default:
            return 0.6;
    }
}

function isPositive(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Foot speed from the slope. Flat ground is the 14 km/h jog average; from the
 * sprint limit to the run limit it blends down to the 5 km/h walk speed.
 * Beyond the run limit walking speed is used.
 */
export function footSpeed(slope: number | null = null): number {
    if (slope === null || !Number.isFinite(slope)) {
        return FOOT_SPEED;
    }

    const uphill = slope >= 0;
    const runLimit = uphill ? FOOT_MAX_RUN_SLOPE : -FOOT_MIN_RUN_SLOPE;
    const sprintLimit = uphill ? FOOT_MAX_SPRINT_SLOPE : -FOOT_MIN_SPRINT_SLOPE;
    const magnitude = Math.abs(slope);

    if (magnitude >= runLimit) {
        return FOOT_WALK_SPEED;
    }
    if (magnitude <= sprintLimit) {
        return FOOT_SPEED;
    }

    const t = (magnitude - sprintLimit) / Math.max(1e-6, runLimit - sprintLimit);
    return FOOT_SPEED + (FOOT_WALK_SPEED - FOOT_SPEED) * t;
}

function surfaceMultiplier(kind: RouteLegKind): number {
    switch (kind) {
        case 'road':
            return 1;
        case 'offroad':
            return 0.45;
        case 'water':
            return 0.3;
        case 'walk':
            return 0.4;
        case 'air':
            return 1;
    }
}

/**
 * Estimated speed in metres per second for a mode/surface combination.
 *
 * `slope` is the rise over run along the sampled segment (positive uphill).
 * Pass `null`/`undefined` when no height data is available; the level-ground
 * model is then used.
 */
export function legSpeed(
    mode: TravelMode,
    kind: RouteLegKind,
    performance: VehiclePerformance | undefined,
    waterCapable: boolean,
    slope: number | null = null,
): number {
    const perf = performance ?? {};

    if (mode === 'foot') {
        return kind === 'water' ? SWIM_SPEED : footSpeed(slope);
    }

    if (mode === 'air') {
        const max = isPositive(perf.maxSpeedKmh)
            ? perf.maxSpeedKmh / 3.6
            : NOMINAL_AIR_SPEED;
        return Math.max(20, max * AVERAGE_SPEED_FACTOR);
    }

    if (mode === 'boat') {
        const base = isPositive(perf.maxSpeedKmh)
            ? perf.maxSpeedKmh / 3.6
            : NOMINAL_BOAT_SPEED;
        const factor = clamp(isPositive(perf.waterSpeedCoef) ? perf.waterSpeedCoef : 0.7, 0.1, 1);
        const drag = 1 / (1 + Math.max(0, perf.waterResistanceCoef ?? 0));
        return Math.max(1.5, base * factor * drag);
    }

    // Ground vehicle.
    if (kind === 'water') {
        if (!waterCapable) {
            return 0;
        }
        const base = isPositive(perf.maxSpeedKmh)
            ? perf.maxSpeedKmh / 3.6
            : NOMINAL_GROUND_ROAD_SPEED;
        const factor = clamp(isPositive(perf.waterSpeedCoef) ? perf.waterSpeedCoef : 0.3, 0.05, 1);
        const drag = 1 / (1 + Math.max(0, perf.waterResistanceCoef ?? 0));
        return Math.max(0.8, base * factor * drag);
    }

    const nominal = kind === 'road' ? NOMINAL_GROUND_ROAD_SPEED : NOMINAL_GROUND_OFFROAD_SPEED;
    const health = clamp(
        typeof perf.engineHealth === 'number' && Number.isFinite(perf.engineHealth)
            ? perf.engineHealth
            : 1,
        0.1,
        1,
    );
    const healthFactor = 0.5 + 0.5 * health;
    const max = isPositive(perf.maxSpeedKmh) ? perf.maxSpeedKmh / 3.6 : nominal;
    let speed = max * AVERAGE_SPEED_FACTOR * healthFactor;

    if (isPositive(perf.enginePowerKw) && isPositive(perf.massKg)) {
        const grade = Math.abs(slope ?? 0);
        if (grade > MAX_GROUND_SLOPE) {
            return CRAWL_SPEED;
        }

        const angle = Math.atan(grade);
        // Rolling resistance is higher off asphalt.
        const rolling = kind === 'road' ? 0.015 : 0.1;
        const resistance = Math.sin(angle) + rolling * Math.cos(angle);
        const climb = (perf.enginePowerKw * healthFactor * 1000 * DRIVETRAIN_EFFICIENCY)
            / (perf.massKg * GRAVITY * resistance);
        if (Number.isFinite(climb) && climb > 0) {
            speed = Math.min(speed, climb);
        }

        // A climb that cannot beat the crawl speed is not drivable.
        if (slope !== null && slope > 0 && speed < CRAWL_SPEED) {
            return CRAWL_SPEED;
        }
    }

    speed *= surfaceMultiplier(kind);

    if (kind === 'road') {
        return Math.max(1.5, speed);
    }

    const terrainFactor = clamp(isPositive(perf.terrainCoef) ? perf.terrainCoef : 1, 0.5, 1);
    return Math.max(0.5, speed * terrainFactor);
}

/** Forest speed factor for a ground vehicle; wider vehicles are slower. */
export function forestSpeedFactor(performance: VehiclePerformance | undefined): number {
    const perf = performance ?? {};
    const width = isPositive(perf.widthM) ? perf.widthM : 2;
    // Woods are much slower than open ground, and wide vehicles suffer more.
    const widthFactor = clamp(0.75 - width / 8, 0.15, 0.5);
    const armor = isPositive(perf.armor) ? perf.armor : 0;
    const bulldozer = perf.simulation === 'tankx' ? clamp(1 - armor / 4000, 0.8, 1) : 1;
    return widthFactor * bulldozer;
}

/** Speed for one grid edge or road edge, including the forest penalty. */
export function edgeSpeed(
    mode: TravelMode,
    surface: RouteSurface,
    performance: VehiclePerformance | undefined,
    waterCapable: boolean,
    slope: number | null = null,
): number {
    if (mode === 'foot') {
        return surface === 'water' ? SWIM_SPEED : footSpeed(slope);
    }
    if (mode === 'air') {
        return legSpeed('air', 'air', performance, false);
    }
    if (mode === 'boat') {
        return legSpeed('boat', 'water', performance, true);
    }

    const kind: RouteLegKind = surface === 'water'
        ? 'water'
        : surface === 'road'
            ? 'road'
            : 'offroad';
    let speed = legSpeed('ground', kind, performance, waterCapable, slope);

    if (kind === 'offroad' && surface === 'forest') {
        speed *= forestSpeedFactor(performance);
    }
    return speed;
}

/** Speed on the road graph for a parsed road class. */
export function roadSpeed(
    kind: 'main' | 'road' | 'track' | 'rail' | 'trail',
    performance: VehiclePerformance | undefined,
    waterCapable: boolean,
    slope: number | null = null,
): number {
    const factor = kind === 'main'
        ? 1
        : kind === 'road'
            ? 0.9
            : kind === 'track'
                ? 0.6
                : kind === 'rail'
                    ? 0.5
                    : 0.4;
    return legSpeed('ground', 'road', performance, waterCapable, slope) * factor;
}
