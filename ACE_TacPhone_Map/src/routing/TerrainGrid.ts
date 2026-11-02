/**
 * 8-neighbor A* over the rasterized terrain masks.
 *
 * The grid is used directly for foot and boat routes, for off-road ground
 * connectors and as the fallback when the road graph has no usable node.
 * Edge cost is travel time from `SpeedModel`, and the line-of-sight
 * simplification compares the direct cost with the original path cost so a
 * road detour is never flattened back through forest.
 */

import { getTerrainHeights } from '../MapMarkers/TerrainHeightApi';
import type { BBox, RasterSet, TerrainMasks } from '../terrain/TerrainMasks';
import type { HeightGrid } from './TerrainHeights';
import { ROUTE_DEBUG_FOREST, ROUTE_DEBUG_OFFROAD, ROUTE_DEBUG_ROAD, ROUTE_DEBUG_WATER } from './RouteTypes';
import type {
    RouteDebugGrid,
    RouteDebugHeights,
    RoutePlanRequest,
    TravelMode,
    VehiclePerformance,
} from './RouteTypes';
import { edgeSpeed, legSpeed, type RouteSurface } from './SpeedModel';
import { MinHeap } from './AStar';

/** Distance helper kept local so the grid has no route/geometry dependency. */
function distanceBetween(ax: number, ay: number, bx: number, by: number): number {
    return Math.hypot(bx - ax, by - ay);
}

export interface GridContext {
    mode: TravelMode;
    masks: TerrainMasks;
    rasters: RasterSet;
    bbox: BBox;
    cell: number;
    waterCapable: boolean;
    performance: VehiclePerformance | undefined;
    isCancelled: () => boolean;
    /** Optional slope (rise/run) at a world point; null/undefined = unknown. */
    slopeAt?: (x: number, y: number) => number | null;
    /**
     * Optional search penalty multiplier near a failed fine-validation point.
     * 1 is normal; values below 1 make the edge slower. Never applied to the
     * displayed leg ETA.
     */
    penaltyAt?: (x: number, y: number) => number;
    /**
     * Treat water as impassable even for foot. Used by the fine water-corridor
     * pass to force a land-only search; the normal plan still allows swimming.
     */
    avoidWater?: boolean;
    /**
     * Keep the land-only search this many metres away from water. 0/undefined
     * allows a path directly on the coastline.
     */
    waterBufferM?: number;
}

/** Cardinal and diagonal offsets used for the water-edge buffer. */
const WATER_BUFFER_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** True when the point is land and far enough from water for this context. */
function isDryAt(context: GridContext, x: number, y: number): boolean {
    const { masks, rasters } = context;
    if (masks.landAt(x, y, rasters) === false) {
        return false;
    }

    const buffer = context.waterBufferM ?? 0;
    if (!(buffer > 0)) {
        return true;
    }

    for (const [dx, dy] of WATER_BUFFER_DIRECTIONS) {
        if (masks.landAt(x + dx * buffer, y + dy * buffer, rasters) === false) {
            return false;
        }
    }
    return true;
}

/** Passability with the optional land-only rule applied. */
function isPassableAt(context: GridContext, x: number, y: number): boolean {
    const { mode, masks, rasters, waterCapable, avoidWater } = context;
    if (avoidWater && !isDryAt(context, x, y)) {
        return false;
    }
    return masks.isPassable(mode, x, y, rasters, waterCapable);
}

