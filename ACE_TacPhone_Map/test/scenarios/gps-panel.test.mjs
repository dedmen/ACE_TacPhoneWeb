/**
 * Browser checks for the GPS panel: HUD, live state, travel-mode detection,
 * option registration and the interests it holds.
 *
 * The scenario is layout independent: it asserts the DOM and the debug state,
 * never pixel content. Text is compared through `t('STR_...')` values, so it
 * survives a language switch.
 *
 * Footnote: the development mission spawns the player on foot, so the foot
 * baseline is the expected case. The in-vehicle cases are covered by the
 * opt-in `gps-interactive` scenario.
 *
 *   $env:TACPHONE_TEST_URL = 'http://localhost:5173/'
 *   npm run test:map -- --scenario gps-panel
 */

import { assert, equal, oneOf } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { launchHostPage, requestApp } from '../../../ACE_TacPhone_Main/test/lib/host-page.mjs';
import { skip } from '../../../ACE_TacPhone_Main/test/lib/skip.mjs';
import {
    getGpsDebug,
    gpsPixel,
    gpsT,
    openGpsPanelOnPage,
    waitForGpsDebug,
    GPS_INTEREST,
} from '../lib/gps-page.mjs';
import { waitForMapView } from '../lib/map-page.mjs';

export const name = 'gps-panel';
export const kind = 'browser';
export const description = 'GPS HUD, fix, travel-mode detection, options, interests and read-only markers';

const MAP_APP = 'ACE_TacPhone_Map';
const ROTATE_KEY = 'gpsRotateWithPlayer';
const REPATH_KEY = 'gpsAutoRepath';
/** Player position tolerance with a stationary player. */
const STATIONARY_TOLERANCE_M = 5;
/** Position tolerance at 10 Hz when the player moves (`speed > 0.5`). */
const MOVING_TOLERANCE_M = 25;
/** Context-menu timeout after a right click on a marker. */
const CONTEXT_MENU_WAIT_MS = 750;

function distance2d(left, right) {
    return Math.hypot(left[0] - right[0], left[1] - right[1]);
}

