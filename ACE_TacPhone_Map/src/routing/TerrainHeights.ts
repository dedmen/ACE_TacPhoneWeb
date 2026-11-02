/**
 * Bounded terrain-height sampling with a long-lived peak/ring cache.
 *
 * Normal route planning samples on a 10 m grid (or the A* slope grid cell,
 * whichever is coarser). Once a path exists, foot routes can be validated at
 * 1 m spacing; those fine samples are intentionally not kept, so they do not
 * evict the useful coarse data.
 *
 * Peaks are special: a local maximum plus a ring of neighbours is kept outside
 * the LRU. That ring is what lets a later route estimate the slope around the
 * same mountain without requesting those heights again.
 */

import { getTerrainHeights } from '../MapMarkers/TerrainHeightApi';

export interface HeightGrid {
    bbox: [number, number, number, number];
    /** Metres per cell. */
    cell: number;
    width: number;
    height: number;
    /** Row-major heights; `NaN` when the sample failed. */
    values: Float32Array;
    min: number;
    max: number;
}

export interface HeightSample {
    x: number;
    y: number;
    along: number;
    height: number;
}

export interface TerrainHeightsOptions {
    /** Ordinary sample cache size. */
    lruMax?: number;
    /** Number of long-lived peaks. */
    peakMax?: number;
    /** Positions per game request. */
    chunkSize?: number;
    /** Minimum grid spacing for normal route samples. */
    normalGridM?: number;
    /** Peak prominence in metres. */
    peakProminenceM?: number;
}

const DEFAULTS: Required<TerrainHeightsOptions> = {
    lruMax: 6000,
    peakMax: 512,
    chunkSize: 400,
    normalGridM: 10,
    peakProminenceM: 8,
};