/** Nearest reachable grid cell for a world point, or null. */
function nearestCell(context: GridContext, point: [number, number], columns: number, rows: number): number | null {
    const { bbox, cell } = context;
    const toCell = (x: number, y: number): number | null => {
        const column = Math.floor((x - bbox[0]) / cell);
        const row = Math.floor((y - bbox[1]) / cell);
        if (column < 0 || row < 0 || column >= columns || row >= rows) {
            return null;
        }
        return row * columns + column;
    };

    const centerOf = (index: number): [number, number] => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        return [bbox[0] + (column + 0.5) * cell, bbox[1] + (row + 0.5) * cell];
    };

    const direct = toCell(point[0], point[1]);
    if (direct !== null) {
        const center = centerOf(direct);
        if (isPassableAt(context, center[0], center[1])) {
            return direct;
        }
    }

    // A land-only search must not start on a water cell whose centre happens
    // to lie just offshore; walk outward to the nearest dry cell instead.
    if (context.avoidWater) {
        const startColumn = Math.max(0, Math.min(columns - 1, Math.floor((point[0] - bbox[0]) / cell)));
        const startRow = Math.max(0, Math.min(rows - 1, Math.floor((point[1] - bbox[1]) / cell)));
        const maxRadius = Math.min(60, Math.max(columns, rows));

        for (let radius = 1; radius <= maxRadius; radius += 1) {
            for (let row = startRow - radius; row <= startRow + radius; row += 1) {
                for (let column = startColumn - radius; column <= startColumn + radius; column += 1) {
                    if (Math.max(Math.abs(row - startRow), Math.abs(column - startColumn)) !== radius) {
                        continue;
                    }
                    if (row < 0 || column < 0 || row >= rows || column >= columns) {
                        continue;
                    }
                    const center = centerOf(row * columns + column);
                    if (isPassableAt(context, center[0], center[1])) {
                        return row * columns + column;
                    }
                }
            }
        }

        return null;
    }

    const nearest = context.masks.nearestPassable(
        context.mode,
        point,
        context.rasters,
        bbox,
        cell,
        context.waterCapable,
    );
    return nearest ? toCell(nearest[0], nearest[1]) : null;
}

export interface GridSearchResult {
    /** Flat world coordinates including the exact start and goal. */
    path: number[];
    /** Number of expanded cells (debug/telemetry). */
    expanded: number;
}

/** Finds a grid path between two world points, or null. */
export function searchGrid(context: GridContext, start: [number, number], goal: [number, number]): GridSearchResult | null {
    const { bbox, cell, mode, masks, rasters, performance, waterCapable, isCancelled } = context;
    const columns = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / cell));
    const rows = Math.max(1, Math.ceil((bbox[3] - bbox[1]) / cell));
    const total = columns * rows;

    const cellCenter = (index: number): [number, number] => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        return [bbox[0] + (column + 0.5) * cell, bbox[1] + (row + 0.5) * cell];
    };

    const startCell = nearestCell(context, start, columns, rows);
    const goalCell = nearestCell(context, goal, columns, rows);
    if (startCell === null || goalCell === null) {
        return null;
    }

    const heuristicSpeed = Math.max(
        0.5,
        legSpeed(
            mode,
            mode === 'ground' ? 'road' : mode === 'foot' ? 'walk' : mode === 'boat' ? 'water' : 'air',
            performance,
            waterCapable,
        ),
    );

    const gScore = new Float64Array(total);
    gScore.fill(Number.POSITIVE_INFINITY);
    const cameFrom = new Int32Array(total);
    cameFrom.fill(-1);
    const closed = new Uint8Array(total);

    const heuristic = (index: number): number => {
        const center = cellCenter(index);
        return distanceBetween(center[0], center[1], goal[0], goal[1]) / heuristicSpeed;
    };

    const open = new MinHeap<number>();
    gScore[startCell] = 0;
    open.push(startCell, heuristic(startCell));

    const neighbors = [
        [-1, 0], [1, 0], [0, -1], [0, 1],
        [-1, -1], [1, -1], [-1, 1], [1, 1],
    ] as const;

    let expanded = 0;

    while (open.size > 0) {
        const current = open.pop();
        if (current === undefined) {
            break;
        }
        if (closed[current] === 1) {
            continue;
        }
        if (current === goalCell) {
            break;
        }

        closed[current] = 1;
        expanded += 1;
        if (expanded % 1024 === 0 && isCancelled()) {
            return null;
        }

        const column = current % columns;
        const row = Math.floor(current / columns);
        const center = cellCenter(current);

        for (const [dx, dy] of neighbors) {
            const nextColumn = column + dx;
            const nextRow = row + dy;
            if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) {
                continue;
            }

            const next = nextRow * columns + nextColumn;
            if (closed[next] === 1) {
                continue;
            }

            const nextCenter = cellCenter(next);
            const diagonal = dx !== 0 && dy !== 0;

            if (diagonal) {
                // Do not cut through blocked corners.
                const sideA = row * columns + nextColumn;
                const sideB = nextRow * columns + column;
                const a = cellCenter(sideA);
                const b = cellCenter(sideB);
                if (
                    !isPassableAt(context, a[0], a[1])
                    || !isPassableAt(context, b[0], b[1])
                ) {
                    continue;
                }
            }

            if (!isPassableAt(context, nextCenter[0], nextCenter[1])) {
                continue;
            }

            const midX = (center[0] + nextCenter[0]) / 2;
            const midY = (center[1] + nextCenter[1]) / 2;
            const surface = masks.surfaceAt(midX, midY, rasters);
            const slope = context.slopeAt?.(midX, midY) ?? null;
            let speed = edgeSpeed(mode, surface, performance, waterCapable, slope);
            if (masks.sample(rasters.fences, midX, midY)) {
                speed *= mode === 'foot' ? 0.7 : 0.6;
            }
            speed *= context.penaltyAt?.(midX, midY) ?? 1;
            if (!(speed > 0)) {
                continue;
            }

            const stepDistance = diagonal ? cell * Math.SQRT2 : cell;
            const tentative = gScore[current] + stepDistance / speed;

            if (tentative < gScore[next]) {
                gScore[next] = tentative;
                cameFrom[next] = current;
                open.push(next, tentative + heuristic(next));
            }
        }
    }

    if (startCell !== goalCell && cameFrom[goalCell] === -1) {
        return null;
    }

    const cells: number[] = [];
    let cursor = goalCell;
    while (cursor !== -1) {
        cells.push(cursor);
        if (cursor === startCell) {
            break;
        }
        cursor = cameFrom[cursor];
    }
    cells.reverse();

    const path: number[] = [start[0], start[1]];
    for (const index of cells) {
        const center = cellCenter(index);
        path.push(center[0], center[1]);
    }
    path.push(goal[0], goal[1]);
    return { path, expanded };
}

