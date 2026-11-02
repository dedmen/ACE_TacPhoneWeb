/**
 * Lazy SVG layer parsing and raster masks for routing.
 *
 * Terrain is never parsed when the GPS opens. The first route request builds
 * only the layers its travel mode needs, over the request's bounding box:
 *
 * | Mode   | Layers                           |
 * | ------ | -------------------------------- |
 * | air    | none                             |
 * | boat   | terrain (land/water)             |
 * | foot   | terrain, objects                 |
 * | ground | terrain, roads, forests, objects |
 *
 * This class owns the SVG/image cache and the mask sampling; the A* loop lives
 * in `routing/TerrainGrid.ts`.
 */

import type { TerrainData, TerrainLayer } from '@ace-tacphone/api';
import type { RouteSurface } from '../routing/SpeedModel';
import type { TravelMode } from '../routing/RouteTypes';

export type BBox = [number, number, number, number];

export type LayerRole = 'terrain' | 'roads' | 'forests' | 'objects';

/** Rasterized alpha mask of one layer over a world-space box. */
export interface Raster {
    bbox: BBox;
    /** Metres per raster cell. */
    cell: number;
    width: number;
    height: number;
    /** 1 when the layer paints this cell, 0 otherwise. */
    data: Uint8Array;
}

export interface RasterSet {
    terrain: Raster | null;
    roads: Raster | null;
    forests: Raster | null;
    objects: Raster | null;
    fences: Raster | null;
}

export const MASK_MAX_DIMENSION = 700;
export const MIN_CELL_SIZE = 5;
export const MAX_CELL_SIZE = 150;
const MASK_ALPHA_THRESHOLD = 32;

const CONTAINER_TAGS = new Set(['svg', 'g', 'defs', 'clippath', 'mask', 'symbol', 'marker']);

function isContainer(element: Element): boolean {
    return CONTAINER_TAGS.has(element.tagName.toLowerCase());
}

function isVisiblePaint(value: string): boolean {
    return value !== '' && value !== 'none' && value !== 'transparent';
}

/**
 * Effective fill/stroke for an element, walking up through groups.
 *
 * SVG paint properties are inherited, and the exported layers rely on that:
 * a `<g fill="...">` with plain `<path>` children is common. An explicit
 * `fill="none"` on the child still wins because it is found first.
 */
function inheritedPaint(element: Element, name: 'fill' | 'stroke'): string {
    let current: Element | null = element;

    while (current) {
        const style = current.getAttribute('style');
        if (style) {
            const match = style.match(new RegExp(`${name}\\s*:\\s*([^;]+)`, 'i'));
            if (match) {
                return match[1].trim().toLowerCase();
            }
        }

        const direct = current.getAttribute(name);
        if (direct !== null) {
            return direct.trim().toLowerCase();
        }

        if (current.tagName.toLowerCase() === 'svg') {
            break;
        }
        current = current.parentElement;
    }

    return '';
}

function removeSeaRects(root: Element, worldWidth: number, worldHeight: number): void {
    if (!(worldWidth > 0) || !(worldHeight > 0)) {
        return;
    }

    const visit = (parent: Element): void => {
        for (const child of Array.from(parent.children)) {
            if (child.tagName.toLowerCase() === 'rect') {
                const width = Number.parseFloat(child.getAttribute('width') ?? '0');
                const height = Number.parseFloat(child.getAttribute('height') ?? '0');
                if (width >= worldWidth * 0.9 && height >= worldHeight * 0.9) {
                    parent.removeChild(child);
                    continue;
                }
            }
            if (isContainer(child) && child.tagName.toLowerCase() !== 'defs') {
                visit(child);
            }
        }
    };

    visit(root);
}

/** Keeps only filled shapes (`fills`) or only stroked shapes (`lines`). */
function filterByPaint(root: Element, variant: 'fills' | 'lines'): void {
    const visit = (parent: Element): void => {
        for (const child of Array.from(parent.children)) {
            const tag = child.tagName.toLowerCase();
            if (tag === 'defs' || tag === 'clippath' || tag === 'mask' || tag === 'marker') {
                continue;
            }

            if (tag === 'g' || tag === 'svg') {
                visit(child);
                continue;
            }

            const fill = inheritedPaint(child, 'fill');
            const stroke = inheritedPaint(child, 'stroke');
            const keep = variant === 'fills'
                ? isVisiblePaint(fill)
                : !isVisiblePaint(fill) && isVisiblePaint(stroke);

            if (!keep) {
                parent.removeChild(child);
            }
        }
    };

    visit(root);
}

