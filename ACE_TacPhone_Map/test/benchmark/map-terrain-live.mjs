#!/usr/bin/env node
/**
 * Opt-in live benchmark for the Map terrain load (needs Arma + the web host).
 *
 * Unlike `tile-size.mjs` (synthetic, no game), this drives the real host page
 * and the real game terrain. It reports, per tile-size default:
 *
 *   - time until the view is ready and until every layer/tile is settled;
 *   - each layer's `activatedAfterMs` (decode + add) and `firstTileStartMs`;
 *   - the zoom-in, pan and deep-zoom re-settle time and requested tile counts;
 *   - per-layer tile counts and LOD visibility after the deep zoom;
 *   - long tasks (> 50 ms) observed in each phase.
 *
 * It zooms one level in before panning: at the exact fitted resolution the
 * visible extent equals the terrain extent, so the view cannot move and a pan
 * would request no tiles.
 *
 * The tile size is a Map option. This script rewrites the mobile/desktop
 * **defaults** in `src/MapOptions.ts` for each size and restores the source
 * afterwards. A stored `tileSize` option in the host layout would win, so reset
 * that option before comparing sizes.
 * Only run it with the dev server (`npm run dev`) serving `localhost:5173`.
 *
 * Usage (from `websource`):
 *
 *   node ACE_TacPhone_Map/test/benchmark/map-terrain-live.mjs
 *   node ACE_TacPhone_Map/test/benchmark/map-terrain-live.mjs --sizes 128,256 --runs 2
 *   node ACE_TacPhone_Map/test/benchmark/map-terrain-live.mjs --headed --page-url http://localhost:5173/
 *
 * It does not run as part of `test:map` or `test:all`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PAGE_URL, launchBrowser } from '../../../ACE_TacPhone_Main/test/lib/browser.mjs';
import { SkipError } from '../../../ACE_TacPhone_Main/test/lib/skip.mjs';
import { launchHostPage, openAppThroughChooser } from '../../../ACE_TacPhone_Main/test/lib/host-page.mjs';
import { getMapViewDebugState, waitForMapView } from '../lib/map-page.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAP_OPTIONS_PATH = path.join(APP_ROOT, 'src', 'MapOptions.ts');
const TILE_SIZE_PATTERN = /const (DEFAULT_TERRAIN_TILE_SIZE_(?:MOBILE|DESKTOP)) = \d+;/g;

const MAP_APP = 'ACE_TacPhone_Map';
const QUIET_MS = 400;
const SETTLE_TIMEOUT_MS = 180000;
/** Pan/zoom phases should only need a few seconds once the map is loaded. */
const PHASE_TIMEOUT_MS = 30000;

