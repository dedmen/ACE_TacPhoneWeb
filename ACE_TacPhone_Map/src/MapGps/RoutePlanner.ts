/**
 * Route planner for the GPS module.
 *
 * Terrain data is parsed lazily by `TerrainMasks`; the road graph lives in
 * `roads/RoadNetwork` and the terrain-grid search in `routing/TerrainGrid`.
 * This class only orchestrates the modes, legs and road/grid connectors.
 *
 * | Mode   | Strategy                                                        |
 * | ------ | --------------------------------------------------------------- |
 * | air    | direct lines, no terrain                                        |
 * | boat   | water-only grid, foot legs from/to land                         |
 * | foot   | terrain grid, objects block, water is a slow swim                |
 * | ground | road graph first, grid connectors, grid fallback                |
 */

import type { TerrainData } from '@ace-tacphone/api';
import { parseRoadLayer } from '../roads/RoadSvgParser';
import { RoadNetwork, type RoadPath } from '../roads/RoadNetwork';
import { TerrainMasks, type BBox, type RasterSet } from '../terrain/TerrainMasks';
import {
    edgeSpeed,
    legSpeed,
    roadSpeed,
    type RouteSurface,
} from '../routing/SpeedModel';
import {
    buildDebugGrid,
    searchGrid,
    simplifyGridPath,
    type GridContext,
} from '../routing/TerrainGrid';
import {
    TerrainHeights,
    slopeAt as heightSlopeAt,
} from '../routing/TerrainHeights';
import { MAX_GROUND_SLOPE } from '../routing/SpeedModel';
import type {
    ActiveRoute,
    RouteDebugGrid,
    RouteLeg,
    RouteLegKind,
    RoutePlanRequest,
    RoutePlanResult,
    TravelMode,
    VehiclePerformance,
} from '../routing/RouteTypes';
import { distanceBetween } from './SharedRoute';

export { legSpeed } from '../routing/SpeedModel';

/** Debug/test route for a water-capable vehicle or boat setup. */
export interface WaterRouteWaypoints {
    /** Road point where the player/vehicle is spawned. */
    playerStart: [number, number];
    /** Different road point near the coast; the first waypoint. */
    roadStart: [number, number];
    /** Water point about `waterDistanceM` past the coast. */
    waterPoint: [number, number];
    /** Road point back on land, on the return side. */
    roadEnd: [number, number];
}

/** Plans routes for one terrain snapshot. */
export class RoutePlanner {
    private readonly masks: TerrainMasks;
    private readonly heights = new TerrainHeights();
    private terrain: TerrainData | null;
    private disposed = false;
    /** Lazily built width-aware road graph for ground routing. */
    private roadNetwork: RoadNetwork | null = null;
    /**
     * Debug-only grid export. Off by default and never read by routing itself;
     * `GpsModule` switches it on in debug builds only.
     */
    private debug = false;

    constructor(terrain: TerrainData | null) {
        this.terrain = terrain;
        this.masks = new TerrainMasks(terrain);
    }

    /** Debug only: includes a planning grid in every result while enabled. */
    public setDebug(enabled: boolean): void {
        this.debug = enabled === true;
    }

    /** True while the debug planning grid is collected. */
    public isDebug(): boolean {
        return this.debug;
    }

    /** Debug/test only: nearest road nodes and a path between two points. */
    public debugRoadQuery(
        start: [number, number],
        goal: [number, number],
        performance: VehiclePerformance | undefined,
        waterCapable: boolean,
    ): {
        startNode: number | null;
        goalNode: number | null;
        startPoint: [number, number] | null;
        goalPoint: [number, number] | null;
        pathLength: number | null;
    } {
        const network = this.getRoadNetwork();
        if (!network) {
            return { startNode: null, goalNode: null, startPoint: null, goalPoint: null, pathLength: null };
        }

        const startNode = network.nearestNode(start, 500);
        const goalNode = network.nearestNode(goal, 500);
        const path = startNode !== null && goalNode !== null
            ? network.findPath(
                start,
                goal,
                (kind) => roadSpeed(kind, performance, waterCapable),
            )
            : null;

        return {
            startNode,
            goalNode,
            startPoint: startNode === null ? null : network.nodePoint(startNode),
            goalPoint: goalNode === null ? null : network.nodePoint(goalNode),
            pathLength: path?.length ?? null,
        };
    }

    /** Debug/test only: height cache and request counters. */
    public getHeightStats(): {
        lru: number;
        peaks: number;
        ring: number;
        coarseRequests: number;
        fineRequests: number;
    } {
        return this.heights.stats;
    }