function buildSvgVariant(
    svgText: string,
    role: LayerRole,
    variant: 'full' | 'fills' | 'lines',
    worldWidth: number,
    worldHeight: number,
): string | null {
    const document = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const root = document.documentElement;

    if (!root || root.tagName.toLowerCase() !== 'svg') {
        return null;
    }
    if (document.getElementsByTagName('parsererror').length > 0) {
        return null;
    }

    if (role === 'terrain') {
        removeSeaRects(root, worldWidth, worldHeight);
    } else if (variant !== 'full') {
        filterByPaint(root, variant);
    }

    return new XMLSerializer().serializeToString(document);
}

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/** One terrain snapshot's parsed masks and layer images. */
export class TerrainMasks {
    private terrain: TerrainData | null;
    private readonly imageCache = new Map<string, Promise<HTMLImageElement | null>>();
    private disposed = false;

    constructor(terrain: TerrainData | null) {
        this.terrain = terrain;
    }

    public setTerrain(terrain: TerrainData | null): void {
        if (this.terrain === terrain) {
            return;
        }

        this.terrain = terrain;
        this.imageCache.clear();
    }

    public dispose(): void {
        this.disposed = true;
        this.imageCache.clear();
        this.terrain = null;
    }

    public getBounds(): { width: number; height: number } | null {
        return this.terrain
            ? { width: this.terrain.width, height: this.terrain.height }
            : null;
    }

    public hasLayer(role: LayerRole): boolean {
        return this.findLayer(role) !== null;
    }

    public findLayer(role: LayerRole): TerrainLayer | null {
        if (!this.terrain) {
            return null;
        }

        // Exact role names first; the exported layers are normally `terrain`,
        // `roads`, `forests`, `objects`. The substring fallback keeps maps with
        // a suffix (`roads_alt`, `forest_01`) working, but never picks a random
        // layer whose name merely contains the word.
        const exactNames: Record<LayerRole, readonly string[]> = {
            terrain: ['terrain', 'land'],
            roads: ['roads', 'road'],
            forests: ['forests', 'forest'],
            objects: ['objects', 'object'],
        };
        const keywords: Record<LayerRole, readonly string[]> = {
            terrain: ['terrain', 'land'],
            roads: ['road'],
            forests: ['forest'],
            objects: ['object'],
        };

        for (const name of exactNames[role]) {
            const layer = this.terrain.layers.find((entry) =>
                entry.name.toLowerCase() === name,
            );
            if (layer) {
                return layer;
            }
        }

        for (const keyword of keywords[role]) {
            const layer = this.terrain.layers.find((entry) =>
                entry.name.toLowerCase().includes(keyword),
            );
            if (layer) {
                return layer;
            }
        }

        return null;
    }

    /** Route bbox plus a margin, clamped to the terrain. */
    public planningBounds(start: [number, number], waypoints: Array<[number, number]>): BBox {
        let minX = start[0];
        let minY = start[1];
        let maxX = start[0];
        let maxY = start[1];

        for (const point of waypoints) {
            minX = Math.min(minX, point[0]);
            minY = Math.min(minY, point[1]);
            maxX = Math.max(maxX, point[0]);
            maxY = Math.max(maxY, point[1]);
        }

        const margin = Math.max(600, Math.hypot(maxX - minX, maxY - minY) * 0.05);
        minX -= margin;
        minY -= margin;
        maxX += margin;
        maxY += margin;

        if (this.terrain) {
            minX = Math.max(0, minX);
            minY = Math.max(0, minY);
            maxX = Math.min(this.terrain.width, maxX);
            maxY = Math.min(this.terrain.height, maxY);
        }

        return [minX, minY, maxX, maxY];
    }

    public cellSizeFor(bbox: BBox): number {
        return clamp(
            Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / MASK_MAX_DIMENSION,
            MIN_CELL_SIZE,
            MAX_CELL_SIZE,
        );
    }

    public async buildRasters(
        mode: TravelMode,
        bbox: BBox,
        cell: number,
        isCancelled: () => boolean,
    ): Promise<RasterSet> {
        const rasters: RasterSet = {
            terrain: null,
            roads: null,
            forests: null,
            objects: null,
            fences: null,
        };

        const needsTerrain = mode !== 'air';
        const needsObjects = mode === 'foot' || mode === 'ground';
        const needsRoads = mode === 'ground';
        const needsForests = mode === 'ground';

        if (needsTerrain) {
            rasters.terrain = await this.rasterFor('terrain', 'full', bbox, cell);
            if (isCancelled()) {
                return rasters;
            }
        }

        if (needsRoads) {
            // The roads layer is a set of stroked centerlines; the filled
            // variants are the road surface and must not be used as the mask.
            rasters.roads = await this.rasterFor('roads', 'lines', bbox, cell);
            if (isCancelled()) {
                return rasters;
            }
        }

        if (needsForests) {
            rasters.forests = await this.rasterFor('forests', 'full', bbox, cell);
            if (isCancelled()) {
                return rasters;
            }
        }

        if (needsObjects) {
            rasters.objects = await this.rasterFor('objects', 'fills', bbox, cell);
            if (isCancelled()) {
                return rasters;
            }
            rasters.fences = await this.rasterFor('objects', 'lines', bbox, cell);
        }

        return rasters;
    }