interface PeakEntry {
    x: number;
    y: number;
    height: number;
    ring: Array<{ x: number; y: number; height: number }>;
    ringKeys: string[];
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function distance(ax: number, ay: number, bx: number, by: number): number {
    return Math.hypot(bx - ax, by - ay);
}

function cellKey(x: number, y: number, gridM: number): string {
    return `${Math.round(x / gridM)},${Math.round(y / gridM)}`;
}

/** Bilinear height at a world point, or null when a corner is unknown. */
export function heightAt(grid: HeightGrid, x: number, y: number): number | null {
    if (grid.width < 1 || grid.height < 1) {
        return null;
    }

    const localX = Math.max(0, Math.min(grid.width - 1, (x - grid.bbox[0]) / grid.cell - 0.5));
    const localY = Math.max(0, Math.min(grid.height - 1, (y - grid.bbox[1]) / grid.cell - 0.5));
    const column = Math.min(grid.width - 1, Math.floor(localX));
    const row = Math.min(grid.height - 1, Math.floor(localY));
    const nextColumn = Math.min(grid.width - 1, column + 1);
    const nextRow = Math.min(grid.height - 1, row + 1);
    const fx = localX - column;
    const fy = localY - row;

    const a = grid.values[row * grid.width + column];
    const b = grid.values[row * grid.width + nextColumn];
    const c = grid.values[nextRow * grid.width + column];
    const d = grid.values[nextRow * grid.width + nextColumn];

    if (![a, b, c, d].every(Number.isFinite)) {
        return null;
    }

    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Local gradient magnitude at a world point, rise over run. */
export function slopeAt(grid: HeightGrid, x: number, y: number): number | null {
    const here = heightAt(grid, x, y);
    const east = heightAt(grid, x + grid.cell, y);
    const north = heightAt(grid, x, y + grid.cell);
    if (here === null || east === null || north === null) {
        return null;
    }
    return Math.hypot((east - here) / grid.cell, (north - here) / grid.cell);
}

export class TerrainHeights {
    private readonly options: Required<TerrainHeightsOptions>;
    private readonly lru = new Map<string, number>();
    private readonly peaks = new Map<string, PeakEntry>();
    /** Ring samples are also long-lived, keyed by 10 m grid. */
    private readonly peakSamples = new Map<string, number>();
    private coarseRequests = 0;
    private fineRequests = 0;

    constructor(options: TerrainHeightsOptions = {}) {
        this.options = { ...DEFAULTS, ...options };
    }

    public clear(): void {
        this.lru.clear();
        this.peaks.clear();
        this.peakSamples.clear();
    }

    /** Number of ordinary/peak entries, for debug and tests. */
    public get stats(): {
        lru: number;
        peaks: number;
        ring: number;
        coarseRequests: number;
        fineRequests: number;
    } {
        return {
            lru: this.lru.size,
            peaks: this.peaks.size,
            ring: this.peakSamples.size,
            coarseRequests: this.coarseRequests,
            fineRequests: this.fineRequests,
        };
    }

    /** Cached height at a world point, checking the LRU, peaks and ring. */
    public get(x: number, y: number, gridM = this.options.normalGridM): number | undefined {
        const key = cellKey(x, y, gridM);
        const cached = this.lru.get(key);
        if (cached !== undefined) {
            // Refresh LRU order.
            this.lru.delete(key);
            this.lru.set(key, cached);
            return cached;
        }

        if (gridM === this.options.normalGridM) {
            return this.peakSamples.get(key);
        }
        return undefined;
    }

    public set(x: number, y: number, height: number, gridM = this.options.normalGridM): void {
        if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(height)) {
            return;
        }

        const key = cellKey(x, y, gridM);
        this.lru.delete(key);
        this.lru.set(key, height);

        while (this.lru.size > this.options.lruMax) {
            const oldest = this.lru.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.lru.delete(oldest);
        }
    }

    /**
     * Samples positions in bounded chunks.
     *
     * `cache` is false for fine (1 m) validation samples so they do not evict
     * the coarse planning cache. Failures leave `null` for that position.
     */
    public async sample(
        positions: ReadonlyArray<readonly [number, number]>,
        gridM: number,
        cancelled: () => boolean,
        cache = gridM >= this.options.normalGridM,
    ): Promise<Array<number | null>> {
        const results: Array<number | null> = positions.map(() => null);
        const missing: Array<[number, number]> = [];
        const missingIndices: number[] = [];

        for (let index = 0; index < positions.length; index += 1) {
            const position = positions[index];
            if (!isFiniteNumber(position[0]) || !isFiniteNumber(position[1])) {
                continue;
            }

            const cached = cache ? this.get(position[0], position[1], gridM) : undefined;
            if (cached !== undefined) {
                results[index] = cached;
            } else {
                missing.push([position[0], position[1]]);
                missingIndices.push(index);
            }
        }

        for (let offset = 0; offset < missing.length; offset += this.options.chunkSize) {
            if (cancelled()) {
                return results;
            }

            const chunk = missing.slice(offset, offset + this.options.chunkSize);
            if (cache) {
                this.coarseRequests += 1;
            } else {
                this.fineRequests += 1;
            }
            try {
                const heights = await getTerrainHeights(chunk);
                for (let index = 0; index < heights.length; index += 1) {
                    const height = heights[index];
                    if (!isFiniteNumber(height)) {
                        continue;
                    }
                    results[missingIndices[offset + index]] = height;
                    if (cache) {
                        this.set(chunk[index][0], chunk[index][1], height, gridM);
                    }
                }
            } catch (error) {
                console.warn('GPS: terrain height chunk failed', error);
            }
        }

        return results;
    }

    /**
     * Builds a coarse height grid over a bbox.
     *
     * `maxDimension` bounds the request size (e.g. 64 -> at most 4096 samples).
     * The cell is at least `normalGridM`, so the normal sample spacing is never
     * violated.
     */
    public async sampleGrid(
        bbox: [number, number, number, number],
        maxDimension: number,
        cancelled: () => boolean,
    ): Promise<HeightGrid | null> {
        const widthWorld = bbox[2] - bbox[0];
        const heightWorld = bbox[3] - bbox[1];
        if (!(widthWorld > 0) || !(heightWorld > 0)) {
            return null;
        }

        const cell = Math.max(
            this.options.normalGridM,
            Math.hypot(widthWorld, heightWorld) / Math.max(1, maxDimension),
        );
        const width = Math.max(1, Math.ceil(widthWorld / cell));
        const height = Math.max(1, Math.ceil(heightWorld / cell));

        const positions: Array<[number, number]> = [];
        for (let row = 0; row < height; row += 1) {
            for (let column = 0; column < width; column += 1) {
                positions.push([
                    bbox[0] + (column + 0.5) * cell,
                    bbox[1] + (row + 0.5) * cell,
                ]);
            }
        }

        const heights = await this.sample(positions, this.options.normalGridM, cancelled, true);
        const values = new Float32Array(width * height);
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;

        for (let index = 0; index < values.length; index += 1) {
            const value = heights[index];
            if (isFiniteNumber(value)) {
                values[index] = value;
                min = Math.min(min, value);
                max = Math.max(max, value);
            } else {
                values[index] = Number.NaN;
            }
        }

        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            return null;
        }

        const grid: HeightGrid = {
            bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
            cell,
            width,
            height,
            values,
            min,
            max,
        };
        this.recordPeaks(grid);
        return grid;
    }

