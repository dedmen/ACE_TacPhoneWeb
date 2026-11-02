/**
 * Debug-only route-planning overlay painters.
 *
 * `GpsModule` feeds the {@link RouteDebugGrid} produced by `RoutePlanner` into
 * these functions and wraps the returned canvas in an OpenLayers image layer.
 * They are pure canvas work plus colour mapping: no map, no React, and nothing
 * here is used outside the debug overlay.
 *
 * Colours are a green → yellow → red heat ramp: cheap/low is green,
 * expensive/high is red. Water is always red, blocked cells are dark red.
 */

import {
    ROUTE_DEBUG_FOREST,
    ROUTE_DEBUG_OFFROAD,
    ROUTE_DEBUG_ROAD,
    ROUTE_DEBUG_WATER,
    type RouteDebugGrid,
    type RouteDebugHeights,
} from './GpsTypes';

/** Overlay opacity: the terrain must stay readable underneath. */
export const DEBUG_OVERLAY_ALPHA = 0.35;

function alphaByte(alpha: number): number {
    return Math.round(Math.max(0.02, Math.min(1, alpha)) * 255);
}

/** World extent the grid image covers (cells are `cell` metres wide). */
export function debugGridExtent(grid: RouteDebugGrid): [number, number, number, number] {
    return [
        grid.bbox[0],
        grid.bbox[1],
        grid.bbox[0] + grid.width * grid.cell,
        grid.bbox[1] + grid.height * grid.cell,
    ];
}

/** Green (cheap/low) → yellow → red (expensive/high). */
function heatColor(t: number): [number, number, number] {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));

    if (clamped < 0.5) {
        const k = clamped * 2;
        return [
            Math.round(34 + (234 - 34) * k),
            Math.round(197 + (179 - 197) * k),
            Math.round(94 + (8 - 94) * k),
        ];
    }

    const k = (clamped - 0.5) * 2;
    return [
        Math.round(234 + (239 - 234) * k),
        Math.round(179 + (68 - 179) * k),
        Math.round(8 + (68 - 8) * k),
    ];
}

function createCanvas(width: number, height: number): {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
} | null {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const context = canvas.getContext('2d');
    return context ? { canvas, context } : null;
}

/**
 * Cost overlay: one pixel per planning cell.
 *
 * Water is fully red (an impassable red for a non-amphibious ground vehicle),
 * blocked object cells are dark red, and the remaining cells are normalised
 * from the cheapest to the most expensive cost. `slopeInfluence` multiplies
 * the surface cost by the slope factor; without height data it is ignored.
 */
export function buildCostOverlayCanvas(
    grid: RouteDebugGrid,
    slopeInfluence: boolean,
    alpha = DEBUG_OVERLAY_ALPHA,
): HTMLCanvasElement | null {
    const target = createCanvas(grid.width, grid.height);
    if (!target) {
        return null;
    }

    const { canvas, context } = target;
    const image = context.createImageData(grid.width, grid.height);
    const pixels = image.data;
    const useSlope = slopeInfluence && grid.hasSlope;
    const overlayAlpha = alphaByte(alpha);

    const costAt = (index: number): number => {
        const base = grid.cost[index];
        if (!(base > 0) || !Number.isFinite(base)) {
            return Number.NaN;
        }
        return useSlope ? base * grid.slope[index] : base;
    };

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < grid.width * grid.height; index += 1) {
        if (grid.passable[index] !== 1 || grid.surface[index] === ROUTE_DEBUG_WATER) {
            continue;
        }
        const cost = costAt(index);
        if (!Number.isFinite(cost)) {
            continue;
        }
        min = Math.min(min, cost);
        max = Math.max(max, cost);
    }

    const span = Number.isFinite(min) && Number.isFinite(max) && max > min ? max - min : 0;

    // Canvas row 0 is the top of the ImageStatic, which OpenLayers places at
    // maxY. Read the grid from the bottom row so north/south is not flipped.
    for (let row = 0; row < grid.height; row += 1) {
        const sourceRow = grid.height - 1 - row;
        for (let column = 0; column < grid.width; column += 1) {
        const index = sourceRow * grid.width + column;
        const offset = (row * grid.width + column) * 4;

        if (grid.surface[index] === ROUTE_DEBUG_WATER) {
            // Water: solid red, slightly darker when the mode cannot cross it.
            const shade = grid.passable[index] === 1 ? 0 : -40;
            pixels[offset] = 220;
            pixels[offset + 1] = Math.max(0, 38 + shade);
            pixels[offset + 2] = Math.max(0, 38 + shade);
            pixels[offset + 3] = overlayAlpha;
            continue;
        }

        if (grid.passable[index] !== 1) {
            // Blocked by objects or a mode restriction.
            pixels[offset] = 96;
            pixels[offset + 1] = 20;
            pixels[offset + 2] = 20;
            pixels[offset + 3] = overlayAlpha;
            continue;
        }

        const cost = costAt(index);
        if (!Number.isFinite(cost)) {
            pixels[offset + 3] = 0;
            continue;
        }

        const t = span > 0 ? (cost - min) / span : 0.5;
        const [red, green, blue] = heatColor(t);
        pixels[offset] = red;
        pixels[offset + 1] = green;
        pixels[offset + 2] = blue;
        pixels[offset + 3] = overlayAlpha;
        }
    }

    context.putImageData(image, 0, 0);
    return canvas;
}