/** Greedy line-of-sight simplification against the passability masks. */
export function simplifyGridPath(context: GridContext, path: number[]): number[] {
    const count = Math.floor(path.length / 2);
    if (count <= 2) {
        return path.slice();
    }

    const result: number[] = [path[0], path[1]];
    let anchor = 0;

    while (anchor < count - 1) {
        let chosen = anchor + 1;

        for (let candidate = count - 1; candidate > anchor; candidate -= 1) {
            if (!segmentClear(
                context,
                path[anchor * 2],
                path[anchor * 2 + 1],
                path[candidate * 2],
                path[candidate * 2 + 1],
            )) {
                continue;
            }

            // Do not flatten a road detour back into a straight line through
            // forest/off-road just because it is passable.
            const directCost = segmentCost(context, path[anchor * 2], path[anchor * 2 + 1], path[candidate * 2], path[candidate * 2 + 1]);
            let originalCost = 0;
            for (let index = anchor; index < candidate; index += 1) {
                originalCost += segmentCost(
                    context,
                    path[index * 2],
                    path[index * 2 + 1],
                    path[(index + 1) * 2],
                    path[(index + 1) * 2 + 1],
                );
            }

            if (directCost <= originalCost * 1.05 + 1e-6) {
                chosen = candidate;
                break;
            }
        }

        result.push(path[chosen * 2], path[chosen * 2 + 1]);
        anchor = chosen;
    }

    return result;
}

/** Travel-time cost of a straight segment, using the same masks/speeds as A*. */
export function segmentCost(context: GridContext, ax: number, ay: number, bx: number, by: number): number {
    const { mode, masks, rasters, performance, waterCapable, cell } = context;
    const distance = distanceBetween(ax, ay, bx, by);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, cell * 0.5)));
    const stepDistance = distance / steps;
    let cost = 0;

    for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const surface = masks.surfaceAt(x, y, rasters);
        if (context.avoidWater && !isDryAt(context, x, y)) {
            return Number.POSITIVE_INFINITY;
        }
        const slope = context.slopeAt?.(x, y) ?? null;
        let speed = edgeSpeed(mode, surface, performance, waterCapable, slope);
        if (masks.sample(rasters.fences, x, y)) {
            speed *= mode === 'foot' ? 0.7 : 0.6;
        }
        speed *= context.penaltyAt?.(x, y) ?? 1;
        if (!(speed > 0)) {
            return Number.POSITIVE_INFINITY;
        }
        cost += stepDistance / speed;
    }

    return cost;
}