    public sample(raster: Raster | null, x: number, y: number): boolean {
        if (!raster) {
            return false;
        }

        const column = Math.floor((x - raster.bbox[0]) / raster.cell);
        // The SVG image is top-down; map Y is bottom-up. Row 0 is maxY.
        const row = Math.floor((raster.bbox[3] - y) / raster.cell);

        if (column < 0 || row < 0 || column >= raster.width || row >= raster.height) {
            return false;
        }

        return raster.data[row * raster.width + column] === 1;
    }

    public landAt(x: number, y: number, rasters: RasterSet): boolean | null {
        if (!rasters.terrain) {
            return null;
        }
        return this.sample(rasters.terrain, x, y);
    }

    public surfaceAt(x: number, y: number, rasters: RasterSet): RouteSurface {
        // Roads win over water: a road/track over a river is a bridge, not a
        // swim. This also keeps bridge edges on the road graph.
        if (this.sample(rasters.roads, x, y)) {
            return 'road';
        }
        const land = this.landAt(x, y, rasters);
        if (land === false) {
            return 'water';
        }
        if (this.sample(rasters.forests, x, y)) {
            return 'forest';
        }
        return 'offroad';
    }

    public isPassable(
        mode: TravelMode,
        x: number,
        y: number,
        rasters: RasterSet,
        waterCapable: boolean,
    ): boolean {
        if (mode === 'air') {
            return true;
        }
        if (mode === 'boat') {
            return this.landAt(x, y, rasters) === false;
        }
        if (this.sample(rasters.objects, x, y)) {
            return false;
        }
        if (mode === 'foot') {
            return true;
        }
        const land = this.landAt(x, y, rasters);
        return land !== false || waterCapable;
    }

