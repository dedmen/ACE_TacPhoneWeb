/**
 * Browser checks for the progressive terrain-layer load order and the heavy
 * `objects` / `countlines` level-of-detail cut-off.
 *
 * The Map schedules terrain layers in a fixed priority order (terrain first,
 * then roads, town names, airports, forests, rocks, mountains, unknown layers
 * and finally the heavy `objects` / `countlines` SVGs) and activates the heavy
 * layers only after the complete reply and every light layer. Heavy layers are
 * hidden at or above their cut-off resolution, so a whole-map view never queues
 * their tiles.
 *
 * Everything is read from `window.__TACPHONE_MAP_TEST__.getViewState()`; the
 * scenario never inspects pixels and never depends on where a map designer put
 * features. A terrain without `objects` / `countlines` only skips those checks.
 *
 *   $env:TACPHONE_TEST_URL = 'http://localhost:5173/'
 *   npm run test:map -- --scenario map-tiles --slow
 */

import { assert, equal } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    getMapView,
    getMapViewDebugState,
    openMapPage,
    waitForMapViewDebugState,
} from '../lib/map-page.mjs';

export const name = 'map-tiles';
export const kind = 'browser';
export const description = 'Terrain layer priority and heavy-layer LOD';

/** Extra resolution above `objects.maxResolution` for the coarse view. */
const COARSE_MARGIN = 8;
/** `objects` cutoff assumed when the map has no `objects` layer (matches `countlines`). */
const FALLBACK_HEAVY_RESOLUTION = 12;
/** Deep view resolution for the positive LOD check; the view clamps if needed. */
const DEEP_RESOLUTION = 0.5;
/** How long the coarse view must stay still before its tile counters count. */
const COARSE_SETTLE_MS = 1000;
const COARSE_TIMEOUT_MS = 15000;
const DEEP_TIMEOUT_MS = 30000;
/** Allowed jitter between two activation timestamps that must be non-decreasing. */
const ACTIVATION_ORDER_SLACK_MS = 1;
/** Lowercase terrain layer names that use LOD. */
const HEAVY_NAMES = ['objects', 'countlines'];

/** Logs a skipped check even when the suite runs without --verbose. */
function note(log, message) {
    if (log) {
        log(message);
    } else {
        console.log(`  ${message}`);
    }
}

/** Finds a terrain layer by its case-insensitive name. */
function tileByName(tiles, wanted) {
    return tiles.find(
        (tile) => typeof tile.name === 'string' && tile.name.toLowerCase() === wanted,
    ) ?? null;
}

/** Present heavy layers in `HEAVY_NAMES` order. */
function heavyTiles(tiles) {
    return HEAVY_NAMES
        .map((wanted) => tileByName(tiles, wanted))
        .filter((tile) => tile !== null);
}

/** Moves the Map view through the public `map` service API. */
function flyTo(page, { x, y, resolution }) {
    return page.evaluate((target) => {
        window.TacPhone.interApp.list('map')[0]?.api.flyTo({ ...target, animate: false });
    }, { x, y, resolution });
}