function segmentClear(
    context: GridContext,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): boolean {
    const { bbox, cell } = context;
    const distance = distanceBetween(ax, ay, bx, by);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, cell * 0.5)));

    for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        if (x < bbox[0] || y < bbox[1] || x > bbox[2] || y > bbox[3]) {
            continue;
        }
        if (!isPassableAt(context, x, y)) {
            return false;
        }
    }

    return true;
}

// ---------------------------------------------------------------------------
// Debug planning grid (never used by routing)
// ---------------------------------------------------------------------------

/** Debug overlay height sampling: a fixed 20x20 = 400-sample game request. */
const DEBUG_HEIGHT_SIDE = 20;
/** Extra cost multiplier at a 100% slope (1 m per 1 m). */
const SLOPE_COST_WEIGHT = 6;

/** Surface class to the code exported in {@link RouteDebugGrid.surface}. */
const SURFACE_CODES: Record<RouteSurface, number> = {
    water: ROUTE_DEBUG_WATER,
    road: ROUTE_DEBUG_ROAD,
    forest: ROUTE_DEBUG_FOREST,
    offroad: ROUTE_DEBUG_OFFROAD,
};

/**
 * Samples the same masks the search uses into one grid.
 *
 * The cost is the plain surface travel time per metre (`1 / speed`) and is
 * deliberately independent of the A* heuristic; the slope multiplier is kept
 * separate so the debug overlay can include or ignore it. Water and object
 * cells record `passable = 0` for the selected mode.
 */
export async function buildDebugGrid(
    context: GridContext,
    suppliedHeights: HeightGrid | null = null,
): Promise<RouteDebugGrid | null> {
    const { mode, masks, rasters, bbox, cell, waterCapable, performance, isCancelled } = context;
    const width = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / cell));
    const height = Math.max(1, Math.ceil((bbox[3] - bbox[1]) / cell));
    const count = width * height;

    const heights = suppliedHeights ?? await debugHeights(bbox, isCancelled);
    if (isCancelled()) {
        return null;
    }

    const slopeGrid = heights ? buildSlopeGrid(heights) : null;
    const surface = new Uint8Array(count);
    const cost = new Float32Array(count);
    const slope = new Float32Array(count);
    const passable = new Uint8Array(count);

    for (let row = 0; row < height; row += 1) {
        if (row % 64 === 0 && isCancelled()) {
            return null;
        }

        for (let column = 0; column < width; column += 1) {
            const index = row * width + column;
            const x = bbox[0] + (column + 0.5) * cell;
            const y = bbox[1] + (row + 0.5) * cell;
            const kind = masks.surfaceAt(x, y, rasters);
            const localSlope = slopeGrid && heights
                ? sampleBilinear(slopeGrid, heights, x, y)
                : null;

            surface[index] = SURFACE_CODES[kind];
            passable[index] = masks.isPassable(mode, x, y, rasters, waterCapable) ? 1 : 0;
            slope[index] = localSlope === null
                ? 1
                : 1 + SLOPE_COST_WEIGHT * Math.min(1, localSlope);

            let speed = edgeSpeed(mode, kind, performance, waterCapable, localSlope);
            if (masks.sample(rasters.fences, x, y)) {
                speed *= mode === 'foot' ? 0.7 : 0.6;
            }
            cost[index] = speed > 0 && Number.isFinite(speed) ? 1 / speed : 0;
        }
    }

    return {
        bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        cell,
        width,
        height,
        surface,
        cost,
        slope,
        passable,
        hasSlope: heights !== null,
        heights,
    };
}

/**
 * Bounded, best-effort height sampling for the debug overlays.
 *
 * One `getTerrainHeight` request with at most {@link DEBUG_HEIGHT_SIDE}² =
 * 400 positions over the planning bbox. Failures and cancellations only mean
 * "no slope data"; they never affect the route.
 */
