/**
 * Shared Playwright bootstrap and protocol helpers for the Map browser tests.
 *
 * The helpers open the TacPhone host page, open the Map panel, wait for the
 * debug state hook and expose the marker requests the app itself uses. They do
 * not import app source; every game interaction goes through the real
 * `window.TacPhone.networking` contract.
 */

import { assert } from './assertions.mjs';
import { launchBrowser } from './browser.mjs';
import { skip } from './skip.mjs';

export const MAP_APP = 'ACE_TacPhone_Map';
/** Milliseconds without a terrain tile event before the map counts as drawn. */
export const TERRAIN_QUIET_MS = 750;

/**
 * Launches the installed Chrome channel and opens the TacPhone host page.
 * Waits for the transport to be ready; app opening is left to the caller.
 * @param {{ pageUrl: string, headed?: boolean, slowMo?: number, hasTouch?: boolean, viewport?: { width: number, height: number } }} options
 */
export async function launchHostPage({
    pageUrl,
    headed = false,
    slowMo = 0,
    hasTouch = false,
    viewport = { width: 1280, height: 900 },
}) {
    const browser = await launchBrowser({ headed, slowMo });
    const context = await browser.newContext({ viewport, hasTouch });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    try {
        await page.bringToFront();
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForFunction(() => Boolean(window.TacPhone?.networking), null, { timeout: 20000 });
        await page.evaluate(() => window.TacPhone.networking.WhenReady());

        return { browser, context, page, consoleErrors };
    } catch (error) {
        await browser.close().catch(() => {});
        throw error;
    }
}

/**
 * Creates a new tab in the given tabset with the flexlayout "Add" button and
 * selects an app tile in the app chooser. Only the selected tab's chooser is
 * visible; the hidden chooser grids of other tabs must not be clicked.
 */
export async function openAppThroughChooser(page, appName, options = {}) {
    const { tileTitle = appName, tabsetIndex = 0 } = options;

    await page.waitForFunction(
        (app) => Boolean(window.TacPhone?.apps?.knownPanels?.has?.(app)),
        appName,
        { timeout: 30000 },
    ).catch(() => {});

    const appLoaded = await page.evaluate(
        (app) => window.TacPhone?.apps?.knownPanels?.has(app) === true,
        appName,
    ).catch(() => false);
    if (!appLoaded) {
        skip(`The host page did not load ${appName}; the app is not available in this build.`);
    }

    const addButton = page.getByTitle('Add').nth(tabsetIndex);
    await addButton.waitFor({ state: 'visible', timeout: 10000 });

    const tabsBefore = await page.locator('.flexlayout__tab_button').count();
    await addButton.click();
    await page.waitForFunction(
        (before) => document.querySelectorAll('.flexlayout__tab_button').length > before,
        tabsBefore,
        { timeout: 10000 },
    );

    const tile = page
        .getByTitle(`${tileTitle} · ${appName}`)
        .filter({ visible: true })
        .first();
    await tile.waitFor({ state: 'visible', timeout: 10000 });
    await tile.click();
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
    const host = await launchHostPage({ pageUrl, headed, slowMo, hasTouch, viewport });
    const { browser, page } = host;

    try {
        await openAppThroughChooser(page, MAP_APP, { tileTitle: 'Map' });

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
            (quietMs) => {
                const state = window.__TACPHONE_MAP_TEST__?.getViewState?.();
                return Boolean(state?.ready && state.settled && state.quietForMs >= quietMs);
            },
            TERRAIN_QUIET_MS,
            { timeout: 60000 },
        );
        await page.waitForFunction(
            () => window.__TACPHONE_MAP_TEST__.getMapState() !== null,
            null,
            { timeout: 30000 },
        );

        const viewState = await page.evaluate(() => window.__TACPHONE_MAP_TEST__.getViewState());
        log?.(`Map opened through a new tab and the app chooser; terrain tiles: ${viewState.finished}/${viewState.started} loaded, ${viewState.loading} loading, ${viewState.errored} errors across ${viewState.tiles.length} layers`);

        const gameInfo = await page.evaluate(() => window.TacPhone.gameInfo.whenReady());

        return { ...host, gameInfo };
    } catch (error) {
        await browser.close().catch(() => {});
        throw error;
    }
}

/** Activates the tab of a mounted panel by panel id. */
export async function activatePanelTab(page, panelId) {
    const tabId = await page.evaluate((id) => {
        const panel = window.TacPhone.panels.list().find((entry) => entry.panelId === id && entry.mounted);
        return panel?.tabId ?? null;
    }, panelId);

    if (!tabId) {
        return false;
    }

    await page.evaluate((id) => window.TacPhone.panels.activate(id), tabId);
    return true;
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

/** Sends one request for any app from the page. */
export function requestApp(page, app, command, payload = {}) {
    return page.evaluate(
        ({ appName, cmd, data }) => window.TacPhone.networking.Request({ a: appName, c: cmd, ...data }),
        { appName: app, cmd: command, data: payload },
    );
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
