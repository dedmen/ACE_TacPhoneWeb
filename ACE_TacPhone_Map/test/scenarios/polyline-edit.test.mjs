/**
 * Browser checks for polyline edit mode.
 *
 * Creates a player polyline through `CreateMarker`, opens the context menu on
 * it, drags a single vertex, saves, and verifies the result through
 * `GetAllMarkers`. A second edit is cancelled, and an incoming `Marker.Upsert`
 * during editing must not move the local geometry.
 *
 * All visible text is compared through `t('STR_...')` values, so the scenario
 * survives a language switch.
 *
 *   $env:TACPHONE_TEST_URL = 'http://localhost:5173/'
 *   npm run test:map -- --scenario polyline-edit
 */

import { assert, equal } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    deleteMarker,
    findMarker,
    getAllMarkers,
    getMapState,
    getMapView,
    openMapPage,
    requestMap,
    waitForMapState,
    waitForMarkerGone,
    waitForMarkerInLayer,
} from '../lib/map-page.mjs';

export const name = 'polyline-edit';
export const kind = 'browser';
export const description = 'Polyline context menu, vertex drag, save, cancel and the upsert guard';

const VIEWPORT = '.ol-viewport';
const COLOR = '#(0.1,0.6,1,1)';
/** Minimum time the context menu ignores taps right after it opened. */
const MENU_OPEN_GUARD_MS = 250;
/** Tolerance when comparing coordinates that made a round trip through SQF. */
const COORDINATE_TOLERANCE = 0.5;

/** Resolves a localized string in the page, so assertions are language agnostic. */
function t(page, key) {
    return page.evaluate((localizationKey) => window.TacPhone.localization.t(localizationKey), key);
}

function parsePolyline(value) {
    return String(value)
        .split(';')
        .filter((part) => part !== '')
        .map(Number);
}

function toPoints(flat) {
    const points = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
        points.push([flat[index], flat[index + 1]]);
    }

    return points;
}

function flatPoints(points) {
    const flat = [];
    for (const [x, y] of points) {
        flat.push(x, y);
    }

    return flat;
}

function near(left, right) {
    return Math.abs(left - right) <= COORDINATE_TOLERANCE;
}

function samePoint(left, right) {
    return near(left[0], right[0]) && near(left[1], right[1]);
}

/** Viewport pixels of the polyline vertices, straight from the Map debug hook. */
async function vertexPixels(page, markerName) {
    return page.evaluate(
        (name) => window.__TACPHONE_MAP_TEST__?.getMarkerPixels?.(name) ?? null,
        markerName,
    );
}