/** Values at one world position in the debug grid. */
export interface DebugSample {
    /** Interpolated terrain height in metres, or null when unknown. */
    height: number | null;
    /** Travel cost in seconds per metre, or null when the cell has no cost. */
    cost: number | null;
    /** Slope multiplier (1 without slope data). */
    slope: number;
    surface: 'water' | 'road' | 'forest' | 'offroad' | null;
    passable: boolean;
}

const SURFACE_NAMES: Record<number, DebugSample['surface']> = {
    [ROUTE_DEBUG_WATER]: 'water',
    [ROUTE_DEBUG_ROAD]: 'road',
    [ROUTE_DEBUG_FOREST]: 'forest',
    [ROUTE_DEBUG_OFFROAD]: 'offroad',
};

/** Samples one world position for the debug hover readout. */
export function sampleDebugGrid(
    grid: RouteDebugGrid,
    x: number,
    y: number,
    slopeInfluence: boolean,
): DebugSample | null {
    const column = Math.floor((x - grid.bbox[0]) / grid.cell);
    const row = Math.floor((y - grid.bbox[1]) / grid.cell);
    if (column < 0 || row < 0 || column >= grid.width || row >= grid.height) {
        return null;
    }

    const index = row * grid.width + column;
    const height = grid.heights ? sampleHeight(grid.heights, x, y) : Number.NaN;
    const slope = grid.slope[index];
    const base = grid.cost[index];
    const cost = Number.isFinite(base) && base > 0
        ? base * (slopeInfluence && grid.hasSlope ? slope : 1)
        : null;

    return {
        height: Number.isFinite(height) ? height : null,
        cost,
        slope,
        surface: SURFACE_NAMES[grid.surface[index]] ?? null,
        passable: grid.passable[index] === 1,
    };
}

/** Unknown heights leave the pixel transparent. */
function sampleHeight(heights: RouteDebugHeights, x: number, y: number): number {
    const { width, height, bbox, values } = heights;
    const stepX = (bbox[2] - bbox[0]) / Math.max(1, width);
    const stepY = (bbox[3] - bbox[1]) / Math.max(1, height);
    if (!(stepX > 0) || !(stepY > 0)) {
        return Number.NaN;
    }

    const localX = Math.max(0, Math.min(width - 1, (x - bbox[0]) / stepX - 0.5));
    const localY = Math.max(0, Math.min(height - 1, (y - bbox[1]) / stepY - 0.5));
    const column = Math.min(width - 1, Math.floor(localX));
    const row = Math.min(height - 1, Math.floor(localY));
    const nextColumn = Math.min(width - 1, column + 1);
    const nextRow = Math.min(height - 1, row + 1);
    const fx = localX - column;
    const fy = localY - row;

    const a = values[row * width + column];
    const b = values[row * width + nextColumn];
    const c = values[nextRow * width + column];
    const d = values[nextRow * width + nextColumn];

    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) {
        return Number.NaN;
    }

    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/**
 * Height overlay: the coarse height samples interpolated over the planning
 * grid, green lowest and red highest. Returns null without height data.
 */
export function buildHeightOverlayCanvas(
    grid: RouteDebugGrid,
    alpha = DEBUG_OVERLAY_ALPHA,
): HTMLCanvasElement | null {
    const heights = grid.heights;
    if (!heights) {
        return null;
    }

    const target = createCanvas(grid.width, grid.height);
    if (!target) {
        return null;
    }

    const { canvas, context } = target;
    const image = context.createImageData(grid.width, grid.height);
    const pixels = image.data;
    const span = heights.max > heights.min ? heights.max - heights.min : 0;
    const overlayAlpha = alphaByte(alpha);

    for (let row = 0; row < grid.height; row += 1) {
        // Same north/south flip as the cost overlay: canvas row 0 is maxY.
        const sourceRow = grid.height - 1 - row;
        for (let column = 0; column < grid.width; column += 1) {
            const index = sourceRow * grid.width + column;
            const offset = (row * grid.width + column) * 4;
            const x = grid.bbox[0] + (column + 0.5) * grid.cell;
            const y = grid.bbox[1] + (sourceRow + 0.5) * grid.cell;
            const value = sampleHeight(heights, x, y);

            if (grid.surface[index] === ROUTE_DEBUG_WATER) {
                // Water is blue regardless of the seabed height; the heat ramp
                // alone made deep water look like a mountain.
                pixels[offset] = 54;
                pixels[offset + 1] = 116;
                pixels[offset + 2] = 206;
                pixels[offset + 3] = overlayAlpha;
                continue;
            }

            if (!Number.isFinite(value)) {
                pixels[offset + 3] = 0;
                continue;
            }

            const [red, green, blue] = heatColor(span > 0 ? (value - heights.min) / span : 0.5);
            pixels[offset] = red;
            pixels[offset + 1] = green;
            pixels[offset + 2] = blue;
            pixels[offset + 3] = overlayAlpha;
        }
    }

    context.putImageData(image, 0, 0);
    return canvas;
}