export async function run({ pageUrl, options, log }) {
    const host = await launchHostPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
    });
    const { browser, page, consoleErrors } = host;

    const optionRestores = [];
    let opened = false;

    try {
        // ---- precondition before opening anything ----------------------
        const heldBefore = await page.evaluate(() => window.TacPhone.interests.list());
        if (heldBefore.includes(GPS_INTEREST)) {
            skip('A GPS panel is already open in this page; close the GPS panel first.');
        }

        await openGpsPanelOnPage(page, { log });
        opened = true;

        // ---- panel, HUD and interests ----------------------------------
        const gpsLabel = await gpsT(page, 'str_a3_gps1');
        const routePanel = page.getByTestId('gps-route-panel');
        await routePanel.waitFor({ state: 'visible', timeout: 15000 });
        equal(
            await routePanel.getAttribute('aria-label'),
            gpsLabel,
            'The GPS section should be labelled with the localized GPS title',
        );
        await page.getByTestId('gps-hud').waitFor({ state: 'visible', timeout: 15000 });

        equal(
            await page.evaluate((interest) => window.TacPhone.interests.isActive(interest), GPS_INTEREST),
            true,
            'The GPS panel should hold the GPS interest while mounted',
        );

        // GPS must not register a layers section or the zoom buttons.
        equal(await page.locator('.ol-zoom-in').count(), 0, 'The GPS must not add zoom buttons');
        const layersToggle = await gpsT(page, 'STR_ACE_Tacphone_Map_Layers_Toggle');
        equal(
            await page.getByTitle(layersToggle).count(),
            0,
            'The GPS must not render the layer switcher',
        );

        // ---- fix and HUD heading ---------------------------------------
        const fixed = await waitForGpsDebug(page, (state) => state.hasFix, 'the first GPS fix');
        const playerPosition = await requestApp(page, 'main', 'GetPlayerPos');
        assert(
            Array.isArray(playerPosition) && playerPosition.length >= 2,
            'GetPlayerPos did not return a position array',
        );
        const tolerance = fixed.speed > 0.5 ? MOVING_TOLERANCE_M : STATIONARY_TOLERANCE_M;
        const fixOffset = distance2d(fixed.position, playerPosition);
        assert(
            fixOffset <= tolerance,
            `The GPS fix is ${fixOffset.toFixed(1)} m from GetPlayerPos (allowed ${tolerance} m)`,
        );
        log?.(`GPS fix ${fixOffset.toFixed(1)} m from GetPlayerPos at speed ${fixed.speed.toFixed(2)} m/s`);

        // The Map fits the whole terrain when its layers arrive; the GPS must
        // pull the view back to the player on the next fix.
        const centered = await waitForMapView(
            page,
            (view) => distance2d([view.x, view.y], fixed.position) <= (fixed.speed > 0.5 ? 50 : 25),
            'the GPS view to center on the player',
        );
        log?.(`GPS view centered ${distance2d([centered.x, centered.y], fixed.position).toFixed(1)} m from the player`);

        const headingText = await page.getByTestId('gps-heading').textContent();
        if (fixed.heading === null) {
            const expectedHeading = await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Hud_NoHeading');
            equal(
                (headingText ?? '').trim(),
                expectedHeading.trim(),
                'The HUD heading text does not match the GPS state',
            );
        } else {
            // The player can keep rotating between the fix snapshot and the DOM
            // read, so compare the compass value with a small angular tolerance.
            const match = /(\d{1,3})\s*°/.exec(headingText ?? '');
            assert(match, `The HUD heading has no degrees: ${headingText}`);
            const actual = Number(match[1]);
            const delta = Math.abs(((actual - fixed.heading + 540) % 360) - 180);
            assert(
                delta <= 10,
                `The HUD heading ${actual}° is ${delta.toFixed(1)}° from the GPS state ${fixed.heading.toFixed(1)}°`,
            );
        }

        if (fixed.rotating) {
            await page.getByTestId('gps-compass').waitFor({ state: 'attached', timeout: 5000 });
        } else {
            equal(
                await page.getByTestId('gps-compass').count(),
                0,
                'The compass must be hidden when the map does not rotate with the player',
            );
        }

        // ---- travel-mode detection -------------------------------------
        const mode = await requestApp(page, MAP_APP, 'GetPlayerTravelMode');
        oneOf(mode?.mode, ['foot', 'ground', 'boat', 'air'], 'GetPlayerTravelMode returned an unknown mode');

        const modeState = await getGpsDebug(page);
        equal(modeState.detectedMode, mode.mode, 'detectedMode should follow GetPlayerTravelMode');
        equal(modeState.mode, mode.mode, 'mode should follow the detected mode before any override');

        if (mode.mode === 'foot') {
            equal(mode.vehicleClass, '', 'On foot the vehicle class must be empty');
            equal(mode.waterCapable, false, 'On foot the player is not water capable');
            const positive = Object.entries(mode.performance ?? {})
                .filter(([key, value]) => typeof value === 'number' && value > 0 && key !== 'canFloat');
            equal(
                positive.length,
                0,
                `On foot the performance snapshot must be empty (got ${JSON.stringify(positive)})`,
            );
            log?.('Player is on foot; the foot baseline is asserted');
        } else {
            assert(mode.vehicleClass !== '', 'A vehicle mode must report its vehicle class');
            assert(
                Number(mode.performance?.maxSpeedKmh) > 0,
                'A vehicle mode must report a positive maxSpeedKmh',
            );
            if (mode.waterCapable) {
                equal(mode.mode, 'ground', 'Only ground vehicles may be water capable');
            }
            log?.(`Player is in ${mode.mode}; foot baseline not applicable`);
        }

        // ---- option registration ---------------------------------------
        await page.waitForFunction(
            (app) => window.TacPhone.options.list().some((entry) => entry.app === app),
            MAP_APP,
            { timeout: 15000 },
        );
        const registrations = await page.evaluate(() => window.TacPhone.options.list());
        const mapRegistration = registrations.find((entry) => entry.app === MAP_APP);
        assert(mapRegistration, 'The Map app did not register any options');
        const definitions = mapRegistration.options;
        const rotateDefinition = definitions.filter((entry) => entry.key === ROTATE_KEY);
        const repathDefinition = definitions.filter((entry) => entry.key === REPATH_KEY);
        equal(rotateDefinition.length, 1, 'The Map options must define gpsRotateWithPlayer exactly once');
        equal(repathDefinition.length, 1, 'The Map options must define gpsAutoRepath exactly once');

        const rotateLabel = await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Options_RotateWithPlayer_Label');
        equal(rotateDefinition[0].type, 'boolean', 'gpsRotateWithPlayer must be a boolean option');
        equal(rotateDefinition[0].default, true, 'gpsRotateWithPlayer must default to true');
        equal(rotateDefinition[0].label, rotateLabel, 'gpsRotateWithPlayer label must be localized');
        equal(repathDefinition[0].type, 'boolean', 'gpsAutoRepath must be a boolean option');
        equal(repathDefinition[0].default, false, 'gpsAutoRepath must default to false');
        assert(
            typeof repathDefinition[0].description === 'string'
                && repathDefinition[0].description.length > 0,
            'gpsAutoRepath needs a description',
        );

        // Rotation off: no compass and a north-up map.
        const previousRotate = await page.evaluate(
            ({ app, key }) => window.TacPhone.options.get(app, key),
            { app: MAP_APP, key: ROTATE_KEY },
        );
        optionRestores.push(async () => {
            await page.evaluate(
                ({ app, key, value }) => window.TacPhone.options.set(app, key, value),
                { app: MAP_APP, key: ROTATE_KEY, value: previousRotate ?? true },
            );
        });
        await page.evaluate(
            ({ app, key }) => window.TacPhone.options.set(app, key, false),
            { app: MAP_APP, key: ROTATE_KEY },
        );
        await waitForGpsDebug(
            page,
            (state) => state.rotating === false && state.mapRotation === 0,
            'gpsRotateWithPlayer=false to clear the map rotation',
        );
        log?.('Rotation option applied: rotating=false, mapRotation=0');

        const previousRepath = await page.evaluate(
            ({ app, key }) => window.TacPhone.options.get(app, key),
            { app: MAP_APP, key: REPATH_KEY },
        );
        optionRestores.push(async () => {
            await page.evaluate(
                ({ app, key, value }) => window.TacPhone.options.set(app, key, value),
                { app: MAP_APP, key: REPATH_KEY, value: previousRepath ?? false },
            );
        });
        await page.evaluate(
            ({ app, key }) => window.TacPhone.options.set(app, key, true),
            { app: MAP_APP, key: REPATH_KEY },
        );
        equal(
            await page.evaluate(
                ({ app, key }) => window.TacPhone.options.get(app, key),
                { app: MAP_APP, key: REPATH_KEY },
            ),
            true,
            'gpsAutoRepath should read back as true after being set',
        );

        // ---- markers stay read-only in GPS ------------------------------
        const markers = await requestApp(page, MAP_APP, 'GetAllMarkers');
        const markerList = Array.isArray(markers?.markers) ? markers.markers : [];
        const withPosition = markerList.find(
            (marker) => Array.isArray(marker) && Array.isArray(marker[4]) && marker[4].length >= 2,
        );

        if (!withPosition) {
            log?.('No marker to check; the read-only marker case is skipped');
        } else {
            const pixel = await gpsPixel(page, [withPosition[4][0], withPosition[4][1]]);

            if (!pixel) {
                log?.(`Marker ${withPosition[0]} is outside the viewport; the read-only case is skipped`);
            } else {
                const box = await page.locator('.ol-viewport').first().boundingBox();
                assert(box, 'The OpenLayers viewport has no layout box');
                await page.mouse.click(box.x + pixel[0], box.y + pixel[1], { button: 'right' });
                await page.waitForTimeout(CONTEXT_MENU_WAIT_MS);
                equal(
                    await page.getByRole('menu').count(),
                    0,
                    'The GPS panel must not open the marker context menu',
                );
                log?.(`Right-clicked marker ${withPosition[0]}; no context menu opened`);
            }
        }

        if (consoleErrors.length > 0) {
            throw new Error(`The GPS page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        for (const restore of optionRestores) {
            await restore().catch(() => {});
        }

        if (opened) {
            await page.evaluate(() => {
                const controls = window.__TACPHONE_MAP_TEST__?.gps;
                controls?.clearWaypoints?.();
                controls?.stopNavigation?.();
            }).catch(() => {});
        }

        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}
