#!/usr/bin/env node
/**
 * Opt-in benchmark for the terrain `TERRAIN_TILE_SIZE` constant.
 *
 * The Map crops every terrain layer SVG into `tileSize` square canvas tiles and
 * hands those canvases to OpenLayers. The crop itself is cheap, but the number
 * of draws for one screenful is not: a 1280x900 viewport needs 99 tiles at
 * 128 px, 30 at 256 px and 9 at 512 px, per layer. This script measures that
 * cost in the same browser the test suite uses, with synthetic SVG layers that
 * have the element density of a real map layer.
 *
 * It does NOT measure the game protocol, terrain splitting or network transfer,
 * and it runs without Arma. Use it to compare tile sizes, then confirm the
 * result on a real map with `map-tiles` / `getViewState()` timings.
 *
 * Usage (from `websource`):
 *
 *   node ACE_TacPhone_Map/test/benchmark/tile-size.mjs
 *   node ACE_TacPhone_Map/test/benchmark/tile-size.mjs --headed --runs 5
 *   node ACE_TacPhone_Map/test/benchmark/tile-size.mjs --paths 40000 --sizes 128,256,512
 *
 * Exit code is 0 for a successful run, 1 when the browser is unavailable.
 */

import { launchBrowser } from '../../../ACE_TacPhone_Main/test/lib/browser.mjs';
import { SkipError } from '../../../ACE_TacPhone_Main/test/lib/skip.mjs';

const VIEWPORTS = [
    { name: 'phone', width: 390, height: 780 },
    { name: 'host', width: 1280, height: 900 },
];

const DEFAULT_SIZES = [128, 256, 512];

function readNumber(argv, name, fallback) {
    const index = argv.indexOf(`--${name}`);
    if (index === -1 || index + 1 >= argv.length) {
        return fallback;
    }

    const value = Number(argv[index + 1]);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--${name} expects a positive number`);
    }

    return value;
}

function readList(argv, name, fallback) {
    const index = argv.indexOf(`--${name}`);
    if (index === -1 || index + 1 >= argv.length) {
        return fallback;
    }

    return argv[index + 1]
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
}

/**
 * Runs the benchmark inside the page.
 *
 * Every layer SVG is rasterized once through an `Image` (the same way the app
 * decodes a layer) and then cropped like `TerrainLayerSource` does. The first
 * draw of a region forces Chromium to rasterize it, so each configuration is
 * measured on a fresh image built from the same SVG.
 */
const PAGE_SCRIPT = `
async function buildSvg({ width, height, paths, seed }) {
    let state = seed >>> 0;
    const random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };

    const parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">',
    ];

    for (let index = 0; index < paths; index += 1) {
        // Small polygons: the real layers are many small features, not a few
        // giant ones, and per-element overhead is what a layer pays for.
        const x = random() * width;
        const y = random() * height;
        const size = 6 + random() * 24;
        const hue = Math.floor(random() * 360);
        parts.push(
            '<path d="M' + x.toFixed(1) + ' ' + y.toFixed(1)
            + 'L' + (x + size).toFixed(1) + ' ' + (y + size * 0.4).toFixed(1)
            + 'L' + (x + size * 0.6).toFixed(1) + ' ' + (y + size).toFixed(1)
            + 'Z" fill="hsl(' + hue + ' 30% 45% / 0.7)" stroke="hsl(' + hue + ' 20% 25%)" stroke-width="0.7"/>',
        );
    }

    parts.push('</svg>');
    return parts.join('');
}

async function loadImage(svg) {
    const startedAt = performance.now();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const image = new Image();

    await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('synthetic terrain SVG failed to load'));
        image.src = url;
    });
    URL.revokeObjectURL(url);

    return { image, decodeMs: performance.now() - startedAt };
}

function renderViewport(image, { width, height, tileSize, extent, resolution, offsetX, offsetY }) {
    const tilesX = Math.ceil(width / tileSize) + 1;
    const tilesY = Math.ceil(height / tileSize) + 1;
    const startedAt = performance.now();
    let firstTileMs = null;

    for (let ty = 0; ty < tilesY; ty += 1) {
        for (let tx = 0; tx < tilesX; tx += 1) {
            const tileStartedAt = performance.now();
            const chunk = tileSize * resolution;
            const canvas = document.createElement('canvas');
            canvas.width = tileSize;
            canvas.height = tileSize;
            const context = canvas.getContext('2d');
            context.imageSmoothingEnabled = true;
            context.drawImage(
                image,
                (tx - offsetX) * chunk,
                (ty - offsetY) * chunk,
                chunk,
                chunk,
                0,
                0,
                tileSize,
                tileSize,
            );

            if (firstTileMs === null) {
                firstTileMs = performance.now() - tileStartedAt;
            }
        }
    }

    return {
        tiles: tilesX * tilesY,
        totalMs: performance.now() - startedAt,
        firstTileMs,
        canvasBytes: tilesX * tilesY * tileSize * tileSize * 4,
    };
}

