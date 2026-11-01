/**
 * Browser checks for map navigation and the fly-to focus behavior.
 *
 * Covers zoom controls, mouse panning, `flyTo({ bbox })` fitting and the
 * temporary glowing highlight. Also verifies that `focusMarker()` re-centers and
 * zooms to a marker after the view was panned far away at a different zoom.
 *
 *   $env:TACPHONE_TEST_URL = 'http://localhost:5173/'
 *   npm run test:map -- --scenario map-view --slow
 */

import { assert, equal } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    createMarker,
    deleteMarker,
    getMapView,
    openMapPage,
    waitForMapView,
    waitForMapViewDebugState,
    waitForMapViewStable,
    waitForMarkerGone,
    waitForMarkerInLayer,
} from '../lib/map-page.mjs';

export const name = 'map-view';
export const kind = 'browser';
export const description = 'Zoom, pan, flyTo bbox fitting and the temporary focus highlight';

/** Marker focus box is 800 m; flyTo keeps 48 px free on every side. */
const MARKER_FOCUS_SIZE = 800;
const MARKER_HIGHLIGHT_PX = 48;
const FLY_TO_MARGIN_PX = 48;

function distance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y);
}

function near(actual, expected, tolerance, message) {
    assert(
        Math.abs(actual - expected) <= tolerance,
        `${message}\n  expected: ${expected} ± ${tolerance}\n  actual:   ${actual}`,
    );
}

