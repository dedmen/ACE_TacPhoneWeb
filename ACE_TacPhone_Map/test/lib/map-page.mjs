/**
 * Map-specific Playwright helpers for the Map browser tests.
 *
 * The generic host helpers (`launchHostPage`, `openAppThroughChooser`,
 * `activatePanelTab`, `requestApp`) live in the shared harness at
 * `ACE_TacPhone_Main/test/lib/host-page.mjs`; this file only keeps what is about
 * the Map app: opening the panel, reading its debug state and the marker /
 * polyline requests the app itself uses.
 *
 * It does not import app source; every game interaction goes through the real
 * `window.TacPhone.networking` contract.
 */

import { assert } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { launchHostPage, openAppThroughChooser, requestApp } from '../../../ACE_TacPhone_Main/test/lib/host-page.mjs';

export const MAP_APP = 'ACE_TacPhone_Map';
/** Milliseconds without a terrain tile event before the map counts as drawn. */
export const TERRAIN_QUIET_MS = 750;

/**
 * Opens one Map-family panel on an already launched host page and waits until
 * the terrain view and all visible terrain tiles have finished loading.
 *
 * `tileTitle` is the app chooser's tile title (`Map`, `GPS`, …); pass a
 * function to resolve a localized title after the page is up.
 * @param {import('playwright').Page} page
 * @param {{ appName: string, tileTitle: string | ((page: any) => Promise<string>), label?: string, log?: (message: string) => void, waitForMapState?: boolean }} options
 */
export async function openPanelOnPage(page, {
    appName,
    tileTitle,
    label = appName,
    log = undefined,
    waitForMapState = false,
    waitForQuiet = true,
}) {
    const title = typeof tileTitle === 'function' ? await tileTitle(page) : tileTitle;

    await openAppThroughChooser(page, appName, { tileTitle: title });

    await page.waitForFunction(
        () => document.querySelectorAll('.ol-viewport').length > 0,
        null,
        { timeout: 30000 },
    );
    await page.waitForFunction(
        () => typeof window.__TACPHONE_MAP_TEST__?.getViewState === 'function',
        null,
        { timeout: 30000 },
    );
    await page.waitForFunction(
        ({ quietMs, requireQuiet }) => {
            const state = window.__TACPHONE_MAP_TEST__?.getViewState?.();
            return Boolean(
                state?.ready
                && (!requireQuiet || (state.settled && state.quietForMs >= quietMs)),
            );
        },
        { quietMs: TERRAIN_QUIET_MS, requireQuiet: waitForQuiet },
        { timeout: 60000 },
    );

    if (waitForMapState) {
        await page.waitForFunction(
            () => window.__TACPHONE_MAP_TEST__.getMapState() !== null,
            null,
            { timeout: 30000 },
        );
    }

    const viewState = await page.evaluate(() => window.__TACPHONE_MAP_TEST__.getViewState());
    log?.(`${label} opened through a new tab and the app chooser; terrain tiles: ${viewState.finished}/${viewState.started} loaded, ${viewState.loading} loading, ${viewState.errored} errors across ${viewState.tiles.length} layers`);

    return { viewState };
}

/**
 * Launches the host and opens one Map-family panel in it.
 * @param {string} pageUrl
 * @param {{ appName: string, tileTitle: string | ((page: any) => Promise<string>), label?: string, headed?: boolean, slowMo?: number, hasTouch?: boolean, viewport?: { width: number, height: number }, log?: (message: string) => void, waitForMapState?: boolean }} options
 */
export async function openPanelPage(pageUrl, {
    appName,
    tileTitle,
    label = appName,
    headed = false,
    slowMo = 0,
    hasTouch = false,
    viewport = { width: 1280, height: 900 },
    log = undefined,
    waitForMapState = false,
    waitForQuiet = true,
}) {
    const host = await launchHostPage({ pageUrl, headed, slowMo, hasTouch, viewport });
    const { browser, page } = host;

    try {
        await openPanelOnPage(page, {
            appName,
            tileTitle,
            label,
            log,
            waitForMapState,
            waitForQuiet,
        });

        const gameInfo = await page.evaluate(() => window.TacPhone.gameInfo.whenReady());

        return { ...host, gameInfo };
    } catch (error) {
        await browser.close().catch(() => {});
        throw error;
    }
}

/**
 * Launches the host, opens the Map through a new flexlayout tab and the app
 * chooser, then waits until the terrain view and all visible terrain tiles have
 * finished loading.
 * @param {{ pageUrl: string, headed?: boolean, slowMo?: number, hasTouch?: boolean, viewport?: { width: number, height: number } }} options
 */
export async function openMapPage({
    pageUrl,
    headed = false,
    slowMo = 0,
    hasTouch = false,
    viewport = { width: 1280, height: 900 },
    log = undefined,
}) {
    return openPanelPage(pageUrl, {
        appName: MAP_APP,
        tileTitle: 'Map',
        label: 'Map',
        headed,
        slowMo,
        hasTouch,
        viewport,
        log,
        waitForMapState: true,
    });
}

/** Current live Map debug state, or null when the panel is not mounted. */
export function getMapState(page) {
    return page.evaluate(() => window.__TACPHONE_MAP_TEST__?.getMapState() ?? null);
}

