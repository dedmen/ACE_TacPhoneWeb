/**
 * Terrain/cost-field sibling of `RoutePlanner`.
 *
 * Owns the queries that turn parsed terrain into search costs: the
 * `GridContext` the A* search runs against, the water-edge and slope cost
 * modifiers, the fine foot-path slope validation, the debug cost/slope grid
 * export and the height-cache stats. The planner owns the terrain state
 * (`masks`, `heights`) and the search itself; this class reads it through its
 * back-reference and is constructed by the planner.
 */

import type { BBox, RasterSet } from '../terrain/TerrainMasks';
import {
    buildDebugGrid,
    segmentCost,
    type GridContext,
} from '../routing/TerrainGrid';
import {
    slopeAt as heightSlopeAt,
} from '../routing/TerrainHeights';
import { MAX_GROUND_SLOPE } from '../routing/SpeedModel';
import type {
    RouteDebugGrid,
    RouteLeg,
    TravelMode,
    VehiclePerformance,
} from '../routing/RouteTypes';
import { distanceBetween } from './SharedRoute';
import type { RoutePlanner } from './RoutePlanner';

/** Search-only slowdown for foot paths that hug a water edge, metres. */
const WATER_EDGE_PENALTY_M = 3;
const WATER_EDGE_PENALTY_FACTOR = 0.5;

/** Terrain/cost-field queries for one route planner. */
export class RouteCostField {
    private readonly m: RoutePlanner;

    constructor(m: RoutePlanner) {
        this.m = m;
    }

    /**
     * Debug only: builds a cost/slope grid for the current viewport without
     * planning a route. The overlay uses the same masks and speed model as a
     * real plan, so it explains the colours the player sees.
     */
    public async scanDebugGrid(
        bbox: [number, number, number, number],
        mode: TravelMode,
        waterCapable: boolean,
        performance: VehiclePerformance | undefined,
    ): Promise<RouteDebugGrid | null> {
        if (this.m.disposed || !this.m.terrain) {
            return null;
        }

        const clamped: [number, number, number, number] = [
            Math.max(0, Math.min(this.m.terrain.width, bbox[0])),
            Math.max(0, Math.min(this.m.terrain.height, bbox[1])),
            Math.max(0, Math.min(this.m.terrain.width, bbox[2])),
            Math.max(0, Math.min(this.m.terrain.height, bbox[3])),
        ];
        if (clamped[2] <= clamped[0] || clamped[3] <= clamped[1]) {
            return null;
        }

        const cell = this.m.masks.cellSizeFor(clamped);
        const isCancelled = (): boolean => this.m.disposed;
        const rasters = await this.m.masks.buildRasters(mode, clamped, cell, isCancelled);
        if (this.m.disposed) {
            return null;
        }

        const heightGrid = mode === 'foot' || mode === 'ground'
            ? await this.m.heights.sampleGrid(clamped, 96, isCancelled)
            : null;
        const slopeAt = heightGrid
            ? (x: number, y: number): number | null => heightSlopeAt(heightGrid, x, y)
            : undefined;

        return buildDebugGrid(
            this.gridContext(
                mode,
                rasters,
                clamped,
                cell,
                performance,
                waterCapable,
                isCancelled,
                slopeAt,
            ),
            heightGrid,
        );
    }

    /** Debug/test only: height cache and request counters. */
    public getHeightStats(): {
        lru: number;
        peaks: number;
        ring: number;
        coarseRequests: number;
        fineRequests: number;
    } {
        return this.m.heights.stats;
    }

