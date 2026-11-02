/**
 * Pure helpers for the foot water-corridor pass.
 *
 * A coarse terrain raster can mark a narrow beach or land bridge as water. The
 * resulting A* path then swims for a few cells instead of walking around the
 * obstacle. These helpers find those water stretches on an existing path so
 * the planner can re-run only that stretch on a finer local raster.
 *
 * No browser, terrain or route-class dependencies: the unit tier imports this
 * module directly.
 */

import type { BBox } from '../terrain/TerrainMasks';

/** One contiguous water stretch on a flat `[x, y, ...]` path. */
export interface WaterRun {
    /** Index of the first path vertex before the water stretch. */
    startIndex: number;
    /** Index of the last path vertex after the water stretch. */
    endIndex: number;
    /** Water length inside the run, in metres. */
    waterDistance: number;
}

/** Surface callback used to classify a path point. */
export type SurfaceAt = (x: number, y: number) => string;

/** World point at a vertex index. */
export function pointAt(points: number[], index: number): [number, number] {
    return [points[index * 2], points[index * 2 + 1]];
}

/** Length of the path between two vertex indices, in metres. */
export function pathLength(points: number[], fromIndex = 0, toIndex = Math.floor(points.length / 2) - 1): number {
    let length = 0;
    for (let index = fromIndex; index < toIndex; index += 1) {
        const ax = points[index * 2];
        const ay = points[index * 2 + 1];
        const bx = points[(index + 1) * 2];
        const by = points[(index + 1) * 2 + 1];
        length += Math.hypot(bx - ax, by - ay);
    }
    return length;
}

/**
 * Inserts vertices where a path crosses a water boundary.
 *
 * A simplified path can jump from a point 1.8 km before a bay to a point after
 * it. Repairing "the water" would then replan the whole 1.8 km span. Splitting
 * at the coast first keeps the corridor around the actual water.
 */
export function splitPathAtWater(
    points: number[],
    surfaceAt: SurfaceAt,
    step = 10,
): number[] {
    const count = Math.floor(points.length / 2);
    if (count < 2) {
        return points.slice();
    }

    const sampleStep = Math.max(1, step);
    const result: number[] = [points[0], points[1]];
    let previousWater = surfaceAt(points[0], points[1]) === 'water';

    for (let index = 0; index < count - 1; index += 1) {
        const ax = points[index * 2];
        const ay = points[index * 2 + 1];
        const bx = points[(index + 1) * 2];
        const by = points[(index + 1) * 2 + 1];
        const length = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(length / sampleStep));

        for (let sample = 1; sample <= steps; sample += 1) {
            const t = sample / steps;
            const x = sample === steps ? bx : ax + (bx - ax) * t;
            const y = sample === steps ? by : ay + (by - ay) * t;
            const wet = surfaceAt(x, y) === 'water';

            if (wet !== previousWater) {
                result.push(x, y);
                previousWater = wet;
            }
        }

        // Keep the original vertex even when no boundary fell on it.
        const lastX = result[result.length - 2];
        const lastY = result[result.length - 1];
        if (lastX !== bx || lastY !== by) {
            result.push(bx, by);
        }
    }

    return result;
}

/**
 * Finds water stretches on a path.
 *
 * Each path segment is sampled at `step` metres. A segment that contains any
 * water joins the current run, and the run keeps its first and last vertex so
 * the caller can replace the whole stretch without leaving a gap.
 */
export function findWaterRuns(
    points: number[],
    surfaceAt: SurfaceAt,
    step = 10,
): WaterRun[] {
    const count = Math.floor(points.length / 2);
    if (count < 2) {
        return [];
    }

    const sampleStep = Math.max(1, step);
    const runs: WaterRun[] = [];
    let current: WaterRun | null = null;

    for (let index = 0; index < count - 1; index += 1) {
        const ax = points[index * 2];
        const ay = points[index * 2 + 1];
        const bx = points[(index + 1) * 2];
        const by = points[(index + 1) * 2 + 1];
        const length = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(length / sampleStep));
        const piece = length / steps;
        let waterDistance = 0;

        for (let sample = 0; sample < steps; sample += 1) {
            const t = (sample + 0.5) / steps;
            const x = ax + (bx - ax) * t;
            const y = ay + (by - ay) * t;
            if (surfaceAt(x, y) === 'water') {
                waterDistance += piece;
            }
        }

        if (waterDistance > 0) {
            if (current === null) {
                current = { startIndex: index, endIndex: index + 1, waterDistance: 0 };
            }
            current.endIndex = index + 1;
            current.waterDistance += waterDistance;
        } else if (current !== null) {
            runs.push(current);
            current = null;
        }
    }

    if (current !== null) {
        runs.push(current);
    }

    return runs;
}