/** Collects > 50 ms tasks; the page clears the list between phases. */
const LONG_TASK_SCRIPT = `
window.__TACPHONE_LONG_TASKS__ = [];
try {
    const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            window.__TACPHONE_LONG_TASKS__.push(entry.duration);
        }
    });
    observer.observe({ entryTypes: ['longtask'] });
} catch {
    // longtask is Chrome-only; the benchmark then reports zero.
}
`;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function readOption(argv, name, fallback) {
    const index = argv.indexOf(`--${name}`);
    return index !== -1 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

/** Rewrites the default constants and returns the original file text. */
function setTileSize(size) {
    const source = fs.readFileSync(MAP_OPTIONS_PATH, 'utf8');
    if (!source.includes('DEFAULT_TERRAIN_TILE_SIZE_MOBILE')
        || !source.includes('DEFAULT_TERRAIN_TILE_SIZE_DESKTOP')) {
        throw new Error(`Could not find the terrain tile-size defaults in ${MAP_OPTIONS_PATH}`);
    }

    fs.writeFileSync(MAP_OPTIONS_PATH, source.replace(
        TILE_SIZE_PATTERN,
        (_, name) => `const ${name} = ${size};`,
    ));

    return source;
}

/** Compact one-line description of why a state is not settled. */
function describeState(state) {
    if (!state) {
        return 'no debug state (the Map app never mounted?)';
    }

    const layers = state.tiles
        .filter((tile) => tile.pending || tile.loading > 0)
        .map((tile) => `${tile.name}: pending=${tile.pending} loading=${tile.loading}`
            + ` started=${tile.started} finished=${tile.finished} error=${tile.error ?? '-'}`);

    return `ready=${state.ready} resolution=${state.resolution}`
        + ` pendingLayers=${state.pendingLayers}`
        + ` terrainDataReady=${state.terrainDataReady}`
        + ` loading=${state.loading} started=${state.started}`
        + ` targetConnected=${state.mapTargetConnected}`
        + ` size=${state.mapSize ? state.mapSize.join('x') : '-'}`
        + ` quietForMs=${state.quietForMs}`
        + (state.terrainError ? ` terrainError=${state.terrainError}` : '')
        + (layers.length > 0 ? `; unresolved: ${layers.join(', ')}` : '');
}

/** Waits for `predicate(state)` and returns the elapsed milliseconds. */
async function waitForState(page, predicate, timeoutMs, startedAt = Date.now(), label = 'the Map state') {
    let lastState = null;

    while (Date.now() - startedAt < timeoutMs) {
        lastState = await getMapViewDebugState(page);
        if (lastState && predicate(lastState)) {
            return { state: lastState, elapsedMs: Date.now() - startedAt };
        }

        await sleep(25);
    }

    throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${label}: ${describeState(lastState)}`,
    );
}

function isSettled(state) {
    return state.ready
        && state.terrainDataReady
        && state.pendingLayers === 0
        && state.loading === 0;
}

function sumStarted(state) {
    return state.tiles.reduce((total, tile) => total + tile.started, 0);
}

async function takeLongTasks(page) {
    return page.evaluate(() => {
        const tasks = window.__TACPHONE_LONG_TASKS__ ?? [];
        window.__TACPHONE_LONG_TASKS__ = [];
        return {
            count: tasks.length,
            maxMs: tasks.length > 0 ? Math.max(...tasks) : 0,
            totalMs: tasks.reduce((total, value) => total + value, 0),
        };
    });
}

/** One timed Map open at the current tile-size default. */
async function measureRun(pageUrl, { headed, tileSize }) {
    const host = await launchHostPage({ pageUrl, headed });
    const { browser, page, consoleErrors } = host;
    const terrainLogs = [];

    try {
        await page.addScriptTag({ content: LONG_TASK_SCRIPT }).catch(() => undefined);
        const openStartedAt = Date.now();

        // Keep the compact host-side terrain log so a stalled transfer can be
        // diagnosed without re-running headed.
        page.on('console', (message) => {
            const text = message.text();
            if (text.startsWith('[TacPhone terrain]')) {
                terrainLogs.push(`${Date.now() - openStartedAt} ms ${text}`);
            }
        });

        await openAppThroughChooser(page, MAP_APP, { tileTitle: 'Map' });

        await page.waitForFunction(
            () => typeof window.__TACPHONE_MAP_TEST__?.getViewState === 'function',
            null,
            { timeout: 30000 },
        );

        const { state: settled, elapsedMs: settledMs } = await waitForState(
            page,
            (state) => {
                if (state.terrainError) {
                    throw new Error(`The Map reported a terrain error: ${state.terrainError}`);
                }

                return isSettled(state) && state.quietForMs >= QUIET_MS;
            },
            SETTLE_TIMEOUT_MS,
            openStartedAt,
            'the initial terrain load',
        );

        const loadLongTasks = await takeLongTasks(page);

        const view = await waitForMapView(
            page,
            (state) => Number.isFinite(state.resolution) && state.resolution > 0,
            'the Map service view',
            15000,
        );
        console.log(`    initial view: x=${view.x} y=${view.y} resolution=${view.resolution}`);
        const layers = settled.tiles.map((tile) => ({
            name: tile.name,
            priority: tile.priority,
            activatedAfterMs: tile.activatedAfterMs,
            firstTileStartMs: tile.firstTileStartMs,
            started: tile.started,
            maxResolution: tile.maxResolution,
            lodVisible: tile.lodVisible,
        }));

        // Zoom two levels in first. A single level in can still snap to the
        // current tile-grid level (OL picks the nearest resolution), which would
        // reuse every cached tile and look like "no new tiles". Two levels in
        // always crosses a grid boundary.
        const zoomInStartedAt = Date.now();
        const beforeZoomIn = sumStarted(settled);
        await page.evaluate((target) => {
            window.TacPhone.interApp.list('map')[0]?.api.flyTo(target);
        }, {
            x: view.x,
            y: view.y,
            resolution: view.resolution / 4,
            animate: false,
        });

        const zoomIn = await waitForState(
            page,
            (state) => sumStarted(state) > beforeZoomIn
                && state.loading === 0
                && state.quietForMs >= QUIET_MS,
            PHASE_TIMEOUT_MS,
            zoomInStartedAt,
            'the zoom-in tiles',
        );
        const zoomInLongTasks = await takeLongTasks(page);
        const zoomedView = await waitForMapView(
            page,
            (state) => Number.isFinite(state.resolution) && state.resolution > 0,
            'the zoomed Map service view',
            15000,
        );

        // Pan roughly 400 px and wait until the new tiles arrive and settle.
        const panStartedAt = Date.now();
        const beforePan = sumStarted(zoomIn.state);
        await page.evaluate((target) => {
            window.TacPhone.interApp.list('map')[0]?.api.flyTo(target);
        }, {
            // Pan roughly 400 px, independent of the panel size.
            x: zoomedView.x + zoomedView.resolution * 400,
            y: zoomedView.y,
            resolution: zoomedView.resolution,
            animate: false,
        });

        const pan = await waitForState(
            page,
            (state) => sumStarted(state) > beforePan
                && state.loading === 0
                && state.quietForMs >= QUIET_MS,
            PHASE_TIMEOUT_MS,
            panStartedAt,
            'the pan tiles',
        );
        const panLongTasks = await takeLongTasks(page);
        const pannedView = await waitForMapView(
            page,
            (state) => Number.isFinite(state.resolution) && state.resolution > 0,
            'the panned Map service view',
            15000,
        );

        // Deep zoom (four levels below the fit) so the heavy layers pass their
        // LOD cut-off and actually request tiles.
        const deepStartedAt = Date.now();
        const beforeDeep = sumStarted(pan.state);
        await page.evaluate((target) => {
            window.TacPhone.interApp.list('map')[0]?.api.flyTo(target);
        }, {
            x: pannedView.x,
            y: pannedView.y,
            resolution: view.resolution / 16,
            animate: false,
        });

        const deep = await waitForState(
            page,
            (state) => sumStarted(state) > beforeDeep
                && state.loading === 0
                && state.quietForMs >= QUIET_MS,
            PHASE_TIMEOUT_MS,
            deepStartedAt,
            'the deep-zoom tiles',
        );
        const deepLongTasks = await takeLongTasks(page);

        if (consoleErrors.length > 0) {
            throw new Error(`The Map page raised: ${consoleErrors.join(' | ')}`);
        }

        const deepLayers = deep.state.tiles.map((tile) => ({
            name: tile.name,
            maxResolution: tile.maxResolution,
            lodVisible: tile.lodVisible,
            started: tile.started,
        }));

        return {
            tileSize,
            tileCount: settled.tiles.length,
            openMs: settledMs,
            stalled: settled.quietForMs,
            layers,
            zoomInMs: zoomIn.elapsedMs,
            zoomInTiles: sumStarted(zoomIn.state) - beforeZoomIn,
            panMs: pan.elapsedMs,
            panTiles: sumStarted(pan.state) - beforePan,
            deepMs: deep.elapsedMs,
            deepTiles: sumStarted(deep.state) - beforeDeep,
            deepLayers,
            loadLongTasks,
            zoomInLongTasks,
            panLongTasks,
            deepLongTasks,
        };
    } catch (error) {
        const details = [];
        if (terrainLogs.length > 0) {
            details.push(`terrain transfer log (last 20):\n  ${terrainLogs.slice(-20).join('\n  ')}`);
        }
        if (consoleErrors.length > 0) {
            details.push(`page errors:\n  ${consoleErrors.join('\n  ')}`);
        }

        if (details.length > 0) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${message}\n${details.join('\n')}`);
        }

        throw error;
    } finally {
        await page.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
    }
}