    /**
     * Fine 1 m validation of a foot path.
     *
     * Samples are capped at 2000 points, so a very long route widens the
     * spacing instead of sending an unbounded request. A sample pair with a
     * grade above `MAX_GROUND_SLOPE` becomes a problem point for the reroute.
     */
    public async validateFootPath(
        legs: RouteLeg[],
        isCancelled: () => boolean,
    ): Promise<Array<[number, number]>> {
        const flat: number[] = [];
        let length = 0;
        for (const leg of legs) {
            for (let index = 0; index < leg.points.length; index += 2) {
                const x = leg.points[index];
                const y = leg.points[index + 1];
                const count = flat.length / 2;
                if (count > 0 && flat[(count - 1) * 2] === x && flat[(count - 1) * 2 + 1] === y) {
                    continue;
                }
                flat.push(x, y);
            }
            length += leg.distance;
        }

        if (flat.length < 4) {
            return [];
        }

        const spacing = Math.max(1, length / 2000);
        const samples = await this.m.heights.samplePath(flat, spacing, isCancelled, false);
        if (isCancelled() || samples.length < 2) {
            return [];
        }

        const problems: Array<[number, number]> = [];
        for (let index = 0; index + 1 < samples.length && problems.length < 64; index += 1) {
            const a = samples[index];
            const b = samples[index + 1];
            const horizontal = distanceBetween(a.x, a.y, b.x, b.y);
            if (!(horizontal > 0)) {
                continue;
            }
            const grade = Math.abs(b.height - a.height) / horizontal;
            if (grade > MAX_GROUND_SLOPE) {
                problems.push([(a.x + b.x) / 2, (a.y + b.y) / 2]);
            }
        }

        return problems;
    }

    /** Search penalty near a failed fine-validation point. */
    public makePenalty(
        problems: Array<[number, number]>,
    ): (x: number, y: number) => number {
        const radius = 25;
        return (x: number, y: number): number => {
            for (const problem of problems) {
                if (distanceBetween(x, y, problem[0], problem[1]) <= radius) {
                    return 0.05;
                }
            }
            return 1;
        };
    }

    /**
     * Search-only slowdown for land within a few metres of water. Foot routes
     * should not skim the coastline when a slightly inland line is just as
     * fast; the displayed ETA stays the real speed.
     */
    private waterEdgePenalty(rasters: RasterSet): (x: number, y: number) => number {
        const offsets: ReadonlyArray<readonly [number, number]> = [
            [WATER_EDGE_PENALTY_M, 0],
            [-WATER_EDGE_PENALTY_M, 0],
            [0, WATER_EDGE_PENALTY_M],
            [0, -WATER_EDGE_PENALTY_M],
        ];
        return (x: number, y: number): number => {
            if (this.m.masks.landAt(x, y, rasters) === false) {
                return 1;
            }
            for (const [dx, dy] of offsets) {
                if (this.m.masks.landAt(x + dx, y + dy, rasters) === false) {
                    return WATER_EDGE_PENALTY_FACTOR;
                }
            }
            return 1;
        };
    }

    /** Travel time of a path span using the search masks and speed model. */
    public pathEta(
        context: GridContext,
        path: number[],
        fromIndex: number,
        toIndex: number,
    ): number {
        let eta = 0;
        for (let index = fromIndex; index < toIndex; index += 1) {
            eta += segmentCost(
                context,
                path[index * 2],
                path[index * 2 + 1],
                path[(index + 1) * 2],
                path[(index + 1) * 2 + 1],
            );
        }
        return eta;
    }

    /** Clamps a corridor box to the terrain, if its dimensions are known. */
    public clampBounds(bounds: BBox): BBox {
        const terrain = this.m.masks.getBounds();
        if (!terrain) {
            return bounds;
        }
        return [
            Math.max(0, bounds[0]),
            Math.max(0, bounds[1]),
            Math.min(terrain.width, bounds[2]),
            Math.min(terrain.height, bounds[3]),
        ];
    }

    public gridContext(
        mode: TravelMode,
        rasters: RasterSet,
        bbox: BBox,
        cell: number,
        performance: VehiclePerformance | undefined,
        waterCapable: boolean,
        isCancelled: () => boolean,
        slopeAt?: (x: number, y: number) => number | null,
        penaltyAt?: (x: number, y: number) => number,
    ): GridContext {
        const effectivePenalty = mode === 'foot' && penaltyAt === undefined
            ? this.waterEdgePenalty(rasters)
            : penaltyAt;

        return {
            mode,
            masks: this.m.masks,
            rasters,
            bbox,
            cell,
            waterCapable,
            performance,
            isCancelled,
            slopeAt,
            penaltyAt: effectivePenalty,
        };
    }
}