/**
 * Merges runs separated by only a short land gap, such as the two sides of a
 * rasterized coastline separated by a single grid cell.
 */
export function mergeNearbyWaterRuns(
    points: number[],
    runs: WaterRun[],
    maxLandGap = 40,
): WaterRun[] {
    const merged: WaterRun[] = [];

    for (const run of runs) {
        const previous = merged[merged.length - 1];
        if (previous === undefined) {
            merged.push({ ...run });
            continue;
        }

        const gap = pathLength(points, previous.endIndex, run.startIndex);
        if (gap <= maxLandGap) {
            previous.endIndex = run.endIndex;
            previous.waterDistance += run.waterDistance;
        } else {
            merged.push({ ...run });
        }
    }

    return merged;
}

/**
 * Moves a run's endpoints out of water so the replacement can start and end
 * on land. Returns `null` when an endpoint is still water at the path end
 * (an island or a start/end in the sea), which must stay a swim.
 */
export function extendRunToLand(
    points: number[],
    run: WaterRun,
    surfaceAt: SurfaceAt,
): WaterRun | null {
    const count = Math.floor(points.length / 2);
    let startIndex = run.startIndex;
    let endIndex = run.endIndex;

    const isWater = (index: number): boolean => {
        const [x, y] = pointAt(points, index);
        return surfaceAt(x, y) === 'water';
    };

    while (startIndex > 0 && isWater(startIndex)) {
        startIndex -= 1;
    }
    while (endIndex < count - 1 && isWater(endIndex)) {
        endIndex += 1;
    }

    // A route may begin or end in water (a beach start, a pier, a shared
    // route joined from the sea). Keep the forced swim at that end, but move
    // the repairable part to the first/last land vertex so the corridor pass
    // can still fix the rest of the route.
    if (startIndex === 0 && isWater(0)) {
        while (startIndex < count && isWater(startIndex)) {
            startIndex += 1;
        }
    }
    if (endIndex === count - 1 && isWater(count - 1)) {
        while (endIndex >= 0 && isWater(endIndex)) {
            endIndex -= 1;
        }
    }

    if (startIndex >= endIndex || startIndex >= count || endIndex < 0) {
        return null;
    }

    return { ...run, startIndex, endIndex };
}

/** Bounding box around a run, including a margin on every side. */
export function corridorBounds(
    points: number[],
    run: WaterRun,
    margin: number,
): BBox {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (let index = run.startIndex; index <= run.endIndex; index += 1) {
        const x = points[index * 2];
        const y = points[index * 2 + 1];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }

    if (!Number.isFinite(minX)) {
        return [0, 0, 0, 0];
    }

    return [minX - margin, minY - margin, maxX + margin, maxY + margin];
}

/**
 * Whether a fine land replacement is worth taking.
 *
 * The comparison is against the whole replaced span, not just the water
 * length: a simplified path often jumps from a point far before the coast to
 * one after it. Water is slow, but a detour of several kilometres is worse
 * than a short swim, so both distance and time are capped.
 */
export function waterReplacementAcceptable(
    originalEta: number,
    replacementEta: number,
    originalDistance: number,
    replacementDistance: number,
    waterDistance: number,
): boolean {
    if (!Number.isFinite(originalEta) || !Number.isFinite(replacementEta)) {
        return false;
    }
    return replacementDistance <= originalDistance * 3 + waterDistance * 5 + 750
        && replacementEta <= originalEta * 1.1 + 60;
}