async function waitForVertexPixels(page, markerName, expectedCount, timeout = 15000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
        const pixels = await vertexPixels(page, markerName);
        if (Array.isArray(pixels) && pixels.length === expectedCount) {
            return pixels;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timed out waiting for ${expectedCount} vertex pixels of ${markerName}`);
}

/** Creates a polyline and returns its generated `_USER_DEFINED` name. */
async function createPolyline(page, points) {
    const reply = await requestMap(page, 'CreateMarker', {
        marker: {
            shape: 'POLYLINE',
            color: COLOR,
            position: points[0],
            polyline: flatPoints(points),
        },
    });

    assert(typeof reply?.name === 'string' && reply.name !== '', 'CreateMarker did not return a polyline name');

    return reply.name;
}

/** Waits until the stored polyline matches `expected`, and returns the marker. */
async function waitForStoredPolyline(page, markerName, expected, timeout = 20000) {
    const startedAt = Date.now();
    let last = null;

    while (Date.now() - startedAt < timeout) {
        const marker = findMarker(await getAllMarkers(page), markerName);
        if (marker) {
            last = toPoints(parsePolyline(marker[11]));
            if (last.length === expected.length && last.every((point, index) => samePoint(point, expected[index]))) {
                return marker;
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
        `Stored polyline ${markerName} never matched ${JSON.stringify(expected)}; last was ${JSON.stringify(last)}`,
    );
}

/** Opens the context menu on the given page-space pixel. */
async function openContextMenu(page, x, y) {
    await page.mouse.click(x, y, { button: 'right' });
    const menu = page.getByRole('menu');
    await menu.waitFor({ state: 'visible', timeout: 5000 });

    return menu;
}

/** Enters edit mode through the context menu and waits for the edit panel. */
async function enterPolylineEdit(page, markerName, x, y, menuLabel, panelLabel) {
    const menu = await openContextMenu(page, x, y);
    const editItem = menu.getByRole('menuitem', { name: menuLabel });
    await editItem.waitFor({ state: 'visible', timeout: 5000 });

    // The menu ignores taps for a moment after opening, to avoid the tap that
    // opened it activating an item.
    await page.waitForTimeout(MENU_OPEN_GUARD_MS);
    await editItem.click();

    await waitForMapState(
        page,
        (state) => state.polyline.isEditing === true && state.polyline.editingName === markerName,
        `polyline edit mode for ${markerName}`,
    );

    const panel = page.getByRole('group', { name: panelLabel });
    await panel.waitFor({ state: 'visible', timeout: 5000 });

    return panel;
}

/** Drags one vertex and returns the flat edit-preview points afterwards. */
async function dragVertex(page, box, pixels, index) {
    const startX = box.x + pixels[index][0];
    const startY = box.y + pixels[index][1];

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 48, startY + 24, { steps: 6 });
    await page.mouse.up();

    await waitForMapState(
        page,
        (state) => Array.isArray(state.polyline.points) && state.polyline.points.length > 0,
        'edit-preview points',
    );

    const state = await getMapState(page);
    return state.polyline.points;
}

export async function run({ pageUrl, options, log }) {
    const { browser, context, page, consoleErrors } = await openMapPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
        log,
    });
    let created = null;

    try {
        const labels = {
            editPolyline: await t(page, 'STR_ACE_Tacphone_Map_ContextMenu_EditPolyline'),
            editing: await t(page, 'STR_ACE_Tacphone_Map_PolylineEdit_Editing'),
            save: await t(page, 'str_3den_display3den_menubar_missionsave_text'),
            cancel: await t(page, 'STR_3DEN_Display3DEN_ControlsHint_Cancel'),
        };

        const viewport = page.locator(VIEWPORT).first();
        const box = await viewport.boundingBox();
        assert(box, 'The OpenLayers viewport has no layout box');

        // Three vertices around the current map center, spaced far enough to
        // hit them individually at the current resolution.
        const view = await getMapView(page);
        assert(view, 'The map service did not report a view');
        const step = Math.max(view.resolution * 120, 1);
        const originalPoints = [
            [view.x - step, view.y - step * 0.5],
            [view.x, view.y + step * 0.25],
            [view.x + step, view.y - step * 0.5],
        ];

        created = await createPolyline(page, originalPoints);
        await waitForMarkerInLayer(page, created);
        log?.(`Created polyline ${created}`);

        let pixels = await waitForVertexPixels(page, created, originalPoints.length);
        const storedOriginal = findMarker(await getAllMarkers(page), created);
        assert(storedOriginal, 'The created polyline is missing from GetAllMarkers');

        // ---- edit and drag one vertex -----------------------------------
        const panel = await enterPolylineEdit(
            page,
            created,
            box.x + pixels[1][0],
            box.y + pixels[1][1],
            labels.editPolyline,
            labels.editing,
        );
        equal(
            await page.getByRole('menu').count(),
            0,
            'The context menu must be closed after choosing Edit polyline',
        );

        const editState = await getMapState(page);
        equal(
            editState.polyline.vertexCount,
            originalPoints.length,
            'The editor must load every existing vertex',
        );
        equal(
            editState.polyline.points.length,
            originalPoints.length * 2,
            'The debug state must expose the flat edit-preview points',
        );
        equal(
            await panel.getByText(labels.editing).count(),
            1,
            'The edit panel must show its title',
        );
        log?.('Polyline edit mode opened');

        // An incoming update for the same marker must not move the vertices.
        await requestMap(page, 'CreateMarker', {
            marker: {
                name: created,
                shape: 'POLYLINE',
                color: COLOR,
                position: originalPoints[0],
                polyline: flatPoints(originalPoints),
            },
        });
        await page.waitForTimeout(500);
        const guardedState = await getMapState(page);
        assert(
            guardedState.polyline.points.length === originalPoints.length * 2,
            'The upsert guard must keep every edit-preview point',
        );

        const draggedPoints = toPoints(await dragVertex(page, box, pixels, 1));
        equal(draggedPoints.length, originalPoints.length, 'The drag must not add or remove vertices');
        assert(
            !samePoint(draggedPoints[1], originalPoints[1]),
            `The dragged vertex did not move: ${JSON.stringify(draggedPoints[1])}`,
        );
        assert(
            samePoint(draggedPoints[0], originalPoints[0]) && samePoint(draggedPoints[2], originalPoints[2]),
            'Dragging one vertex must not move the other ones',
        );

        await page.getByRole('button', { name: labels.save }).click();
        await waitForMapState(page, (state) => state.polyline.isEditing === false, 'polyline edit mode to end');

        const savedMarker = await waitForStoredPolyline(page, created, draggedPoints);
        assert(
            savedMarker[6] === 'POLYLINE',
            'Saving the edit must keep the marker a POLYLINE',
        );
        equal(
            savedMarker[2],
            storedOriginal[2],
            'Saving the edit must not change the polyline color',
        );
        log?.(`Saved the moved vertex: ${JSON.stringify(draggedPoints[1])}`);

        // ---- edit again and cancel --------------------------------------
        pixels = await waitForVertexPixels(page, created, draggedPoints.length);
        await enterPolylineEdit(page, created, box.x + pixels[0][0], box.y + pixels[0][1], labels.editPolyline);

        const cancelledPoints = toPoints(await dragVertex(page, box, pixels, 0));
        assert(
            !samePoint(cancelledPoints[0], draggedPoints[0]),
            'The second edit must move the first vertex locally',
        );

        await page.getByRole('button', { name: labels.cancel }).click();
        await waitForMapState(page, (state) => state.polyline.isEditing === false, 'polyline edit mode to end');

        const afterCancelState = await getMapState(page);
        equal(
            afterCancelState.polyline.points.length,
            0,
            'Cancel must clear the edit-preview points',
        );

        const afterCancelMarker = findMarker(await getAllMarkers(page), created);
        const afterCancelPoints = toPoints(parsePolyline(afterCancelMarker[11]));
        assert(
            afterCancelPoints.length === draggedPoints.length
            && afterCancelPoints.every((point, index) => samePoint(point, draggedPoints[index])),
            `Cancel must keep the stored geometry, got ${JSON.stringify(afterCancelPoints)}`,
        );
        log?.('Cancelled the second edit without changes');

        if (consoleErrors.length > 0) {
            throw new Error(`The Map page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        if (created) {
            await deleteMarker(page, created);
            await waitForMarkerGone(page, created).catch(() => {});
        }

        await page.close();
        await context.close();
        await browser.close();
    }
}