    /**
     * Samples a flat polyline at `spacingM`, returning heights and the distance
     * along the line. The last point is always included.
     */
    public async samplePath(
        points: number[],
        spacingM: number,
        cancelled: () => boolean,
        cache = false,
    ): Promise<HeightSample[]> {
        if (points.length < 4 || !(spacingM > 0)) {
            return [];
        }

        const positions: Array<[number, number]> = [];
        const alongs: number[] = [];
        let travelled = 0;
        let nextSampleAt = 0;

        for (let index = 0; index + 3 < points.length; index += 2) {
            const ax = points[index];
            const ay = points[index + 1];
            const bx = points[index + 2];
            const by = points[index + 3];
            const length = distance(ax, ay, bx, by);
            if (!(length > 0)) {
                continue;
            }

            while (nextSampleAt <= travelled + length) {
                const t = (nextSampleAt - travelled) / length;
                positions.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
                alongs.push(nextSampleAt);
                nextSampleAt += spacingM;
            }
            travelled += length;
        }

        // Always include the final point so the destination is checked.
        const lastX = points[points.length - 2];
        const lastY = points[points.length - 1];
        if (positions.length === 0 || distance(
            positions[positions.length - 1][0],
            positions[positions.length - 1][1],
            lastX,
            lastY,
        ) > 0.5) {
            positions.push([lastX, lastY]);
            alongs.push(travelled);
        }

        const heights = await this.sample(positions, spacingM < 10 ? 1 : this.options.normalGridM, cancelled, cache);
        const samples: HeightSample[] = [];
        for (let index = 0; index < positions.length; index += 1) {
            const height = heights[index];
            if (isFiniteNumber(height)) {
                samples.push({
                    x: positions[index][0],
                    y: positions[index][1],
                    along: alongs[index],
                    height,
                });
            }
        }
        return samples;
    }

    /**
     * Finds local maxima with enough prominence and stores the peak plus a ring
     * of 8 neighbours. Peak entries are never evicted by the ordinary LRU.
     */
    public recordPeaks(grid: HeightGrid): void {
        const { width, height, values, cell } = grid;
        if (width < 3 || height < 3) {
            return;
        }

        const radius = 2;
        for (let row = radius; row < height - radius; row += 1) {
            for (let column = radius; column < width - radius; column += 1) {
                const index = row * width + column;
                const value = values[index];
                if (!Number.isFinite(value)) {
                    continue;
                }

                let higher = false;
                let lowest = value;
                for (let dy = -radius; dy <= radius && !higher; dy += 1) {
                    for (let dx = -radius; dx <= radius; dx += 1) {
                        if (dx === 0 && dy === 0) {
                            continue;
                        }
                        const neighbour = values[(row + dy) * width + column + dx];
                        if (!Number.isFinite(neighbour)) {
                            continue;
                        }
                        if (neighbour > value) {
                            higher = true;
                            break;
                        }
                        lowest = Math.min(lowest, neighbour);
                    }
                }

                if (higher || value - lowest < this.options.peakProminenceM) {
                    continue;
                }

                const x = grid.bbox[0] + (column + 0.5) * cell;
                const y = grid.bbox[1] + (row + 0.5) * cell;
                const key = cellKey(x, y, this.options.normalGridM);
                if (this.peaks.has(key)) {
                    continue;
                }

                const ring: PeakEntry['ring'] = [];
                const ringKeys: string[] = [];
                for (const [dx, dy] of [
                    [-1, -1], [0, -1], [1, -1],
                    [-1, 0], [1, 0],
                    [-1, 1], [0, 1], [1, 1],
                ]) {
                    const neighbour = values[(row + dy) * width + column + dx];
                    if (Number.isFinite(neighbour)) {
                        const rx = grid.bbox[0] + (column + dx + 0.5) * cell;
                        const ry = grid.bbox[1] + (row + dy + 0.5) * cell;
                        const ringKey = cellKey(rx, ry, this.options.normalGridM);
                        ring.push({ x: rx, y: ry, height: neighbour });
                        ringKeys.push(ringKey);
                        this.peakSamples.set(ringKey, neighbour);
                    }
                }

                this.peaks.set(key, { x, y, height: value, ring, ringKeys });
                this.peakSamples.set(key, value);

                while (this.peaks.size > this.options.peakMax) {
                    const oldest = this.peaks.keys().next().value;
                    if (oldest === undefined) {
                        break;
                    }
                    const entry = this.peaks.get(oldest);
                    this.peaks.delete(oldest);
                    if (entry) {
                        this.peakSamples.delete(cellKey(entry.x, entry.y, this.options.normalGridM));
                        for (const ringKey of entry.ringKeys) {
                            this.peakSamples.delete(ringKey);
                        }
                    }
                }
            }
        }
    }
}