export async function run({ pageUrl, options, log }) {
    const { browser, page, consoleErrors } = await openMapPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
        log,
    });

    const originalView = await getMapView(page).catch(() => null);

    try {
        // ---- priority order immediately after open ----------------------
        const state = await getMapViewDebugState(page);
        assert(state, 'The Map debug state is not available');
        equal(state.ready, true, 'The Map view should be ready');
        assert(state.tiles.length > 0, 'The Map reported no terrain layers');
        equal(state.pendingLayers, 0, 'Every terrain layer should be resolved once the map settled');

        log?.(`${state.tiles.length} terrain layers: ${state.tiles.map((tile) => `${tile.name}@${tile.priority}`).join(', ')}`);

        for (let index = 1; index < state.tiles.length; index += 1) {
            const previous = state.tiles[index - 1];
            const current = state.tiles[index];
            assert(
                current.priority >= previous.priority,
                `Terrain layers are not in priority order: "${previous.name}" (${previous.priority}) before "${current.name}" (${current.priority})`,
            );
        }

        // Layers whose cut-off is at or above the fit resolution (objects,
        // countLines and mountains) must not request any tiles there.
        if (typeof state.resolution === 'number') {
            for (const tile of state.tiles) {
                const hidden = Number.isFinite(tile.maxResolution)
                    && state.resolution >= tile.maxResolution;
                if (!hidden) {
                    continue;
                }

                equal(
                    tile.started,
                    0,
                    `"${tile.name}" started tiles while LOD-hidden at resolution ${state.resolution}`,
                );
                equal(
                    tile.lodVisible,
                    false,
                    `"${tile.name}" should be LOD-hidden at resolution ${state.resolution}`,
                );
            }
        }

        const terrainIndex = state.tiles.findIndex(
            (tile) => typeof tile.name === 'string' && tile.name.toLowerCase() === 'terrain',
        );
        if (terrainIndex >= 0) {
            equal(terrainIndex, 0, 'The terrain layer should be first in the load order');
        }

        // The heavy layers wait for the complete reply and for every light
        // layer, so they must activate after all light layers. Light layers may
        // finish decoding slightly out of rank order because two decodes are in
        // flight, so only the heavy boundary is asserted here.
        const lightActivated = state.tiles
            .filter((tile) => !HEAVY_NAMES.includes(String(tile.name).toLowerCase()))
            .map((tile) => tile.activatedAfterMs)
            .filter((value) => typeof value === 'number');
        const lastLightActivation = lightActivated.length > 0
            ? Math.max(...lightActivated)
            : null;

        for (const tile of state.tiles) {
            if (!HEAVY_NAMES.includes(String(tile.name).toLowerCase())
                || tile.activatedAfterMs === null
                || lastLightActivation === null) {
                continue;
            }

            assert(
                lastLightActivation <= tile.activatedAfterMs + ACTIVATION_ORDER_SLACK_MS,
                `Heavy layer "${tile.name}" activated at ${tile.activatedAfterMs} ms, before the last light layer at ${lastLightActivation} ms`,
            );
        }

        // ---- heavy layers: LOD at coarse and deep zoom ------------------
        const presentHeavy = heavyTiles(state.tiles);

        if (presentHeavy.length === 0) {
            note(log, 'This map has no objects/countlines terrain layer; skipping the heavy-layer LOD checks');
        } else {
            await runHeavyChecks(page, state, presentHeavy, log);
        }

        // ---- layer switcher lists every terrain layer once --------------
        await runLayerSwitcherCheck(page, state);

        if (consoleErrors.length > 0) {
            throw new Error(`The Map page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        // Restore the view the scenario found, then close the page/browser.
        try {
            if (originalView) {
                await flyTo(page, originalView);
            }
        } catch {
            // Closing the page below is more important than the restored view.
        }

        await page.close();
        await browser.close();
    }
}

/**
 * Asserts that the heavy layers stop starting tiles at the coarse view and
 * start using their LOD layer again at a deep view.
 */
async function runHeavyChecks(page, state, presentHeavy, log) {
    const view = await getMapView(page);
    assert(view, 'The Map view disappeared before the coarse check');

    const objectsTile = tileByName(state.tiles, 'objects');
    const objectsMax = Number.isFinite(objectsTile?.maxResolution)
        ? objectsTile.maxResolution
        : FALLBACK_HEAVY_RESOLUTION;
    const coarseTarget = objectsMax + COARSE_MARGIN;

    await flyTo(page, { x: view.x, y: view.y, resolution: coarseTarget });

    const coarseState = await waitForMapViewDebugState(
        page,
        (next) => typeof next.resolution === 'number' && next.resolution >= objectsMax,
        `the coarse view (resolution >= ${objectsMax})`,
        COARSE_TIMEOUT_MS,
    ).catch(() => null);

    if (!coarseState) {
        const clamped = await getMapViewDebugState(page);
        note(log, `The view cannot zoom out to resolution ${objectsMax} (clamped to ${clamped?.resolution ?? '?'}); skipping the coarse LOD check`);
    } else {
        // Let any in-flight light tile loads finish so they cannot bump a
        // heavy counter during the sample window.
        const coarseIdle = await waitForMapViewDebugState(
            page,
            (next) => next.settled && next.loading === 0,
            'the coarse view to finish loading',
            COARSE_TIMEOUT_MS,
        ).catch(() => coarseState);

        const resolution = coarseIdle.resolution;
        const hiddenHeavy = presentHeavy.filter(
            (tile) => typeof resolution === 'number' && resolution >= tile.maxResolution,
        );

        if (hiddenHeavy.length < presentHeavy.length) {
            note(log, `The coarse view is resolution ${resolution}, still below the cut-off of ${presentHeavy
                .filter((tile) => !hiddenHeavy.includes(tile))
                .map((tile) => tile.name)
                .join(', ')}; only checking the layers that are hidden`);
        }

        const beforeStarted = new Map(
            hiddenHeavy.map((tile) => [
                tile.name.toLowerCase(),
                tileByName(coarseIdle.tiles, tile.name.toLowerCase())?.started ?? 0,
            ]),
        );

        await page.waitForTimeout(COARSE_SETTLE_MS);
        const afterState = await getMapViewDebugState(page);
        assert(afterState, 'The Map debug state disappeared at the coarse view');

        for (const tile of hiddenHeavy) {
            const key = tile.name.toLowerCase();
            const afterTile = tileByName(afterState.tiles, key);
            assert(afterTile, `The ${tile.name} layer disappeared from the debug state`);

            equal(
                afterTile.started,
                beforeStarted.get(key),
                `The coarse view started new ${tile.name} tiles while the layer is LOD-hidden`,
            );
            equal(
                afterTile.lodVisible,
                false,
                `The ${tile.name} layer should be hidden at resolution ${afterState.resolution} (maxResolution ${afterTile.maxResolution})`,
            );
        }

        if (hiddenHeavy.length > 0) {
            log?.(`Coarse view at ${afterState.resolution}: ${hiddenHeavy.map((tile) => `${tile.name} hidden`).join(', ')}`);
        }
    }

    // ---- deep view: the heavy layers must become visible again ----------
    const deepThreshold = Math.min(
        ...presentHeavy
            .map((tile) => tile.maxResolution)
            .filter((value) => Number.isFinite(value)),
    );

    if (!Number.isFinite(deepThreshold)) {
        note(log, 'The heavy layers report no finite LOD cut-off; skipping the deep LOD check');
        return;
    }

    await flyTo(page, { x: view.x, y: view.y, resolution: DEEP_RESOLUTION });

    const deepViewState = await waitForMapViewDebugState(
        page,
        (next) => typeof next.resolution === 'number' && next.resolution < deepThreshold,
        `the view to zoom below the heavy-layer cut-off (${deepThreshold})`,
        COARSE_TIMEOUT_MS,
    ).catch(() => null);

    if (!deepViewState) {
        const clamped = await getMapViewDebugState(page);
        note(log, `The view cannot zoom below resolution ${deepThreshold} (clamped to ${clamped?.resolution ?? '?'}); skipping the deep LOD check`);
        return;
    }

    const heavyKeys = presentHeavy.map((tile) => tile.name.toLowerCase());

    await waitForMapViewDebugState(
        page,
        (next) => heavyKeys.every((key) => {
            const tile = tileByName(next.tiles, key);
            return tile !== null && tile.lodVisible === true && tile.started > 0;
        }),
        'the heavy layers to become LOD-visible and start tiles',
        DEEP_TIMEOUT_MS,
    );

    const deepLoaded = await waitForMapViewDebugState(
        page,
        (next) => heavyKeys.every((key) => {
            const tile = tileByName(next.tiles, key);
            return tile !== null && tile.loading === 0 && tile.finished > 0;
        }),
        'the deep-view heavy tiles to finish loading',
        DEEP_TIMEOUT_MS,
    );

    log?.(`Deep view at ${deepLoaded.resolution}: ${heavyKeys.join(', ')} visible and loaded`);
}

/** Every terrain layer must be listed exactly once in the layer switcher. */
async function runLayerSwitcherCheck(page, state) {
    const toggleTitle = await page.evaluate(
        () => window.TacPhone.localization.t('STR_ACE_Tacphone_Map_Layers_Toggle'),
    );
    const toggles = page.getByTitle(toggleTitle);
    assert((await toggles.count()) > 0, 'The Map should render the layer switcher button');

    const toggle = toggles.first();
    await toggle.click();
    await page.waitForFunction(
        (title) => Array.from(document.querySelectorAll('button[aria-expanded]'))
            .some((button) => button.getAttribute('title') === title
                && button.getAttribute('aria-expanded') === 'true'),
        toggleTitle,
        { timeout: 5000 },
    );

    const labels = await page.evaluate(
        () => Array.from(document.querySelectorAll('label[for^="layer-"]'))
            .map((label) => label.textContent?.trim() ?? ''),
    );

    for (const layerName of new Set(state.tiles.map((tile) => String(tile.name).trim()))) {
        const matches = labels.filter((label) => label === layerName).length;
        equal(matches, 1, `The layer switcher should list "${layerName}" exactly once`);
    }

    await toggle.click();
    await page.waitForFunction(
        (title) => !Array.from(document.querySelectorAll('button[aria-expanded]'))
            .some((button) => button.getAttribute('title') === title
                && button.getAttribute('aria-expanded') === 'true'),
        toggleTitle,
        { timeout: 5000 },
    );
}