    /** Debug/test only: road graph size, or null when no roads layer exists. */
    public getRoadStats(): { polylines: number; nodes: number; segments: number } | null {
        const network = this.getRoadNetwork();
        return network
            ? {
                polylines: network.polylineCount,
                nodes: network.nodeCount,
                segments: network.segmentCount,
            }
            : null;
    }

    /** Replaces the terrain snapshot and drops parsed SVG data. */
    public setTerrain(terrain: TerrainData | null): void {
        if (this.terrain === terrain) {
            return;
        }

        this.terrain = terrain;
        this.masks.setTerrain(terrain);
        this.heights.clear();
        this.roadNetwork = null;
    }

    /** Drops caches; in-flight work checks `disposed` and returns cancelled. */
    public dispose(): void {
        this.disposed = true;
        this.masks.dispose();
        this.heights.clear();
        this.terrain = null;
        this.roadNetwork = null;
    }

    /** Terrain width/height, or null when no terrain is loaded yet. */
    public getBounds(): { width: number; height: number } | null {
        return this.terrain
            ? { width: this.terrain.width, height: this.terrain.height }
            : null;
    }

    /** Terrain-only water query over a box around `point`. */
    public queryWater(
        point: [number, number],
        radiusM: number,
    ): Promise<{ water: boolean; nearestWater: [number, number] | null; hasTerrain: boolean }> {
        return this.masks.queryWater(point, radiusM);
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
        if (this.disposed || !this.terrain) {
            return null;
        }

        const clamped: [number, number, number, number] = [
            Math.max(0, Math.min(this.terrain.width, bbox[0])),
            Math.max(0, Math.min(this.terrain.height, bbox[1])),
            Math.max(0, Math.min(this.terrain.width, bbox[2])),
            Math.max(0, Math.min(this.terrain.height, bbox[3])),
        ];
        if (clamped[2] <= clamped[0] || clamped[3] <= clamped[1]) {
            return null;
        }

        const cell = this.masks.cellSizeFor(clamped);
        const isCancelled = (): boolean => this.disposed;
        const rasters = await this.masks.buildRasters(mode, clamped, cell, isCancelled);
        if (this.disposed) {
            return null;
        }

        const heightGrid = mode === 'foot' || mode === 'ground'
            ? await this.heights.sampleGrid(clamped, 96, isCancelled)
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

    /**
     * Debug/test only: finds a water-capable vehicle route.
     *
     * The route is `playerStart (road) -> roadStart (coast road) -> waterPoint
     * -> roadEnd`. The first leg follows the road because the player spawns on
     * a road point and `roadStart` is a different point near the coast. The
     * water point is about 250 m past the coast, so the vehicle enters water,
     * turns around and returns to a road.
     */
    public async findWaterRouteWaypoints(
        start: [number, number],
        waterDistanceM = 250,
    ): Promise<WaterRouteWaypoints | null> {
        if (!this.terrain || !this.masks.hasLayer('terrain') || !this.masks.hasLayer('roads')) {
            return null;
        }

        const margin = 5000;
        const bbox: BBox = [
            Math.max(0, start[0] - margin),
            Math.max(0, start[1] - margin),
            Math.min(this.terrain.width, start[0] + margin),
            Math.min(this.terrain.height, start[1] + margin),
        ];
        if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
            return null;
        }

        const cell = this.masks.cellSizeFor(bbox);
        const rasters = await this.masks.buildRasters(
            'ground',
            bbox,
            cell,
            () => this.disposed,
        );
        if (this.disposed || !rasters.terrain) {
            return null;
        }

        // Reuse the parsed road graph instead of re-parsing the SVG polylines.
        const network = this.getRoadNetwork();
        if (!network || network.nodeCount === 0) {
            return null;
        }
        const candidates: Array<{ point: [number, number]; fromStart: number }> = [];
        for (const point of network.nodePoints()) {
            if (point[0] < bbox[0] || point[1] < bbox[1] || point[0] > bbox[2] || point[1] > bbox[3]) {
                continue;
            }
            candidates.push({
                point,
                fromStart: distanceBetween(start[0], start[1], point[0], point[1]),
            });
        }
        candidates.sort((a, b) => a.fromStart - b.fromStart);

        const isLand = (x: number, y: number): boolean => this.masks.sample(rasters.terrain, x, y);
        const isWater = (x: number, y: number): boolean => !isLand(x, y);

        let playerStart: [number, number] | null = null;
        let coastRoad: [number, number] | null = null;
        let waterNear: [number, number] | null = null;
        let fallbackCoast: [number, number] | null = null;
        let fallbackWater: [number, number] | null = null;

        for (const candidate of candidates.slice(0, 2500)) {
            if (!isLand(candidate.point[0], candidate.point[1])) {
                continue;
            }
            if (!playerStart) {
                playerStart = candidate.point;
            }

            const water = this.findNearbyWater(rasters, candidate.point, 1200);
            if (!water) {
                continue;
            }

            // Prefer a coast point far enough from the spawn that the first
            // leg actually follows the road for a while.
            if (candidate.fromStart >= 300) {
                coastRoad = candidate.point;
                waterNear = water;
                break;
            }
            if (!fallbackCoast) {
                fallbackCoast = candidate.point;
                fallbackWater = water;
            }
        }

        if (!coastRoad && fallbackCoast && fallbackWater) {
            coastRoad = fallbackCoast;
            waterNear = fallbackWater;
        }

        if (!playerStart || !coastRoad || !waterNear) {
            return null;
        }

        const dx = waterNear[0] - coastRoad[0];
        const dy = waterNear[1] - coastRoad[1];
        const length = Math.hypot(dx, dy);
        let waterPoint: [number, number] = waterNear;
        if (length > 0.1) {
            const target: [number, number] = [
                waterNear[0] + (dx / length) * waterDistanceM,
                waterNear[1] + (dy / length) * waterDistanceM,
            ];
            waterPoint = isWater(target[0], target[1]) ? target : waterNear;
        }

        let roadEnd: [number, number] | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const candidate of candidates) {
            if (!isLand(candidate.point[0], candidate.point[1])) {
                continue;
            }
            const fromCoast = distanceBetween(
                candidate.point[0], candidate.point[1], coastRoad[0], coastRoad[1],
            );
            const fromWater = distanceBetween(
                candidate.point[0], candidate.point[1], waterPoint[0], waterPoint[1],
            );
            if (fromCoast < 250 || fromWater < 100 || fromWater > 2500) {
                continue;
            }
            if (fromWater < bestDistance) {
                bestDistance = fromWater;
                roadEnd = candidate.point;
            }
        }

