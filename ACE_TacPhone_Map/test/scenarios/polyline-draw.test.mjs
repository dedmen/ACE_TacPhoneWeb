/**
 * Browser checks for polyline drawing.
 *
 * Drives the Map panel with Playwright and covers the three input paths the app
 * supports:
 *   1. mouse clicks in "Click per point" mode,
 *   2. touch taps in "Click per point" mode,
 *   3. freehand mouse drag (touch is covered by the tap path; a CDP touch drag
 *      adds the freehand-touch path when the browser supports it).
 *
 * Every created polyline is verified through `GetAllMarkers` (shape, channel,
 * color, measurement tag) and through the live Map debug state (LineString
 * feature), then deleted again.
 *
 *   $env:TACPHONE_TEST_URL = 'http://localhost:5173/'
 *   npm run test:map -- --scenario polyline-draw
 */

import { assert, equal } from '../lib/assertions.mjs';
import {
    deleteMarker,
    getAllMarkers,
    getMapState,
    openMapPage,
    waitForMapState,
    waitForMarkerGone,
    waitForMarkerInLayer,
    waitForNewPolyline,
} from '../lib/map-page.mjs';

export const name = 'polyline-draw';
export const kind = 'browser';
export const description = 'Polyline drawing via mouse clicks, touch taps and freehand strokes';

const POLYLINE_MEASUREMENTS_TAG = 'ace_tacphone:polyline-measurements:1';
const POLYLINE_BUTTON = 'Draw polyline marker';
const CUSTOM_COLOR = '#(0,1,0,0.5)';
const MIN_ALPHA_COLOR = '#(0,1,0,0.2)';