async function debugHeights(
    bbox: BBox,
    isCancelled: () => boolean,
): Promise<RouteDebugHeights | null> {
    const boxWidth = bbox[2] - bbox[0];
    const boxHeight = bbox[3] - bbox[1];
    if (!(boxWidth > 0) || !(boxHeight > 0)) {
        return null;
    }

    const columns = DEBUG_HEIGHT_SIDE;
    const rows = DEBUG_HEIGHT_SIDE;
    const stepX = boxWidth / columns;
    const stepY = boxHeight / rows;

    const positions: Array<[number, number]> = [];
    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
            positions.push([
                bbox[0] + (column + 0.5) * stepX,
                bbox[1] + (row + 0.5) * stepY,
            ]);
        }
    }

    let heights: number[] = [];
    try {
        heights = await getTerrainHeights(positions);
    } catch (error) {
        console.warn('GPS: debug terrain heights unavailable', error);
        return null;
    }

    if (isCancelled()) {
        return null;
    }

    const samples = new Float32Array(columns * rows);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < samples.length; index += 1) {
        const value = heights[index];
        if (typeof value === 'number' && Number.isFinite(value)) {
            samples[index] = value;
            min = Math.min(min, value);
            max = Math.max(max, value);
        } else {
            samples[index] = Number.NaN;
        }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return null;
    }

    return {
        bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        width: columns,
        height: rows,
        values: samples,
        min,
        max,
    };
}

/** Slope magnitude (metres per metre) per height sample, 0 when unknown. */
function buildSlopeGrid(heights: RouteDebugHeights): Float32Array {
    const { width, height, values } = heights;
    const stepX = (heights.bbox[2] - heights.bbox[0]) / Math.max(1, width);
    const stepY = (heights.bbox[3] - heights.bbox[1]) / Math.max(1, height);
    const grid = new Float32Array(width * height);

    for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
            const left = values[row * width + Math.max(0, column - 1)];
            const right = values[row * width + Math.min(width - 1, column + 1)];
            const top = values[Math.max(0, row - 1) * width + column];
            const bottom = values[Math.min(height - 1, row + 1) * width + column];

            if (!Number.isFinite(left) || !Number.isFinite(right)
                || !Number.isFinite(top) || !Number.isFinite(bottom)) {
                continue;
            }

            const dx = stepX > 0 ? (right - left) / (2 * stepX) : 0;
            const dy = stepY > 0 ? (bottom - top) / (2 * stepY) : 0;
            grid[row * width + column] = Math.hypot(dx, dy);
        }
    }

    return grid;
}

/** Bilinear lookup in a coarse grid described by its height samples. */
function sampleBilinear(
    grid: Float32Array,
    shape: RouteDebugHeights,
    x: number,
    y: number,
): number {
    const { width, height, bbox } = shape;
    if (width < 1 || height < 1) {
        return 0;
    }

    const stepX = (bbox[2] - bbox[0]) / width;
    const stepY = (bbox[3] - bbox[1]) / height;
    if (!(stepX > 0) || !(stepY > 0)) {
        return 0;
    }

    const localX = Math.max(0, Math.min(width - 1, (x - bbox[0]) / stepX - 0.5));
    const localY = Math.max(0, Math.min(height - 1, (y - bbox[1]) / stepY - 0.5));
    const column = Math.min(width - 1, Math.floor(localX));
    const row = Math.min(height - 1, Math.floor(localY));
    const nextColumn = Math.min(width - 1, column + 1);
    const nextRow = Math.min(height - 1, row + 1);
    const fx = localX - column;
    const fy = localY - row;

    const a = grid[row * width + column];
    const b = grid[row * width + nextColumn];
    const c = grid[nextRow * width + column];
    const d = grid[nextRow * width + nextColumn];

    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Debug only: a request-shaped helper for callers that already have one. */
export function debugGridFor(request: RoutePlanRequest, context: GridContext): Promise<RouteDebugGrid | null> {
    void request;
    return buildDebugGrid(context);
}