        if (!roadEnd) {
            return null;
        }

        return {
            playerStart,
            roadStart: coastRoad,
            waterPoint,
            roadEnd,
        };
    }

    /** Nearest water sample within `maxDistanceM`, sampling rings at 50 m. */
    private findNearbyWater(
        rasters: RasterSet,
        point: [number, number],
        maxDistanceM: number,
    ): [number, number] | null {
        const terrain = rasters.terrain;
        if (!terrain) {
            return null;
        }

        const angles = 16;
        for (let radius = 50; radius <= maxDistanceM; radius += 50) {
            for (let index = 0; index < angles; index += 1) {
                const angle = (index / angles) * Math.PI * 2;
                const x = point[0] + Math.cos(angle) * radius;
                const y = point[1] + Math.sin(angle) * radius;
                if (!this.masks.sample(terrain, x, y)) {
                    return [x, y];
                }
            }
        }

        return null;
    }

    /**
     * Debug/test only: a nearby water-only destination for a boat already in
     * water. Uses the same raster/cell as the boat planner, so the point is
     * water for the route that follows.
     */
    public async findBoatTarget(start: [number, number]): Promise<[number, number] | null> {
        if (!this.terrain || !this.masks.hasLayer('terrain')) {
            return null;
        }

        const margin = 1500;
        const bbox: BBox = [
            Math.max(0, start[0] - margin),
            Math.max(0, start[1] - margin),
            Math.min(this.terrain.width, start[0] + margin),
            Math.min(this.terrain.height, start[1] + margin),
        ];
        if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
            return null;
        }

        const cell = this.masks.cellSizeFor(bbox);
        const rasters = await this.masks.buildRasters('boat', bbox, cell, () => this.disposed);
        if (this.disposed || !rasters.terrain) {
            return null;
        }

        const isWater = (x: number, y: number): boolean => !this.masks.sample(rasters.terrain, x, y);
        const angles = 36;

        for (let radius = 250; radius <= 1400; radius += 50) {
            for (let index = 0; index < angles; index += 1) {
                const angle = (index / angles) * Math.PI * 2;
                const x = start[0] + Math.cos(angle) * radius;
                const y = start[1] + Math.sin(angle) * radius;
                if (x < bbox[0] || y < bbox[1] || x > bbox[2] || y > bbox[3]) {
                    continue;
                }
                if (isWater(x, y)) {
                    return [x, y];
                }
            }
        }

        return null;
    }

    /** Calculates a route for the request. Never throws. */
    public async plan(request: RoutePlanRequest): Promise<RoutePlanResult> {
        try {
            return await this.planInternal(request);
        } catch (error) {
            console.error('GPS route planning failed', error);
            return { ok: false, reason: 'error' };
        }
    }

    private async planInternal(request: RoutePlanRequest): Promise<RoutePlanResult> {
        const isCancelled = (): boolean => this.disposed || request.cancelled?.() === true;

        const start = sanitizePoint(request.start);
        const waypoints = request.waypoints
            .map(sanitizePoint)
            .filter((point): point is [number, number] => point !== null);

        if (!start || waypoints.length === 0) {
            return { ok: false, reason: 'error' };
        }

        const mode = request.mode;
        const performance = request.performance;
        const waterCapable = request.waterCapable === true;

        if (mode === 'air') {
            return this.planDirect(start, waypoints, performance);
        }

        if (mode === 'boat' && !this.masks.hasLayer('terrain')) {
            return { ok: false, reason: 'no-terrain' };
        }

        const bbox = this.masks.planningBounds(start, waypoints);
        const cell = this.masks.cellSizeFor(bbox);

        const rasters = await this.masks.buildRasters(mode, bbox, cell, isCancelled);
        if (isCancelled()) {
            return { ok: false, reason: 'cancelled' };
        }

        if (mode === 'boat' && !rasters.terrain) {
            return { ok: false, reason: 'no-terrain' };
        }

        // Coarse slope grid for the search. 32x32 (<=1024 samples) keeps the
        // request bounded; the foot fine validation below uses 1 m samples only
        // after a path exists.
        const needsSlope = mode === 'foot' || mode === 'ground';
        // Debug builds can afford a finer height grid for the overlay (and the
        // slope preview); normal routing stays at the bounded 32x32 search grid.
        const heightSide = this.debug ? 96 : 32;
        const heightGrid = needsSlope
            ? await this.heights.sampleGrid(bbox, heightSide, isCancelled)
            : null;
        if (isCancelled()) {
            return { ok: false, reason: 'cancelled' };
        }
        const slopeAt = heightGrid
            ? (x: number, y: number): number | null => heightSlopeAt(heightGrid, x, y)
            : undefined;

        // Debug only: the grid is collected after the masks exist, before the
        // search, so a failed plan still shows what the planner had to work with.
        const debug = this.debug
            ? await buildDebugGrid(
                this.gridContext(mode, rasters, bbox, cell, performance, waterCapable, isCancelled, slopeAt),
                heightGrid,
            )
            : null;
        if (isCancelled()) {
            return { ok: false, reason: 'cancelled' };
        }

        if (mode === 'ground') {
            const roadLegs = this.planRoadRoute(
                start,
                waypoints,
                rasters,
                bbox,
                cell,
                performance,
                waterCapable,
                isCancelled,
                slopeAt,
            );
            if (roadLegs && roadLegs.length > 0) {
                return {
                    ok: true,
                    route: this.finishRoute(roadLegs, waypoints, 'planned'),
                    debug: debug ?? undefined,
                };
            }
        }

        let legs = this.planGridLegs(
            start,
            waypoints,
            mode,
            rasters,
            bbox,
            cell,
            performance,
            waterCapable,
            isCancelled,
            slopeAt,
        );
        if (!legs || legs.length === 0) {
            return { ok: false, reason: 'no-path', debug: debug ?? undefined };
        }

        // Foot paths are validated after they exist, with fine 1 m samples.
        // If a steep section is found, re-run the grid search with a penalty
        // around the problem points so the path works around it.
        if (mode === 'foot' && request.validate) {
            const problems = await this.validateFootPath(legs, isCancelled);
            if (isCancelled()) {
                return { ok: false, reason: 'cancelled' };
            }
            if (problems.length > 0) {
                const penaltyAt = this.makePenalty(problems);
                const adjusted = this.planGridLegs(
                    start,
                    waypoints,
                    mode,
                    rasters,
                    bbox,
                    cell,
                    performance,
                    waterCapable,
                    isCancelled,
                    slopeAt,
                    penaltyAt,
                );
                if (adjusted && adjusted.length > 0) {
                    legs = adjusted;
                }
            }
        }

        return {
            ok: true,
            route: this.finishRoute(legs, waypoints, 'planned'),
            debug: debug ?? undefined,
        };
    }

    /** One grid/boat leg per waypoint. */
    private planGridLegs(
        start: [number, number],
        waypoints: Array<[number, number]>,
        mode: TravelMode,
        rasters: RasterSet,
        bbox: BBox,
        cell: number,
        performance: VehiclePerformance | undefined,
        waterCapable: boolean,
        isCancelled: () => boolean,
        slopeAt?: (x: number, y: number) => number | null,
        penaltyAt?: (x: number, y: number) => number,
    ): RouteLeg[] | null {
        const legs: RouteLeg[] = [];
        let cursor: [number, number] = [start[0], start[1]];

        for (const waypoint of waypoints) {
            if (isCancelled()) {
                return null;
            }

            const planned = mode === 'boat'
                ? this.planBoatPair(cursor, waypoint, rasters, bbox, cell, performance, isCancelled)
                : this.planGroundPair(
                    cursor,
                    waypoint,
                    mode,
                    rasters,
                    bbox,
                    cell,
                    performance,
                    waterCapable,
                    isCancelled,
                    slopeAt,
                    penaltyAt,
                );

            if (!planned) {
                return null;
            }

            legs.push(...planned);
            cursor = waypoint;
        }

        return legs;
    }

    /**
     * Fine 1 m validation of a foot path.
     *
     * Samples are capped at 2000 points, so a very long route widens the
     * spacing instead of sending an unbounded request. A sample pair with a
     * grade above `MAX_GROUND_SLOPE` becomes a problem point for the reroute.
     */
    private async validateFootPath(
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
        const samples = await this.heights.samplePath(flat, spacing, isCancelled, false);
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
    private makePenalty(
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

    /** Aircraft: straight lines between the consecutive waypoints. */
    private planDirect(
        start: [number, number],
        waypoints: Array<[number, number]>,
        performance: VehiclePerformance | undefined,
    ): RoutePlanResult {
        const legs: RouteLeg[] = [];
        let cursor: [number, number] = [start[0], start[1]];

        for (const waypoint of waypoints) {
            const distance = distanceBetween(cursor[0], cursor[1], waypoint[0], waypoint[1]);
            const speed = legSpeed('air', 'air', performance, false);
            legs.push({
                mode: 'air',
                kind: 'air',
                points: [cursor[0], cursor[1], waypoint[0], waypoint[1]],
                distance,
                eta: speed > 0 ? distance / speed : 0,
                source: 'planned',
            });
            cursor = waypoint;
        }

        return { ok: true, route: this.finishRoute(legs, waypoints, 'planned') };
    }

    private finishRoute(
        legs: RouteLeg[],
        waypoints: Array<[number, number]>,
        source: 'planned',
    ): ActiveRoute {
        const distance = legs.reduce((total, leg) => total + leg.distance, 0);
        const eta = legs.reduce((total, leg) => total + leg.eta, 0);

        return {
            source,
            legs,
            waypoints: waypoints.map((point) => [point[0], point[1]] as [number, number]),
            distance,
            eta: Number.isFinite(eta) ? eta : null,
            createdAt: Date.now() / 1000,
        };
    }

    // ---------------------------------------------------------------------
    // Pair planning
    // ---------------------------------------------------------------------

    private getRoadNetwork(): RoadNetwork | null {
        if (this.roadNetwork) {
            return this.roadNetwork;
        }

        const layer = this.masks.findLayer('roads');
        if (!layer) {
            return null;
        }

        const polylines = parseRoadLayer(layer.svg);
        if (polylines.length === 0) {
            return null;
        }

        this.roadNetwork = new RoadNetwork(polylines);
        return this.roadNetwork;
    }

    private roadPathLegs(
        path: RoadPath,
        performance: VehiclePerformance | undefined,
        waterCapable: boolean,
        slopeAt?: (x: number, y: number) => number | null,
    ): RouteLeg[] {
        const legs: RouteLeg[] = [];
        let startIndex = 0;

        while (startIndex < path.kinds.length) {
            const kind = path.kinds[startIndex];
            let endIndex = startIndex;
            let distance = 0;
            let eta = 0;

            while (endIndex < path.kinds.length && path.kinds[endIndex] === kind) {
                const a = path.points[endIndex];
                const b = path.points[endIndex + 1];
                const segmentDistance = distanceBetween(a[0], a[1], b[0], b[1]);
                const slope = slopeAt?.((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) ?? null;
                const speed = Math.max(0.5, roadSpeed(kind, performance, waterCapable, slope));
                distance += segmentDistance;
                eta += segmentDistance / speed;
                endIndex += 1;
            }

            const points: number[] = [];
            for (let index = startIndex; index <= endIndex; index += 1) {
                points.push(path.points[index][0], path.points[index][1]);
            }
            if (points.length >= 4) {
                legs.push({
                    mode: 'ground',
                    kind: kind === 'main' || kind === 'road' ? 'road' : 'offroad',
                    points,
                    distance,
                    eta,
                    source: 'planned',
                });
            }

            startIndex = endIndex;
        }

        return legs;
    }

    private planRoadRoute(
        start: [number, number],
        waypoints: Array<[number, number]>,
        rasters: RasterSet,
        bbox: BBox,
        cell: number,
        performance: VehiclePerformance | undefined,
        waterCapable: boolean,
        isCancelled: () => boolean,
        slopeAt?: (x: number, y: number) => number | null,
    ): RouteLeg[] | null {
        const network = this.getRoadNetwork();
        if (!network || network.nodeCount === 0) {
            return null;
        }

        const legs: RouteLeg[] = [];
        let cursor: [number, number] = [start[0], start[1]];

        for (const waypoint of waypoints) {
            if (isCancelled()) {
                return null;
            }

            const startNode = network.nearestNode(cursor, 500);
            const goalNode = network.nearestNode(waypoint, 500);
            if (startNode === null || goalNode === null) {
                return null;
            }

            const path = network.findPath(
                cursor,
                waypoint,
                (kind, a, b) => roadSpeed(
                    kind,
                    performance,
                    waterCapable,
                    slopeAt?.((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) ?? null,
                ),
                isCancelled,
            );
            if (!path || path.points.length < 2) {
                return null;
            }

            const first = path.points[0];
            if (distanceBetween(cursor[0], cursor[1], first[0], first[1]) > 2) {
                const connector = this.planGroundPair(
                    cursor,
                    first,
                    'ground',
                    rasters,
                    bbox,
                    cell,
                    performance,
                    waterCapable,
                    isCancelled,
                    slopeAt,
                );
                if (!connector) {
                    return null;
                }
                legs.push(...connector);
            }

            legs.push(...this.roadPathLegs(path, performance, waterCapable, slopeAt));

            const last = path.points[path.points.length - 1];
            if (distanceBetween(last[0], last[1], waypoint[0], waypoint[1]) > 2) {
                const connector = this.planGroundPair(
                    last,
                    waypoint,
                    'ground',
                    rasters,
                    bbox,
                    cell,
                    performance,
                    waterCapable,
                    isCancelled,
                    slopeAt,
                );
                if (!connector) {
                    return null;
                }
                legs.push(...connector);
            }

            cursor = waypoint;
        }

        return legs;
    }

    private planGroundPair(
        start: [number, number],
        goal: [number, number],
        mode: TravelMode,
        rasters: RasterSet,
        bbox: BBox,
        cell: number,
        performance: VehiclePerformance | undefined,
        waterCapable: boolean,
        isCancelled: () => boolean,
        slopeAt?: (x: number, y: number) => number | null,
        penaltyAt?: (x: number, y: number) => number,
    ): RouteLeg[] | null {
        const context = this.gridContext(
            mode,
            rasters,
            bbox,
            cell,
            performance,
            waterCapable,
            isCancelled,
            slopeAt,
            penaltyAt,
        );
        const result = searchGrid(context, start, goal);
        if (!result) {
            return null;
        }

        const simplified = simplifyGridPath(context, result.path);
        return this.buildLegs(mode, simplified, rasters, performance, waterCapable, slopeAt, cell);
    }

    private planBoatPair(
        start: [number, number],
        goal: [number, number],
        rasters: RasterSet,
        bbox: BBox,
        cell: number,
        performance: VehiclePerformance | undefined,
        isCancelled: () => boolean,
    ): RouteLeg[] | null {
        const legs: RouteLeg[] = [];

        const waterStart = this.masks.isPassable('boat', start[0], start[1], rasters, false)
            ? start
            : this.masks.nearestPassable('boat', start, rasters, bbox, cell, false);
        const waterEnd = this.masks.isPassable('boat', goal[0], goal[1], rasters, false)
            ? goal
            : this.masks.nearestPassable('boat', goal, rasters, bbox, cell, false);

        if (!waterStart || !waterEnd) {
            return null;
        }

        // A boat destination far inland is not a boat route: a walk leg over a
        // mountain is worse than reporting that the destination is unreachable.
        if (distanceBetween(waterEnd[0], waterEnd[1], goal[0], goal[1]) > 300) {
            return null;
        }

        if (!samePoint(start, waterStart)) {
            legs.push(this.straightLeg('foot', 'walk', start, waterStart, performance));
        }

        const context = this.gridContext('boat', rasters, bbox, cell, performance, false, isCancelled);
        const result = searchGrid(context, waterStart, waterEnd);
        if (!result) {
            return null;
        }

        const simplified = simplifyGridPath(context, result.path);
        legs.push(...this.buildLegs('boat', simplified, rasters, performance, false, undefined, cell));

        if (!samePoint(waterEnd, goal)) {
            legs.push(this.straightLeg('foot', 'walk', waterEnd, goal, performance));
        }

        return legs;
    }

    private straightLeg(
        mode: TravelMode,
        kind: RouteLegKind,
        start: [number, number],
        end: [number, number],
        performance: VehiclePerformance | undefined,
    ): RouteLeg {
        const distance = distanceBetween(start[0], start[1], end[0], end[1]);
        const speed = legSpeed(mode, kind, performance, mode !== 'ground');
        return {
            mode,
            kind,
            points: [start[0], start[1], end[0], end[1]],
            distance,
            eta: speed > 0 ? distance / speed : 0,
            source: 'planned',
        };
    }

    /** Splits a simplified path into legs of one surface kind each. */
    private buildLegs(
        mode: TravelMode,
        path: number[],
        rasters: RasterSet,
        performance: VehiclePerformance | undefined,
        waterCapable: boolean,
        slopeAt?: (x: number, y: number) => number | null,
        cell = 10,
    ): RouteLeg[] {
        const legs: RouteLeg[] = [];
        let currentSurface: RouteSurface | null = null;
        let currentKind: RouteLegKind | null = null;
        let currentPoints: number[] = [];
        let currentDistance = 0;
        let currentEta = 0;

        const pushLeg = (): void => {
            if (currentKind && currentPoints.length >= 4) {
                legs.push({
                    mode,
                    kind: currentKind,
                    points: this.simplifyLegPoints(
                        mode,
                        currentSurface,
                        currentPoints,
                        rasters,
                        cell,
                    ),
                    distance: currentDistance,
                    eta: currentEta,
                    source: 'planned',
                });
            }
        };

        // A simplified path can have very long vertices. Classifying only the
        // segment midpoint mislabels a coastline or a short water crossing, so
        // sample the polyline and split whenever the surface changes.
        const step = Math.max(10, Math.min(25, cell));
        let lastX: number | null = null;
        let lastY = 0;

        for (let index = 0; index + 3 < path.length; index += 2) {
            const ax = path[index];
            const ay = path[index + 1];
            const bx = path[index + 2];
            const by = path[index + 3];
            const length = distanceBetween(ax, ay, bx, by);
            const steps = Math.max(1, Math.ceil(length / step));

            for (let sample = 0; sample <= steps; sample += 1) {
                const t = sample / steps;
                const x = sample === steps ? bx : ax + (bx - ax) * t;
                const y = sample === steps ? by : ay + (by - ay) * t;
                let surface = this.masks.surfaceAt(x, y, rasters);
                if (mode === 'ground' && !waterCapable && surface === 'water') {
                    // A non-amphibious A* path cannot cross water; a coastline
                    // sample between two passable grid cells is land for display.
                    surface = 'offroad';
                }
                const kind = this.legKindFor(mode, surface);

                if (currentSurface === null || lastX === null) {
                    currentSurface = surface;
                    currentKind = kind;
                    currentPoints = [x, y];
                    lastX = x;
                    lastY = y;
                    continue;
                }

                const midX = (lastX + x) / 2;
                const midY = (lastY + y) / 2;
                let speed = edgeSpeed(
                    mode,
                    surface,
                    performance,
                    waterCapable,
                    slopeAt?.(midX, midY) ?? null,
                );
                if (this.masks.sample(rasters.fences, midX, midY)) {
                    speed *= mode === 'foot' ? 0.7 : 0.6;
                }
                if (!(speed > 0)) {
                    speed = 0.5;
                }

                const distance = distanceBetween(lastX, lastY, x, y);
                const eta = distance / speed;

                if (surface !== currentSurface || kind !== currentKind) {
                    // End the previous leg at the last point, then start the
                    // new surface at that same point and include this segment
                    // in the new leg (not the old one).
                    pushLeg();

                    currentSurface = surface;
                    currentKind = kind;
                    currentPoints = [lastX, lastY, x, y];
                    currentDistance = distance;
                    currentEta = eta;
                } else {
                    currentPoints.push(x, y);
                    currentDistance += distance;
                    currentEta += eta;
                }

                lastX = x;
                lastY = y;
            }
        }

        pushLeg();
        return this.mergeTinyLegs(legs);
    }

    /**
     * Simplifies one leg without ever cutting across a different surface.
     *
     * Plain Douglas–Peucker only knows geometry: a straight shortcut can leave
     * a walk leg and cross water. This greedy pass keeps a vertex pair only
     * when every sampled point on the segment has the leg's expected surface.
     */
    private simplifyLegPoints(
        mode: TravelMode,
        surface: RouteSurface | null,
        points: number[],
        rasters: RasterSet,
        cell: number,
    ): number[] {
        const count = Math.floor(points.length / 2);
        if (count <= 2 || mode === 'air' || surface === null) {
            return points.slice();
        }

        const result: number[] = [points[0], points[1]];
        let anchor = 0;

        while (anchor < count - 1) {
            let chosen = anchor + 1;

            for (let candidate = count - 1; candidate > anchor; candidate -= 1) {
                const ax = points[anchor * 2];
                const ay = points[anchor * 2 + 1];
                const bx = points[candidate * 2];
                const by = points[candidate * 2 + 1];
                const distance = distanceBetween(ax, ay, bx, by);
                const steps = Math.max(1, Math.ceil(distance / Math.max(10, cell)));
                let consistent = true;

                for (let step = 0; step <= steps; step += 1) {
                    const t = step / steps;
                    const x = ax + (bx - ax) * t;
                    const y = ay + (by - ay) * t;
                    const sampled = this.masks.surfaceAt(x, y, rasters);
                    if (sampled !== surface) {
                        consistent = false;
                        break;
                    }
                }

                if (consistent) {
                    chosen = candidate;
                    break;
                }
            }

            result.push(points[chosen * 2], points[chosen * 2 + 1]);
            anchor = chosen;
        }

        return result;
    }

    /**
     * Folds sub-5 m same-surface fragments into a neighbour. They are usually a
     * coastline raster artefact and otherwise produce a strobe of one-point
     * legs in the route line and ETA list.
     */
    private mergeTinyLegs(legs: RouteLeg[]): RouteLeg[] {
        const minDistance = 5;
        let changed = true;

        while (changed) {
            changed = false;

            if (legs.length < 2) {
                break;
            }

            for (let index = 0; index < legs.length; index += 1) {
                const leg = legs[index];
                if (!(leg.distance < minDistance)) {
                    continue;
                }

                const targetIndex = index > 0 ? index - 1 : index + 1;
                const target = legs[targetIndex];
                if (!target || target.mode !== leg.mode || target.kind !== leg.kind) {
                    continue;
                }

                const speed = target.distance > 0 && target.eta > 0
                    ? target.distance / target.eta
                    : 0;
                const distance = target.distance + leg.distance;
                const eta = speed > 0 ? distance / speed : target.eta + leg.eta;
                const points = targetIndex < index
                    ? [...target.points, ...leg.points.slice(2)]
                    : [...leg.points.slice(0, -2), ...target.points];

                target.points = points;
                target.distance = distance;
                target.eta = eta;
                legs.splice(index, 1);
                changed = true;
                break;
            }
        }

        return legs;
    }

    private legKindFor(mode: TravelMode, surface: RouteSurface): RouteLegKind {
        if (mode === 'air') {
            return 'air';
        }
        if (mode === 'boat') {
            return 'water';
        }
        if (surface === 'water') {
            return 'water';
        }
        if (mode === 'ground' && surface === 'road') {
            return 'road';
        }
        return mode === 'ground' ? 'offroad' : 'walk';
    }

    private gridContext(
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
        return {
            mode,
            masks: this.masks,
            rasters,
            bbox,
            cell,
            waterCapable,
            performance,
            isCancelled,
            slopeAt,
            penaltyAt,
        };
    }
}

function sanitizePoint(value: unknown): [number, number] | null {
    if (!Array.isArray(value) || value.length < 2) {
        return null;
    }
    const x = value[0];
    const y = value[1];
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
        return null;
    }
    return [x, y];
}

function samePoint(a: [number, number], b: [number, number]): boolean {
    return Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
}