function formatMs(value) {
    return value === null || value === undefined ? '   -' : value.toFixed(0).padStart(5);
}

function printRun(run) {
    console.log(`\n  tile ${run.tileSize} px: open ${run.openMs} ms, ` +
        `zoom-in ${run.zoomInMs} ms (${run.zoomInTiles} tiles), ` +
        `pan ${run.panMs} ms (${run.panTiles} tiles), ` +
        `deep ${run.deepMs} ms (${run.deepTiles} tiles)`);
    console.log(`    long tasks: load ${run.loadLongTasks.count} (max ${run.loadLongTasks.maxMs.toFixed(0)} ms), ` +
        `zoom-in ${run.zoomInLongTasks.count} (max ${run.zoomInLongTasks.maxMs.toFixed(0)} ms), ` +
        `pan ${run.panLongTasks.count} (max ${run.panLongTasks.maxMs.toFixed(0)} ms), ` +
        `deep ${run.deepLongTasks.count} (max ${run.deepLongTasks.maxMs.toFixed(0)} ms)`);

    const deep = new Map(run.deepLayers.map((layer) => [layer.name, layer]));

    for (const layer of run.layers) {
        const lod = layer.lodVisible ? 'visible' : 'LOD-hidden';
        const deepLayer = deep.get(layer.name);
        const deepState = deepLayer
            ? `${deepLayer.lodVisible ? 'visible' : 'LOD-hidden'} at ${deepLayer.started} tiles total`
            : 'not delivered';

        console.log(
            `    ${layer.name.padEnd(16)} rank ${String(layer.priority).padStart(4)}`
            + `  activated ${formatMs(layer.activatedAfterMs)} ms`
            + `  first tile ${formatMs(layer.firstTileStartMs)} ms`
            + `  ${String(layer.started).padStart(3)} tiles  ${lod}`
            + `  | deep: ${deepState}`,
        );
    }
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
    const argv = process.argv.slice(2);
    const headed = argv.includes('--headed');
    const pageUrl = readOption(argv, 'page-url', DEFAULT_PAGE_URL);
    const sizes = readList(argv, 'sizes', [128, 256, 512]);
    const runs = Math.round(readNumber(argv, 'runs', 1));

    let browser;
    try {
        // Fail fast (and without touching the source) when no browser exists.
        browser = await launchBrowser({ headed });
        await browser.close();
        browser = undefined;
    } catch (error) {
        if (error instanceof SkipError) {
            console.error(`SKIP ${error.message}`);
            process.exitCode = 1;
            return;
        }

        throw error;
    }

    const originalSource = fs.readFileSync(MAP_OPTIONS_PATH, 'utf8');
    const results = [];

    try {
        for (const size of sizes) {
            setTileSize(size);
            // Let the dev server invalidate the changed module.
            await sleep(750);

            for (let run = 0; run < runs; run += 1) {
                const result = await measureRun(pageUrl, { headed, tileSize: size });
                results.push(result);
                printRun(result);
            }
        }
    } catch (error) {
        // Report the real failure; a `finally` error must not mask it.
        console.error('Benchmark run failed:', error);
        process.exitCode = 1;
    } finally {
        fs.writeFileSync(MAP_OPTIONS_PATH, originalSource);
        await browser?.close().catch(() => undefined);
    }

    if (runs > 1) {
        console.log('\nMedians:');
        for (const size of sizes) {
            const runsForSize = results.filter((run) => run.tileSize === size);
            if (runsForSize.length === 0) {
                continue;
            }

            console.log(`  ${size} px: open ${median(runsForSize.map((run) => run.openMs))} ms, `
                + `zoom-in ${median(runsForSize.map((run) => run.zoomInMs))} ms, `
                + `pan ${median(runsForSize.map((run) => run.panMs))} ms, `
                + `deep ${median(runsForSize.map((run) => run.deepMs))} ms`);
        }
    }

    console.log('\nTile-size defaults restored.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