/** Current Map view through the `map` service, or null when no Map is mounted. */
export function getMapView(page) {
    return page.evaluate(() => {
        const info = window.TacPhone.interApp.list('map')[0];
        return info?.api?.getView?.() ?? null;
    });
}

/** Live terrain/highlight debug state, or null while no Map is mounted. */
export function getMapViewDebugState(page) {
    return page.evaluate(() => window.__TACPHONE_MAP_TEST__?.getViewState?.() ?? null);
}

/** Waits until the `map` service view satisfies `predicate` (evaluated in Node). */
export async function waitForMapView(page, predicate, description = 'Map view', timeout = 15000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
        const view = await getMapView(page);
        if (view && predicate(view)) {
            return view;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Timed out after ${timeout} ms waiting for ${description}`);
}

/**
 * Waits until the view stops animating (center and resolution unchanged for a
 * short period) and returns the settled state.
 */
export async function waitForMapViewStable(page, description = 'the Map view to settle', timeout = 8000) {
    const startedAt = Date.now();
    let previous = null;
    let stableSince = 0;

    while (Date.now() - startedAt < timeout) {
        const view = await getMapView(page);

        if (view) {
            const stable = previous !== null
                && Math.abs(view.x - previous.x) < 1e-6
                && Math.abs(view.y - previous.y) < 1e-6
                && Math.abs(view.resolution - previous.resolution) < 1e-9;

            if (stable) {
                if (Date.now() - stableSince >= 150) {
                    return view;
                }
            } else {
                previous = view;
                stableSince = Date.now();
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Timed out after ${timeout} ms waiting for ${description}`);
}

/** Waits until the terrain/highlight debug state satisfies `predicate`. */
export async function waitForMapViewDebugState(page, predicate, description = 'Map view state', timeout = 15000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
        const state = await getMapViewDebugState(page);
        if (state && predicate(state)) {
            return state;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Timed out after ${timeout} ms waiting for ${description}`);
}

/** Waits until `getMapState()` satisfies `predicate` (evaluated in Node). */
export async function waitForMapState(page, predicate, description = 'Map state', timeout = 15000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
        const state = await getMapState(page);
        if (state && predicate(state)) {
            return state;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timed out after ${timeout} ms waiting for ${description}`);
}

/** Sends one Map app request from the page. */
export function requestMap(page, command, payload = {}) {
    return requestApp(page, MAP_APP, command, payload);
}

/** `GetAllMarkers` as the app sees it: [name, type, color, dir, pos, text, shape, alpha, brush, size, channel, polyline]. */
export async function getAllMarkers(page) {
    const reply = await requestMap(page, 'GetAllMarkers');
    assert(Array.isArray(reply?.markers), 'GetAllMarkers did not return a markers array');
    return reply.markers;
}

export function findMarker(markers, name) {
    return markers.find((marker) => Array.isArray(marker) && marker[0] === name);
}

/** Creates an icon marker through the game and returns its generated name. */
export async function createMarker(page, marker) {
    const reply = await requestMap(page, 'CreateMarker', { marker });
    assert(typeof reply?.name === 'string' && reply.name !== '', 'CreateMarker did not return a marker name');
    return reply.name;
}

/** Deletes a marker, ignoring failures during cleanup. */
export async function deleteMarker(page, name) {
    await requestMap(page, 'DeleteMarker', { marker: name }).catch(() => undefined);
}

/** Waits until the Map layer contains a marker with this name. */
export async function waitForMarkerInLayer(page, name, timeout = 15000) {
    await page.waitForFunction(
        (markerName) => window.__TACPHONE_MAP_TEST__?.getMapState?.().markers
            .some((marker) => marker.name === markerName),
        name,
        { timeout },
    );
}

/** Waits for a marker to disappear from the Map layer. */
export async function waitForMarkerGone(page, name, timeout = 15000) {
    await page.waitForFunction(
        (markerName) => !window.__TACPHONE_MAP_TEST__?.getMapState?.().markers
            .some((marker) => marker.name === markerName),
        name,
        { timeout },
    );
}

/**
 * Waits until a polyline created after `knownNames` appears in GetAllMarkers.
 * The app pushes updates asynchronously, so the reply is polled.
 */
export async function waitForNewPolyline(page, knownNames, timeout = 20000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
        const markers = await getAllMarkers(page);
        const found = markers.find((marker) => (
            Array.isArray(marker)
            && !knownNames.has(marker[0])
            && typeof marker[11] === 'string'
            && marker[11] !== ''
        ));

        if (found) {
            return found;
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    throw new Error(`No new polyline marker appeared within ${timeout} ms`);
}

/** Converts a game `[r, g, b, a]` color (0..1) to `#rrggbbaa`. */
export function colorToHex(rgba) {
    const [r, g, b, a] = rgba;
    const toHex = (value) => Math.round(Number(value) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}`;
}

/** Parses an Arma `#(r,g,b,a)` color into numbers. */
export function parseArmaColor(value) {
    const match = /^#\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/.exec(value);
    if (!match) {
        return null;
    }

    return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] === undefined ? 1 : Number(match[4]),
    };
}