/** Sets a native input value through the prototype setter so React sees it. */
async function setNativeInputValue(page, selector, value) {
    await page.evaluate(({ target, next }) => {
        const input = document.querySelector(target);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!input || !setter) {
            throw new Error(`Input ${target} is missing`);
        }

        setter.call(input, next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { target: selector, next: value });
}

function parsePolyline(value) {
    return String(value)
        .split(';')
        .filter((part) => part !== '')
        .map(Number);
}

function assertPolylineCoordinates(marker, minimumPoints, label) {
    const coordinates = parsePolyline(marker[11]);
    assert(
        coordinates.length >= minimumPoints * 2,
        `${label}: expected at least ${minimumPoints} polyline points, got ${coordinates.length / 2} (${marker[11]})`,
    );
    assert(coordinates.length % 2 === 0, `${label}: the polyline has an odd number of coordinates`);
    assert(
        coordinates.every((value) => Number.isFinite(value)),
        `${label}: the polyline contains a non-numeric coordinate`,
    );
}

/** Viewport-relative click points on the lower-left part of the map. */
function mapPoints(box) {
    return [
        [box.x + box.width * 0.18, box.y + box.height * 0.72],
        [box.x + box.width * 0.29, box.y + box.height * 0.78],
        [box.x + box.width * 0.4, box.y + box.height * 0.7],
    ];
}

export async function run({ pageUrl, options, log }) {
    const { browser, context, page, consoleErrors } = await openMapPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
        hasTouch: true,
        log,
    });
    const created = [];

    try {
        const viewport = page.locator('.ol-viewport').first();
        const box = await viewport.boundingBox();
        assert(box, 'The OpenLayers viewport has no layout box');

        await page.getByRole('button', { name: POLYLINE_BUTTON }).click();
        const panel = page.getByRole('group', { name: 'Polyline drawing' });
        await panel.waitFor({ state: 'visible', timeout: 5000 });
        await page.locator('[data-testid="polyline-color-picker"]').waitFor({ state: 'visible', timeout: 10000 });

        const colorClasses = await page
            .locator('[data-testid="polyline-color-picker"] [data-color-class]')
            .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-color-class')));
        assert(colorClasses.length > 0, 'The polyline color picker is empty');
        equal(
            await page.locator('[data-testid="polyline-color-custom"]').count(),
            1,
            'The polyline color picker must offer a Custom swatch',
        );

        await page.locator('[data-testid="polyline-color-custom"]').click();
        const customPopover = page.locator('[data-testid="polyline-color-custom-popover"]');
        await customPopover.waitFor({ state: 'visible', timeout: 5000 });
        const alphaMin = await page.locator('[data-testid="polyline-color-custom-alpha"]').getAttribute('min');
        equal(Number(alphaMin), 0.2, 'The polyline custom color alpha must not go below 20%');

        await setNativeInputValue(page, '[data-testid="polyline-color-custom-input"]', '#00ff00');
        await waitForMapState(
            page,
            (state) => state.polyline.color === '#(0,1,0,1)',
            'polyline custom color before alpha',
        );
        await setNativeInputValue(page, '[data-testid="polyline-color-custom-alpha"]', '0');
        await waitForMapState(
            page,
            (state) => state.polyline.color === MIN_ALPHA_COLOR,
            `polyline minimum alpha color ${MIN_ALPHA_COLOR}`,
        );
        const previewColors = await getMapState(page);
        equal(
            previewColors.polyline.previewLineColor,
            'rgba(0, 255, 0, 0.2)',
            'The polyline preview line does not use the custom alpha',
        );
        equal(
            previewColors.polyline.previewHaloColor,
            'rgba(255, 255, 255, 0.2)',
            'The polyline preview halo must fade with the line alpha',
        );

        await setNativeInputValue(page, '[data-testid="polyline-color-custom-alpha"]', '0.5');
        await waitForMapState(
            page,
            (state) => state.polyline.color === CUSTOM_COLOR,
            `polyline custom color ${CUSTOM_COLOR}`,
        );
        const color = CUSTOM_COLOR;
        log?.(`Drawing with a custom RGBA color ${color}`);

        const clickMode = panel.getByRole('checkbox', { name: 'Click per point' });

        // ---- path 1: mouse clicks --------------------------------------
        await clickMode.check();
        await waitForMapState(page, (state) => state.polyline.clickPerPoint, 'click-per-point mode');

        const points = mapPoints(box);
        const beforeClicks = new Set((await getAllMarkers(page)).map((marker) => marker[0]));

        for (let index = 0; index < points.length; index++) {
            const [x, y] = points[index];
            await page.mouse.click(x, y);
            await waitForMapState(
                page,
                (state) => state.polyline.vertexCount === index + 1,
                `mouse vertex ${index + 1}`,
            );
        }

        await panel.getByRole('button', { name: 'Done' }).click();
        await waitForMapState(page, (state) => state.polyline.vertexCount === 0, 'mouse polyline finish');

        const clickPolyline = await waitForNewPolyline(page, beforeClicks);
        created.push(clickPolyline[0]);
        assertPolylineCoordinates(clickPolyline, 2, 'mouse click polyline');
        equal(clickPolyline[6], 'POLYLINE', 'The created marker is not a POLYLINE');
        equal(clickPolyline[10], (await getMapState(page)).activeChannel, 'The polyline used the wrong channel');
        equal(clickPolyline[2], color, 'The polyline did not use the selected color');
        equal(
            clickPolyline[5],
            POLYLINE_MEASUREMENTS_TAG,
            'Click-per-point polylines must carry the measurement tag',
        );
        await waitForMarkerInLayer(page, clickPolyline[0]);
        equal(
            (await getMapState(page)).markers.find((marker) => marker.name === clickPolyline[0]).geometry,
            'LineString',
            'The created polyline was not rendered as a LineString',
        );
        log?.('Mouse click polyline created');

        // ---- path 2: touch taps ----------------------------------------
        const beforeTaps = new Set((await getAllMarkers(page)).map((marker) => marker[0]));

        for (let index = 0; index < points.length; index++) {
            const [x, y] = points[index];
            await page.touchscreen.tap(x, y);
            await waitForMapState(
                page,
                (state) => state.polyline.vertexCount === index + 1,
                `touch vertex ${index + 1}`,
            );
        }

        await panel.getByRole('button', { name: 'Done' }).click();
        await waitForMapState(page, (state) => state.polyline.vertexCount === 0, 'touch polyline finish');

        const tapPolyline = await waitForNewPolyline(page, beforeTaps);
        created.push(tapPolyline[0]);
        assertPolylineCoordinates(tapPolyline, 2, 'touch polyline');
        equal(tapPolyline[2], color, 'The touch polyline did not use the selected color');
        equal(tapPolyline[10], (await getMapState(page)).activeChannel, 'The touch polyline used the wrong channel');
        await waitForMarkerInLayer(page, tapPolyline[0]);
        log?.('Touch tap polyline created');

        // ---- path 3: freehand mouse drag -------------------------------
        await clickMode.uncheck();
        await waitForMapState(page, (state) => state.polyline.clickPerPoint === false, 'freehand mode');

        const beforeFreehand = new Set((await getAllMarkers(page)).map((marker) => marker[0]));
        const [startX, startY] = mapPoints(box)[0];
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        for (let step = 1; step <= 8; step++) {
            await page.mouse.move(startX + step * 18, startY + step * 6);
        }
        await page.mouse.up();

        const freehandState = await waitForMapState(
            page,
            (state) => state.polyline.vertexCount >= 2,
            'freehand stroke vertices',
        );
        log?.(`Freehand stroke has ${freehandState.polyline.vertexCount} vertices`);

        await panel.getByRole('button', { name: 'Done' }).click();
        await waitForMapState(page, (state) => state.polyline.vertexCount === 0, 'freehand polyline finish');

        const freehandPolyline = await waitForNewPolyline(page, beforeFreehand);
        created.push(freehandPolyline[0]);
        assertPolylineCoordinates(freehandPolyline, 2, 'freehand polyline');
        equal(freehandPolyline[2], color, 'The freehand polyline did not use the selected color');
        equal(freehandPolyline[5], '', 'Freehand polylines must not carry the measurement tag');
        await waitForMarkerInLayer(page, freehandPolyline[0]);
        log?.('Freehand mouse polyline created');

        // ---- path 4: freehand touch drag (optional, needs CDP) ---------
        if (typeof context.newCDPSession === 'function') {
            const beforeTouchDrag = new Set((await getAllMarkers(page)).map((marker) => marker[0]));
            const cdp = await context.newCDPSession(page);
            const [touchX, touchY] = mapPoints(box)[1];

            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{ x: touchX, y: touchY, id: 1 }],
            });
            for (let step = 1; step <= 8; step++) {
                await cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchMove',
                    touchPoints: [{ x: touchX + step * 14, y: touchY - step * 5, id: 1 }],
                });
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

            const touchDragState = await waitForMapState(
                page,
                (state) => state.polyline.vertexCount >= 2,
                'touch freehand stroke vertices',
            );
            log?.(`Touch freehand stroke has ${touchDragState.polyline.vertexCount} vertices`);

            await panel.getByRole('button', { name: 'Done' }).click();
            await waitForMapState(page, (state) => state.polyline.vertexCount === 0, 'touch freehand finish');

            const touchDragPolyline = await waitForNewPolyline(page, beforeTouchDrag);
            created.push(touchDragPolyline[0]);
            assertPolylineCoordinates(touchDragPolyline, 2, 'touch freehand polyline');
            equal(touchDragPolyline[2], color, 'The touch freehand polyline did not use the selected color');
            await waitForMarkerInLayer(page, touchDragPolyline[0]);
            log?.('Touch freehand polyline created');

            await cdp.detach();
        } else {
            log?.('Skipping the touch freehand drag: this Playwright build has no CDP session support');
        }

        // Leave drawing mode again.
        await page.getByRole('button', { name: POLYLINE_BUTTON }).click();
        await waitForMapState(page, (state) => state.polyline.isActive === false, 'polyline drawing stopped');
        equal(await panel.count(), 0, 'The polyline panel is still visible after stopping drawing');

        if (consoleErrors.length > 0) {
            throw new Error(`The Map page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        for (const markerName of created) {
            await deleteMarker(page, markerName);
            await waitForMarkerGone(page, markerName).catch(() => {});
        }

        await page.close();
        await context.close();
        await browser.close();
    }
}