export async function run({ pageUrl, options, log }) {
    const { browser, page, consoleErrors } = await openMapPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
        log,
    });
    const created = [];

    try {
        const viewport = page.locator('.ol-viewport').first();
        const box = await viewport.boundingBox();
        assert(box, 'The OpenLayers viewport has no layout box');

        // ---- wheel zoom (the +/- buttons are removed) -------------------
        const initial = await getMapView(page);
        assert(initial, 'The Map view is not ready');
        equal(await page.locator('.ol-zoom-in').count(), 0, 'The Map zoom-in button should be removed');
        equal(await page.locator('.ol-zoom-out').count(), 0, 'The Map zoom-out button should be removed');
        log?.(`Initial view ${initial.resolution} at ${initial.x.toFixed(0)},${initial.y.toFixed(0)}`);

        const wheelX = box.x + box.width * 0.35;
        const wheelY = box.y + box.height * 0.65;
        await page.mouse.move(wheelX, wheelY);
        await page.mouse.wheel(0, -500);
        const zoomedIn = await waitForMapViewStable(page, 'wheel zoom-in to settle');
        assert(
            zoomedIn.resolution < initial.resolution * 0.95,
            `Wheel zoom-in did not change the resolution: ${zoomedIn.resolution}`,
        );
        log?.(`Wheel-zoomed in to ${zoomedIn.resolution}`);

        await page.mouse.wheel(0, 500);
        const zoomedOut = await waitForMapViewStable(page, 'wheel zoom-out to settle');
        assert(
            zoomedOut.resolution > zoomedIn.resolution * 1.05,
            `Wheel zoom-out did not change the resolution: ${zoomedOut.resolution}`,
        );
        log?.(`Wheel-zoomed out to ${zoomedOut.resolution}`);

        // At the initial full-map view the view is constrained to the terrain
        // extent, so there is nowhere to pan. Zoom in again first.
        await page.mouse.wheel(0, -500);
        const panZoom = await waitForMapViewStable(page, 'wheel zoom-in before panning to settle');
        assert(
            panZoom.resolution < zoomedOut.resolution * 0.95,
            `Pan setup did not zoom in: ${panZoom.resolution}`,
        );

        // ---- mouse pan --------------------------------------------------
        const beforePan = await getMapView(page);
        assert(beforePan, 'The Map view disappeared before panning');
        near(panZoom.resolution, beforePan.resolution, beforePan.resolution * 0.01, 'Pan setup changed the zoom');

        const startX = box.x + box.width * 0.35;
        const startY = box.y + box.height * 0.65;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 140, startY + 80, { steps: 12 });
        await page.mouse.up();

        const afterPan = await waitForMapViewStable(page, 'the mouse pan to settle');
        assert(
            distance(afterPan, beforePan) > 1,
            `Mouse drag did not pan the map: ${JSON.stringify(beforePan)} -> ${JSON.stringify(afterPan)}`,
        );
        near(afterPan.resolution, beforePan.resolution, beforePan.resolution * 0.01, 'Panning changed the zoom');
        log?.(`Panned by ${distance(afterPan, beforePan).toFixed(0)} map units`);

        // ---- focusMarker after moving away at a deep zoom --------------
        const markerPosition = [afterPan.x, afterPan.y];
        const markerName = await createMarker(page, {
            shape: 'ICON',
            type: 'flag_NATO',
            color: 'ColorRed',
            position: markerPosition,
            label: `TacPhone focus ${Date.now()}`,
        });
        created.push(markerName);
        await waitForMarkerInLayer(page, markerName);

        const away = [afterPan.x + 3000, afterPan.y + 3000];
        await page.evaluate(({ x, y }) => {
            const api = window.TacPhone.interApp.list('map')[0]?.api;
            api.flyTo({ x, y, resolution: 0.2, animate: false });
        }, { x: away[0], y: away[1] });
        const movedAway = await waitForMapView(
            page,
            (view) => distance(view, { x: away[0], y: away[1] }) < 100 && view.resolution < 0.5,
            'the view to move away from the marker',
        );
        log?.(`Moved away to ${movedAway.x.toFixed(0)},${movedAway.y.toFixed(0)} at ${movedAway.resolution}`);

        const focusResult = await page.evaluate(
            (name) => window.TacPhone.interApp.list('map')[0]?.api.focusMarker(name, { highlight: true }),
            markerName,
        );
        equal(focusResult, true, 'focusMarker() did not resolve true for an existing marker');

        const expectedSpan = MARKER_FOCUS_SIZE;
        const fitWidth = Math.max(1, box.width - FLY_TO_MARGIN_PX * 2);
        const fitHeight = Math.max(1, box.height - FLY_TO_MARGIN_PX * 2);
        const expectedResolution = Math.max(expectedSpan / fitWidth, expectedSpan / fitHeight);

        await waitForMapView(
            page,
            (view) => distance(view, { x: markerPosition[0], y: markerPosition[1] }) < 1,
            'focusMarker to center the view on the marker',
        );
        const focused = await waitForMapViewStable(page, 'focusMarker animation to settle');
        near(focused.resolution, expectedResolution, expectedResolution * 0.05, 'focusMarker used the wrong zoom');
        log?.(`Focused marker at ${focused.x.toFixed(0)},${focused.y.toFixed(0)} resolution ${focused.resolution}`);

        const highlight = await waitForMapViewDebugState(
            page,
            (state) => state.highlight?.active === true,
            'the fly-to highlight',
        );
        equal(highlight.highlight.kind, 'box', 'focusMarker should draw a box highlight');
        assert(highlight.highlight.bbox, 'The fly-to highlight has no bounding box');
        const highlightHalf = (MARKER_HIGHLIGHT_PX * focused.resolution) / 2;
        near(highlight.highlight.bbox[0], markerPosition[0] - highlightHalf, 1, 'Highlight minX is wrong');
        near(highlight.highlight.bbox[2], markerPosition[0] + highlightHalf, 1, 'Highlight maxX is wrong');
        near(highlight.highlight.bbox[1], markerPosition[1] - highlightHalf, 1, 'Highlight minY is wrong');
        near(highlight.highlight.bbox[3], markerPosition[1] + highlightHalf, 1, 'Highlight maxY is wrong');

        await waitForMapViewDebugState(
            page,
            (state) => state.highlight === null,
            'the highlight to disappear',
            6000,
        );
        log?.('Fly-to highlight disappeared after its timeout');

        // ---- explicit flyTo bbox ---------------------------------------
        await page.evaluate(({ x, y }) => {
            const api = window.TacPhone.interApp.list('map')[0]?.api;
            api.flyTo({ x, y, resolution: 0.2, animate: false });
        }, { x: away[0], y: away[1] });
        await waitForMapView(
            page,
            (view) => distance(view, { x: away[0], y: away[1] }) < 100,
            'the view to move away for the explicit bbox test',
        );

        const boxSize = 200;
        const explicitBbox = [
            markerPosition[0] - boxSize / 2,
            markerPosition[1] - boxSize / 2,
            markerPosition[0] + boxSize / 2,
            markerPosition[1] + boxSize / 2,
        ];
        await page.evaluate((bbox) => {
            window.TacPhone.interApp.list('map')[0]?.api.flyTo({ bbox, highlight: true, animate: false });
        }, explicitBbox);

        const bboxView = await waitForMapViewStable(page, 'flyTo bbox to settle');
        near(distance(bboxView, { x: markerPosition[0], y: markerPosition[1] }), 0, 1, 'flyTo bbox did not center the view');
        const expectedBboxResolution = Math.max(boxSize / fitWidth, boxSize / fitHeight);
        near(
            bboxView.resolution,
            expectedBboxResolution,
            expectedBboxResolution * 0.05,
            'flyTo bbox used the wrong zoom',
        );
        const bboxHighlight = await waitForMapViewDebugState(
            page,
            (state) => state.highlight?.active === true,
            'the explicit bbox highlight',
        );
        equal(bboxHighlight.highlight.kind, 'box', 'A bbox highlight should be a box');
        near(bboxHighlight.highlight.bbox[0], explicitBbox[0], 1, 'Explicit highlight minX is wrong');
        near(bboxHighlight.highlight.bbox[2], explicitBbox[2], 1, 'Explicit highlight maxX is wrong');
        log?.(`Explicit bbox focused at resolution ${bboxView.resolution}`);

        if (consoleErrors.length > 0) {
            throw new Error(`The Map page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        for (const markerName of created) {
            await deleteMarker(page, markerName);
            await waitForMarkerGone(page, markerName).catch(() => {});
        }

        await page.close();
        await browser.close();
    }
}