window.__runTileSizeBenchmark = async ({ viewports, sizes, paths, runs }) => {
    // 2048 map units wide, like a small terrain; the SVG intrinsic size caps
    // how many crop regions Chromium can rasterize from one decode.
    const width = 2048;
    const height = 2048;
    const svg = await buildSvg({ width, height, paths, seed: 1337 });
    const results = [];

    for (const tileSize of sizes) {
        for (const viewport of viewports) {
            // A viewport that is slightly smaller than the image, panned like a
            // normal map: the crop regions stay inside the intrinsic image.
            const resolution = width / (viewport.width * 1.4);
            const samples = [];

            for (let run = 0; run < runs; run += 1) {
                const { image, decodeMs } = await loadImage(svg);
                // Warm the image the same way the first real frame would.
                const warm = document.createElement('canvas');
                warm.width = 8;
                warm.height = 8;
                warm.getContext('2d').drawImage(image, 0, 0, 8, 8);

                const sample = renderViewport(image, {
                    width: viewport.width,
                    height: viewport.height,
                    tileSize,
                    extent: width,
                    resolution,
                    offsetX: 0.2 * run,
                    offsetY: 0.2 * run,
                });

                samples.push({ ...sample, decodeMs });
                // Force the sample to be GC-able between runs.
                await new Promise((resolve) => setTimeout(resolve, 0));
            }

            const median = (key) => {
                const values = samples.map((sample) => sample[key]).sort((a, b) => a - b);
                return values[Math.floor(values.length / 2)];
            };

            results.push({
                tileSize,
                viewport: viewport.name,
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                tiles: samples[0].tiles,
                decodeMs: median('decodeMs'),
                firstTileMs: median('firstTileMs'),
                totalMs: median('totalMs'),
                canvasBytes: samples[0].canvasBytes,
            });
        }
    }

    return { svgBytes: svg.length, results };
};
`;

function formatMs(value) {
    return value.toFixed(1).padStart(7);
}

function formatMiB(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function main() {
    const argv = process.argv.slice(2);
    const headed = argv.includes('--headed');
    const runs = Math.round(readNumber(argv, 'runs', 3));
    const paths = Math.round(readNumber(argv, 'paths', 24000));
    const sizes = readList(argv, 'sizes', DEFAULT_SIZES);

    let browser;
    try {
        browser = await launchBrowser({ headed });
    } catch (error) {
        if (error instanceof SkipError) {
            console.error(`SKIP ${error.message}`);
            process.exitCode = 1;
            return;
        }
        throw error;
    }

    try {
        const page = await browser.newPage();
        await page.setContent('<!doctype html><meta charset="utf-8"><title>tile-size</title>');
        await page.addScriptTag({ content: PAGE_SCRIPT });

        const { svgBytes, results } = await page.evaluate(
            (input) => window.__runTileSizeBenchmark(input),
            { viewports: VIEWPORTS, sizes, paths, runs },
        );

        console.log(`Terrain tile-size benchmark (${runs} runs, ${paths} paths, ${(svgBytes / (1024 * 1024)).toFixed(2)} MiB SVG)`);
        console.log('decode = Image onload; first = first tile crop; total = one full viewport of tiles');
        console.log('');

        for (const viewport of VIEWPORTS) {
            const rows = results.filter((row) => row.viewport === viewport.name);
            if (rows.length === 0) {
                continue;
            }

            console.log(`${viewport.name} viewport ${viewport.width}x${viewport.height}`);
            console.log('  tile  tiles   decode   first    total   canvases');
            for (const row of rows) {
                console.log(
                    `  ${String(row.tileSize).padStart(4)}`
                    + `  ${String(row.tiles).padStart(5)}`
                    + `  ${formatMs(row.decodeMs)}`
                    + ` ${formatMs(row.firstTileMs)}`
                    + ` ${formatMs(row.totalMs)}`
                    + `  ${formatMiB(row.canvasBytes).padStart(9)}`,
                );
            }
            console.log('');
        }

        const hostRows = results.filter((row) => row.viewport === 'host');
        if (hostRows.length > 1) {
            const sorted = [...hostRows].sort((a, b) => a.totalMs - b.totalMs);
            console.log(`Fastest host-viewport tile size in this run: ${sorted[0].tileSize} px (${sorted[0].totalMs.toFixed(1)} ms).`);
            console.log('Confirm on a real map before changing TERRAIN_TILE_SIZE; canvas memory grows quadratically.');
        }
    } finally {
        await browser.close().catch(() => {});
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
