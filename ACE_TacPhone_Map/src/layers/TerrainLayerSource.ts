// Image decode and OpenLayers tile-layer construction for one terrain SVG.
//
// Kept apart from Map.tsx so the progressive loader can build a layer as soon
// as its image is decoded, and so the tile source math has a single home.

import TileLayer from 'ol/layer/Tile';
import type Projection from 'ol/proj/Projection';
import ImageTileSource from 'ol/source/ImageTile';
import type TileGrid from 'ol/tilegrid/TileGrid.js';
import type { TerrainLayer } from '@ace-tacphone/api';

import type { TerrainLayerPlan } from './TerrainLayerPriority';

/**
 * Terrain layers keep their document order among themselves but must stay below
 * every marker/GPS layer: marker channel layers use zIndex 1, measurement 2,
 * preview 3, polyline drawing 4, GPS 28-70 and the fly-to highlight 100.
 */
export const TERRAIN_Z_INDEX_STEP = 0.01;

/**
 * Decodes a layer's standalone SVG into an image.
 *
 * There is deliberately no `image.decode()`: for a huge SVG it can force a full
 * intrinsic-size rasterization. The first `drawImage` crop rasterizes only the
 * region a tile needs.
 */
export function loadTerrainLayerImage(
    layer: TerrainLayer,
): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const imageUrl = URL.createObjectURL(
            new Blob([layer.svg], { type: 'image/svg+xml;charset=utf-8' }),
        );

        image.onload = () => {
            // The browser no longer needs the blob URL once the image is decoded.
            URL.revokeObjectURL(imageUrl);
            resolve(image);
        };

        image.onerror = () => {
            URL.revokeObjectURL(imageUrl);
            reject(new Error(`Failed to load terrain layer "${layer.name}".`));
        };

        image.src = imageUrl;
    });
}

export interface TerrainTileSourceOptions {
    projection: Projection;
    tileGrid: TileGrid;
    resolutions: readonly number[];
    tileSize: number;
    smoothScaling: boolean;
}

export interface TerrainTileLayerOptions extends TerrainTileSourceOptions {
    preload: number;
    cacheSize: number;
}

/**
 * Builds the tile source that crops `tileSize` squares out of the decoded SVG
 * image. Source rectangles outside the image are legal and yield transparency,
 * so edge tiles need no clamping.
 */
export function createTerrainTileSource(
    image: HTMLImageElement,
    layerName: string,
    options: TerrainTileSourceOptions,
): ImageTileSource {
    return new ImageTileSource({
        tileGrid: options.tileGrid,
        projection: options.projection,
        interpolate: options.smoothScaling,
        // No cross-fade. During a zoom OpenLayers would otherwise keep and
        // rasterize both the old and the new level at once, doubling the tile
        // canvases and the allocation/GC pressure while loading.
        transition: 0,
        loader: (z, x, y) => new Promise<HTMLCanvasElement>((resolve, reject) => {
            const resolution = options.resolutions[z];
            if (!Number.isFinite(resolution)) {
                reject(new Error(`Unknown terrain tile level ${z} for layer "${layerName}".`));
                return;
            }

            // How many raw terrain units one tile covers at this zoom level.
            const chunkWidth = options.tileSize * resolution;
            const chunkHeight = options.tileSize * resolution;

            const canvas = document.createElement('canvas');
            canvas.width = options.tileSize;
            canvas.height = options.tileSize;

            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error(
                    `Failed to create a 2D canvas context for terrain layer "${layerName}".`,
                ));
                return;
            }

            ctx.imageSmoothingEnabled = options.smoothScaling;

            // Crop the decoded SVG image; Chromium only rasterizes the source
            // rectangle instead of the whole scene.
            ctx.drawImage(
                image,
                x * chunkWidth,
                y * chunkHeight,
                chunkWidth,
                chunkHeight,
                0,
                0,
                options.tileSize,
                options.tileSize,
            );

            resolve(canvas);
        }),
    });
}

/** Creates one terrain tile layer from a decoded image and its plan. */
export function createTerrainTileLayer(
    plan: TerrainLayerPlan,
    image: HTMLImageElement,
    options: TerrainTileLayerOptions,
): TileLayer<ImageTileSource> {
    const source = createTerrainTileSource(image, plan.name, options);

    return new TileLayer({
        properties: { title: plan.name },
        source,
        preload: options.preload,
        cacheSize: options.cacheSize,
        // LOD: OpenLayers hides the layer at `resolution >= maxResolution`.
        maxResolution: plan.maxResolution,
        zIndex: plan.documentIndex * TERRAIN_Z_INDEX_STEP,
    });
}