    public nearestPassable(
        mode: TravelMode,
        point: [number, number],
        rasters: RasterSet,
        bbox: BBox,
        cell: number,
        waterCapable: boolean,
    ): [number, number] | null {
        const columns = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / cell));
        const rows = Math.max(1, Math.ceil((bbox[3] - bbox[1]) / cell));
        const startColumn = Math.floor((point[0] - bbox[0]) / cell);
        const startRow = Math.floor((bbox[3] - point[1]) / cell);
        // Boat start/end points may be kilometres inland; search the whole
        // planning bbox (capped) instead of only 60 cells.
        const maxRadius = Math.min(600, Math.max(columns, rows));

        for (let radius = 1; radius <= maxRadius; radius += 1) {
            for (let row = startRow - radius; row <= startRow + radius; row += 1) {
                for (let column = startColumn - radius; column <= startColumn + radius; column += 1) {
                    if (row < 0 || column < 0 || row >= rows || column >= columns) {
                        continue;
                    }
                    if (Math.max(Math.abs(row - startRow), Math.abs(column - startColumn)) !== radius) {
                        continue;
                    }

                    const x = bbox[0] + (column + 0.5) * cell;
                    const y = bbox[3] - (row + 0.5) * cell;
                    if (this.isPassable(mode, x, y, rasters, waterCapable)) {
                        return [x, y];
                    }
                }
            }
        }

        return null;
    }

    /**
     * Terrain-only water query over a box around `point`.
     *
     * Used by the debug probe and by tests that need to know whether water is
     * within reach before asserting boat geometry.
     */
    public async queryWater(
        point: [number, number],
        radiusM: number,
    ): Promise<{ water: boolean; nearestWater: [number, number] | null; hasTerrain: boolean }> {
        const center = sanitizePoint(point);
        const reach = Number.isFinite(radiusM) ? Math.max(0, radiusM) : 0;

        if (!center || !this.hasLayer('terrain')) {
            return { water: false, nearestWater: null, hasTerrain: false };
        }

        const bbox: BBox = [
            center[0] - reach,
            center[1] - reach,
            center[0] + reach,
            center[1] + reach,
        ];

        if (this.terrain) {
            bbox[0] = Math.max(0, bbox[0]);
            bbox[1] = Math.max(0, bbox[1]);
            bbox[2] = Math.min(this.terrain.width, bbox[2]);
            bbox[3] = Math.min(this.terrain.height, bbox[3]);
        }

        if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
            return { water: false, nearestWater: null, hasTerrain: true };
        }

        const cell = this.cellSizeFor(bbox);
        const rasters = await this.buildRasters('boat', bbox, cell, () => this.disposed);
        if (this.disposed || !rasters.terrain) {
            return { water: false, nearestWater: null, hasTerrain: false };
        }

        // The terrain mask paints land, so an unpainted cell is water.
        const water = !this.sample(rasters.terrain, center[0], center[1]);

        return {
            water,
            nearestWater: this.nearestWaterCentre(rasters.terrain, center),
            hasTerrain: true,
        };
    }

    /** Nearest unpainted (water) cell centre, or null when there is none. */
    public nearestWaterCentre(raster: Raster, point: [number, number]): [number, number] | null {
        const startColumn = Math.floor((point[0] - raster.bbox[0]) / raster.cell);
        const startRow = Math.floor((raster.bbox[3] - point[1]) / raster.cell);
        const maxRadius = Math.max(raster.width, raster.height);

        const isWater = (column: number, row: number): boolean => (
            column >= 0 && row >= 0 && column < raster.width && row < raster.height
            && raster.data[row * raster.width + column] === 0
        );

        if (isWater(startColumn, startRow)) {
            return this.cellCentre(raster, startColumn, startRow);
        }

        for (let radius = 1; radius <= maxRadius; radius += 1) {
            for (let row = startRow - radius; row <= startRow + radius; row += 1) {
                for (let column = startColumn - radius; column <= startColumn + radius; column += 1) {
                    if (Math.max(Math.abs(row - startRow), Math.abs(column - startColumn)) !== radius) {
                        continue;
                    }
                    if (isWater(column, row)) {
                        return this.cellCentre(raster, column, row);
                    }
                }
            }
        }

        return null;
    }

    /** World-space centre of one raster cell. */
    public cellCentre(raster: Raster, column: number, row: number): [number, number] {
        return [
            raster.bbox[0] + (column + 0.5) * raster.cell,
            raster.bbox[3] - (row + 0.5) * raster.cell,
        ];
    }

    private async rasterFor(
        role: LayerRole,
        variant: 'full' | 'fills' | 'lines',
        bbox: BBox,
        cell: number,
    ): Promise<Raster | null> {
        const image = await this.layerImage(role, variant);
        if (!image || !this.terrain) {
            return null;
        }
        return this.rasterize(image, bbox, cell);
    }

    private layerImage(
        role: LayerRole,
        variant: 'full' | 'fills' | 'lines',
    ): Promise<HTMLImageElement | null> {
        const layer = this.findLayer(role);
        if (!layer) {
            return Promise.resolve(null);
        }

        const key = `${role}:${variant}:${layer.name}`;
        const cached = this.imageCache.get(key);
        if (cached) {
            return cached;
        }

        const promise = this.loadImage(layer, role, variant);
        this.imageCache.set(key, promise);
        return promise;
    }

    private async loadImage(
        layer: TerrainLayer,
        role: LayerRole,
        variant: 'full' | 'fills' | 'lines',
    ): Promise<HTMLImageElement | null> {
        const worldWidth = this.terrain?.width ?? 0;
        const worldHeight = this.terrain?.height ?? 0;

        const svg = buildSvgVariant(layer.svg, role, variant, worldWidth, worldHeight);
        if (!svg) {
            console.warn(`GPS: could not parse terrain layer "${layer.name}"`);
            return null;
        }

        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
        const image = new Image();

        try {
            await new Promise<void>((resolve, reject) => {
                image.onload = () => resolve();
                image.onerror = () => reject(new Error(`Failed to load layer "${layer.name}"`));
                image.src = url;
            });
            return image;
        } catch (error) {
            console.warn('GPS: terrain layer image failed', error);
            return null;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    private rasterize(image: HTMLImageElement, bbox: BBox, cell: number): Raster | null {
        if (!this.terrain) {
            return null;
        }

        const width = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / cell) + 1);
        const height = Math.max(1, Math.ceil((bbox[3] - bbox[1]) / cell) + 1);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });

        if (!context) {
            console.warn('GPS: could not create a 2D canvas for terrain masks');
            return null;
        }

        context.setTransform(1, 0, 0, 1, 0, 0);
        context.scale(1 / cell, 1 / cell);
        // SVG Y is top-down and map Y is bottom-up. Image row 0 must land on
        // maxY; the mask reader flips Y on lookup.
        context.translate(-bbox[0], bbox[3] - this.terrain.height);
        context.drawImage(image, 0, 0, this.terrain.width, this.terrain.height);

        const pixels = context.getImageData(0, 0, width, height).data;
        const data = new Uint8Array(width * height);

        for (let index = 0; index < data.length; index += 1) {
            data[index] = pixels[index * 4 + 3] > MASK_ALPHA_THRESHOLD ? 1 : 0;
        }

        return { bbox, cell, width, height, data };
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
