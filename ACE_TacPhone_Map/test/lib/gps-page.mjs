/**
 * GPS-specific Playwright helpers for the Map browser tests.
 *
 * The generic host helpers live in `ACE_TacPhone_Main/test/lib/host-page.mjs`
 * and the shared Map helpers (panel opening, terrain readiness) in
 * `./map-page.mjs`; this file only adds what is about the GPS panel: opening it,
 * reading `window.__TACPHONE_MAP_TEST__.getGpsDebugState()`, calling the
 * `gps.*` test controls, resolving localized text and turning world
 * coordinates into viewport pixels.
 *
 * It does not import app source; every game interaction goes through the real
 * `window.TacPhone` contract and the debug hook.
 */

import { assert } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { openPanelOnPage, openPanelPage } from './map-page.mjs';

/** Panel id of the GPS app (`main.tsx` `GetTacPhoneApps`). */
export const GPS_PANEL_ID = 'ACE_TacPhone_Map_GPS';
/** Interest the GPS panel holds while mounted (`GpsModule.GPS_INTEREST`). */
export const GPS_INTEREST = 'ACE_TacPhone_Map.gps';
/** App name shown in the chooser tile (`GPS · ACE_TacPhone_Map`). */
export const GPS_APP_NAME = 'ACE_TacPhone_Map';

/**
 * Opens the GPS panel on an already launched host page.
 * Used by scenarios that must inspect the page before any panel is opened.
 * @param {import('playwright').Page} page
 * @param {{ log?: (message: string) => void }} options
 */
export async function openGpsPanelOnPage(page, { log = undefined } = {}) {
    const result = await openPanelOnPage(page, {
        appName: GPS_APP_NAME,
        tileTitle: gpsTitle,
        label: 'GPS',
        log,
        // A live GPS follows a moving player and keeps loading tiles; the
        // scenarios wait for the state/view they need themselves.
        waitForQuiet: false,
    });
    await ensurePanelOpen(page);
    return result;
}

/** The route editor is a floating panel behind a button. */
async function ensurePanelOpen(page) {
    const panel = page.getByTestId('gps-route-panel');
    if ((await panel.count()) === 0) {
        await page.getByTestId('gps-panel-toggle').click();
    }
    await panel.waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Resolves the localized GPS panel title after the base-game string has been
 * demand-loaded. The app metadata can be registered before `init()` finishes,
 * so reading `t()` immediately would return the raw key.
 */
async function gpsTitle(page) {
    await page.waitForFunction(
        () => window.TacPhone?.localization?.t('str_a3_gps1') !== 'str_a3_gps1',
        null,
        { timeout: 30000 },
    );
    return gpsT(page, 'str_a3_gps1');
}

/**
 * Launches the host, opens the GPS panel through the app chooser and waits for
 * the terrain view to finish loading.
 * @param {{ pageUrl: string, headed?: boolean, slowMo?: number, viewport?: { width: number, height: number }, log?: (message: string) => void }} options
 */
export async function openGpsPage({
    pageUrl,
    headed = false,
    slowMo = 0,
    viewport = { width: 1280, height: 900 },
    log = undefined,
    waitForQuiet = false,
}) {
    const result = await openPanelPage(pageUrl, {
        appName: GPS_APP_NAME,
        tileTitle: gpsTitle,
        label: 'GPS',
        headed,
        slowMo,
        viewport,
        log,
        waitForQuiet,
    });
    await ensurePanelOpen(result.page);
    return result;
}

/** Current live GPS debug state, or null when no GPS panel is mounted. */
export function getGpsDebug(page) {
    return page.evaluate(() => window.__TACPHONE_MAP_TEST__?.getGpsDebugState?.() ?? null);
}

/** Waits until `getGpsDebugState()` satisfies `predicate` (evaluated in Node). */
export async function waitForGpsDebug(page, predicate, description = 'GPS state', timeout = 15000) {
    const startedAt = Date.now();
    let last = null;

    while (Date.now() - startedAt < timeout) {
        last = await getGpsDebug(page);
        if (last && predicate(last)) {
            return last;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(
        `Timed out after ${timeout} ms waiting for ${description}`
        + `\n  last state: ${JSON.stringify(last)}`,
    );
}

/**
 * Calls one `gps.*` test control. Promise-returning controls are awaited by
 * Playwright, so `calculateRoute()` resolves to its boolean.
 */
export function gpsCall(page, method, ...args) {
    return page.evaluate(
        ({ name, callArgs }) => {
            const controls = window.__TACPHONE_MAP_TEST__?.gps;
            const fn = controls?.[name];
            return typeof fn === 'function' ? fn(...callArgs) : undefined;
        },
        { name: method, callArgs: args },
    );
}

/** Resolves a localized string in the page, so text assertions are language agnostic. */
export function gpsT(page, key, ...args) {
    return page.evaluate(
        ({ localizationKey, formatArgs }) => window.TacPhone.localization.t(localizationKey, ...formatArgs),
        { localizationKey: key, formatArgs: args },
    );
}

/** Viewport pixels of a world coordinate, or null when it is off-screen. */
export async function gpsPixel(page, coordinate) {
    const pixel = await gpsCall(page, 'getPixel', coordinate);
    if (pixel) {
        return pixel;
    }

    // Fallback for when OpenLayers reports no pixel (for example while the
    // panel is mid-resize): derive it from the published view state.
    const view = await page.evaluate(() => {
        const api = window.TacPhone.interApp.list('map')[0]?.api;
        return api?.getView?.() ?? null;
    });
    const box = await page.locator('.ol-viewport').first().boundingBox();
    if (!view || !box) {
        return null;
    }

    const rotation = (await getGpsDebug(page))?.mapRotation ?? 0;
    const dx = (coordinate[0] - view.x) / view.resolution;
    const dy = (view.y - coordinate[1]) / view.resolution;
    const radians = (rotation * Math.PI) / 180;
    const x = dx * Math.cos(radians) - dy * Math.sin(radians);
    const y = dx * Math.sin(radians) + dy * Math.cos(radians);
    return [box.width / 2 + x, box.height / 2 + y];
}

/** 2D distance between two `[x, y]` world points. */
export function distance(left, right) {
    return Math.hypot(left[0] - right[0], left[1] - right[1]);
}

/**
 * Terrain-relative point: `distanceM` metres from `base` along `angleDeg`
 * (clockwise from +Y, matching heading), clamped `margin` metres inside the
 * terrain bounds.
 * @param {[number, number]} base
 * @param {{ angleDeg: number, distanceM: number, bounds: { width: number, height: number }, margin?: number }} options
 * @returns {[number, number]}
 */
export function pointAt(base, { angleDeg, distanceM, bounds, margin = 60 }) {
    assert(bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height),
        'pointAt needs the terrain bounds');

    const radians = (angleDeg * Math.PI) / 180;
    const x = base[0] + Math.sin(radians) * distanceM;
    const y = base[1] + Math.cos(radians) * distanceM;
    const minX = Math.min(margin, bounds.width / 2);
    const minY = Math.min(margin, bounds.height / 2);

    return [
        Math.max(minX, Math.min(bounds.width - minX, x)),
        Math.max(minY, Math.min(bounds.height - minY, y)),
    ];
}
