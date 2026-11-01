/**
 * Playwright checks for the Messenger UI.
 *
 * Exercises the real user path: open the host page and Map, open Messenger in
 * the second flexlayout tabset, add fake players, create a room, send a message,
 * share a map marker through the Map context menu, then click the marker card
 * and verify that the Map focuses the marker and shows the temporary highlight.
 *
 * Needs a debug game (fake players and debug commands). Run with:
 *
 *   npm run test:messaging-ui -- --slow
 */

import { assert, equal } from '../../../ACE_TacPhone_Map/test/lib/assertions.mjs';
import {
    activatePanelTab,
    createMarker,
    deleteMarker,
    getMapView,
    openAppThroughChooser,
    openMapPage,
    requestApp,
    requestMap,
    waitForMapView,
    waitForMapViewDebugState,
    waitForMarkerGone,
    waitForMarkerInLayer,
} from '../../../ACE_TacPhone_Map/test/lib/map-page.mjs';

export const name = 'messenger-ui';
export const kind = 'browser';
export const description = 'Messenger UI: fake players, rooms, messages, marker sharing and map focus';

const MARKER_FOCUS_SIZE = 800;
const MARKER_HIGHLIGHT_PX = 48;
const FLY_TO_MARGIN_PX = 48;

function near(actual, expected, tolerance, message) {
    assert(
        Math.abs(actual - expected) <= tolerance,
        `${message}\n  expected: ${expected} ± ${tolerance}\n  actual:   ${actual}`,
    );
}

export async function run({ pageUrl, options, log }) {
    // openMapPage also gives us a fully drawn Map for the marker share.
    const { browser, page, consoleErrors } = await openMapPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
        log,
    });
    const created = [];

    try {
        // ---- open Messenger in the second tabset ------------------------
        await openAppThroughChooser(page, 'Messaging', {
            tileTitle: 'Messenger',
            tabsetIndex: 1,
        });
        await page.getByRole('button', { name: 'New chat' }).first().waitFor({ state: 'visible', timeout: 15000 });
        log?.('Messenger opened through a second tab and the app chooser');

        // Opening the second app can leave the Map tab in the background of its
        // tabset. Select it again so both panels are mounted and visible.
        assert(
            await activatePanelTab(page, 'ACE_TacPhone_Map'),
            'The Map tab is not available after opening Messenger',
        );
        await page.locator('.ol-viewport').first().waitFor({ state: 'visible', timeout: 10000 });

        // ---- fake players through the debug toolbar ---------------------
        const debugButton = page.getByRole('button', { name: 'Messenger debug tools' });
        if (await debugButton.count() > 0) {
            await debugButton.click();
            await page.getByRole('button', { name: 'Add fake players' }).click();
        } else {
            log?.('Debug toolbar is unavailable; adding fake players through the debug request');
            await requestApp(page, 'Messaging', 'Messaging.Debug.AddFakePlayers', { count: 6 });
        }

        await page.waitForFunction(
            () => (window.__messengerStore?.getSnapshot().players.length ?? 0) > 0,
            null,
            { timeout: 15000 },
        );

        const collapseDebug = page.getByRole('button', { name: 'Collapse debug tools' });
        if (await collapseDebug.count() > 0) {
            await collapseDebug.click();
        }

        // ---- create a room through the UI ------------------------------
        const roomName = `TacPhone UI room ${Date.now()}`;
        await page.getByRole('button', { name: 'New chat' }).first().click();
        const createDialog = page.getByRole('dialog', { name: 'New chat' });
        await createDialog.waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('#messenger-room-name').fill(roomName);

        const playerOption = page.getByRole('option', { name: /^Fake Alpha 1\b/ }).first();
        await playerOption.waitFor({ state: 'visible', timeout: 10000 });
        await playerOption.click();
        await createDialog.getByRole('button', { name: 'Create room' }).click();
        await createDialog.waitFor({ state: 'detached', timeout: 15000 });
        await page.getByText(roomName, { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
        log?.(`Created room ${roomName}`);

        // ---- send a message through the composer -----------------------
        const messageText = `TacPhone UI message ${Date.now()}`;
        const composer = page.getByRole('textbox', { name: 'Message' });
        await composer.waitFor({ state: 'visible', timeout: 15000 });
        await composer.fill(messageText);
        await page.getByRole('button', { name: 'Send message' }).click();
        await page.getByText(messageText, { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
        log?.('Sent a message through the Messenger composer');

        // ---- create a marker at the current Map center -----------------
        const mapView = await getMapView(page);
        assert(mapView, 'The Map view is not ready for the marker share');
        const markerLabel = `TacPhone shared ${Date.now()}`;
        const markerName = await createMarker(page, {
            shape: 'ICON',
            type: 'flag_NATO',
            color: 'ColorRed',
            position: [mapView.x, mapView.y],
            label: markerLabel,
        });
        created.push(markerName);
        await waitForMarkerInLayer(page, markerName);
        // Let the marker layer render the new feature before hit-testing it.
        await page.waitForTimeout(600);

        const mapViewport = page.locator('.ol-viewport').first();
        const mapBox = await mapViewport.boundingBox();
        assert(mapBox, 'The Map viewport has no layout box');

        // The marker is at the view center, so the context menu opens there.
        await page.mouse.click(
            mapBox.x + mapBox.width / 2,
            mapBox.y + mapBox.height / 2,
            { button: 'right' },
        );
        const markerMenu = page.getByRole('menu', { name: 'Marker' });
        await markerMenu.waitFor({ state: 'visible', timeout: 10000 });
        await page.getByRole('menuitem', { name: 'Share to Messenger' }).click();

        // ---- share it into the room ------------------------------------
        const shareDialog = page.getByRole('dialog', { name: 'Share to Messenger' });
        await shareDialog.waitFor({ state: 'visible', timeout: 15000 });
        const roomOption = shareDialog.getByRole('option', { name: new RegExp(roomName) });
        await roomOption.waitFor({ state: 'visible', timeout: 10000 });
        await roomOption.click();
        await shareDialog.getByRole('button', { name: 'Share' }).click();
        await shareDialog.waitFor({ state: 'detached', timeout: 15000 });
        log?.('Shared the marker into the room');

        // ---- move the Map away before clicking the card ----------------
        const away = [mapView.x + 3000, mapView.y + 3000];
        await page.evaluate(({ x, y }) => {
            const api = window.TacPhone.interApp.list('map')[0]?.api;
            api.flyTo({ x, y, resolution: 0.2, animate: false });
        }, { x: away[0], y: away[1] });
        await waitForMapView(
            page,
            (view) => Math.hypot(view.x - away[0], view.y - away[1]) < 100 && view.resolution < 0.5,
            'the Map to move away from the marker',
        );

        // ---- click the marker card in the conversation -----------------
        // Scope to the chat pane: the room row preview also contains the shared
        // marker text and would otherwise be matched first.
        const conversation = page.getByRole('region', { name: 'Conversation' });
        const card = conversation.getByRole('button', { name: new RegExp(markerLabel) }).first();
        await card.waitFor({ state: 'visible', timeout: 15000 });
        await card.click();

        // `policy: 'ask'` can show the host panel chooser even with one Map.
        const chooserHeading = page.getByRole('heading', { name: /Choose a panel for/ });
        await page.waitForTimeout(800);
        if (await chooserHeading.count() > 0) {
            await page.locator('button[title*="ACE_TacPhone_Map ("]').first().click();
            log?.('Picked the Map panel in the target chooser');
        }

        // ---- verify focus, zoom and the temporary highlight -------------
        const focused = await waitForMapView(
            page,
            (view) => Math.hypot(view.x - mapView.x, view.y - mapView.y) < 1,
            'Messenger card click to focus the marker',
            15000,
        );

        const fitWidth = Math.max(1, mapBox.width - FLY_TO_MARGIN_PX * 2);
        const fitHeight = Math.max(1, mapBox.height - FLY_TO_MARGIN_PX * 2);
        const expectedResolution = Math.max(MARKER_FOCUS_SIZE / fitWidth, MARKER_FOCUS_SIZE / fitHeight);
        near(focused.resolution, expectedResolution, expectedResolution * 0.05, 'Messenger focus used the wrong zoom');

        const highlight = await waitForMapViewDebugState(
            page,
            (state) => state.highlight?.active === true,
            'the Messenger focus highlight',
        );
        equal(highlight.highlight.kind, 'box', 'The Messenger focus highlight should be a box');
        assert(highlight.highlight.bbox, 'The Messenger focus highlight has no bbox');
        const highlightHalf = (MARKER_HIGHLIGHT_PX * focused.resolution) / 2;
        near(highlight.highlight.bbox[0], mapView.x - highlightHalf, 1, 'Messenger highlight minX is wrong');
        near(highlight.highlight.bbox[2], mapView.x + highlightHalf, 1, 'Messenger highlight maxX is wrong');
        log?.(`Messenger focused the marker at ${focused.x.toFixed(0)},${focused.y.toFixed(0)}`);

        await waitForMapViewDebugState(
            page,
            (state) => state.highlight === null,
            'the Messenger highlight to disappear',
            6000,
        );

        // ---- deleted marker: the Map provider owns the fallback ---------
        await deleteMarker(page, markerName);
        await waitForMarkerGone(page, markerName);

        await page.evaluate(({ x, y }) => {
            const api = window.TacPhone.interApp.list('map')[0]?.api;
            api.flyTo({ x, y, resolution: 0.2, animate: false });
        }, { x: away[0], y: away[1] });
        await waitForMapView(
            page,
            (view) => Math.hypot(view.x - away[0], view.y - away[1]) < 100,
            'the Map to move away for the deleted-marker check',
        );

        await card.click();
        await waitForMapView(
            page,
            (view) => Math.hypot(view.x - mapView.x, view.y - mapView.y) < 1,
            'the deleted marker fallback position',
        );
        await page.getByText('Marker no longer exists', { exact: true })
            .first()
            .waitFor({ state: 'visible', timeout: 10000 });
        await waitForMapViewDebugState(
            page,
            (state) => state.highlight?.active === true,
            'the deleted-marker highlight',
        );
        log?.('Deleted marker fallback focused its last known position');

        // ---- polyline marker: share and fit its whole bounding box -----
        const polylineView = await getMapView(page);
        assert(polylineView, 'The Map view is not ready for the polyline share');
        const halfX = polylineView.resolution * 180;
        const halfY = polylineView.resolution * 80;
        const polylinePoints = [
            polylineView.x - halfX, polylineView.y - halfY,
            polylineView.x + halfX, polylineView.y + halfY,
        ];
        const polylineLabel = `TacPhone polyline ${Date.now()}`;
        const polylineReply = await requestMap(page, 'CreateMarker', {
            marker: {
                shape: 'POLYLINE',
                position: [polylinePoints[0], polylinePoints[1]],
                polyline: polylinePoints,
                color: 'ColorBlue',
                label: polylineLabel,
            },
        });
        assert(
            typeof polylineReply?.name === 'string' && polylineReply.name !== '',
            'CreateMarker did not return a name for the polyline',
        );
        const polylineName = polylineReply.name;
        created.push(polylineName);
        await waitForMarkerInLayer(page, polylineName);
        await page.waitForTimeout(600);

        const mapBox2 = await page.locator('.ol-viewport').first().boundingBox();
        assert(mapBox2, 'The Map viewport has no layout box for the polyline share');
        // The line runs through the view center; right-click it there.
        await page.mouse.click(
            mapBox2.x + mapBox2.width / 2,
            mapBox2.y + mapBox2.height / 2,
            { button: 'right' },
        );
        await page.getByRole('menu', { name: 'Marker' }).waitFor({ state: 'visible', timeout: 10000 });
        await page.getByRole('menuitem', { name: 'Share to Messenger' }).click();

        const polylineShareDialog = page.getByRole('dialog', { name: 'Share to Messenger' });
        await polylineShareDialog.waitFor({ state: 'visible', timeout: 15000 });
        const polylineRoomOption = polylineShareDialog.getByRole('option', { name: new RegExp(roomName) });
        await polylineRoomOption.waitFor({ state: 'visible', timeout: 10000 });
        await polylineRoomOption.click();
        await polylineShareDialog.getByRole('button', { name: 'Share' }).click();
        await polylineShareDialog.waitFor({ state: 'detached', timeout: 15000 });

        const polylineAway = [polylineView.x + 4000, polylineView.y + 4000];
        await page.evaluate(({ x, y }) => {
            const api = window.TacPhone.interApp.list('map')[0]?.api;
            api.flyTo({ x, y, resolution: 0.2, animate: false });
        }, { x: polylineAway[0], y: polylineAway[1] });
        await waitForMapView(
            page,
            (view) => Math.hypot(view.x - polylineAway[0], view.y - polylineAway[1]) < 100,
            'the Map to move away for the polyline share',
        );

        const polylineCard = conversation.getByRole('button', { name: new RegExp(polylineLabel) }).first();
        await polylineCard.waitFor({ state: 'visible', timeout: 15000 });
        await polylineCard.click();

        const polylineFitWidth = Math.max(1, mapBox2.width - FLY_TO_MARGIN_PX * 2);
        const polylineFitHeight = Math.max(1, mapBox2.height - FLY_TO_MARGIN_PX * 2);
        const expectedPolylineResolution = Math.max(
            (halfX * 2) / polylineFitWidth,
            (halfY * 2) / polylineFitHeight,
        );
        const polylineFocused = await waitForMapView(
            page,
            (view) => Math.hypot(view.x - polylineView.x, view.y - polylineView.y) < 1,
            'the polyline bounding box to center the view',
        );
        near(
            polylineFocused.resolution,
            expectedPolylineResolution,
            expectedPolylineResolution * 0.05,
            'The polyline share used the wrong zoom',
        );
        const polylineHighlight = await waitForMapViewDebugState(
            page,
            (state) => state.highlight?.active === true,
            'the polyline share highlight',
        );
        equal(polylineHighlight.highlight.kind, 'box', 'A polyline highlight should be a box');
        near(polylineHighlight.highlight.bbox[0], polylineView.x - halfX, 1, 'Polyline highlight minX is wrong');
        near(polylineHighlight.highlight.bbox[1], polylineView.y - halfY, 1, 'Polyline highlight minY is wrong');
        near(polylineHighlight.highlight.bbox[2], polylineView.x + halfX, 1, 'Polyline highlight maxX is wrong');
        near(polylineHighlight.highlight.bbox[3], polylineView.y + halfY, 1, 'Polyline highlight maxY is wrong');
        log?.('Shared polyline fitted its bounding box and highlighted it');

        if (consoleErrors.length > 0) {
            throw new Error(`The page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        for (const markerName of created) {
            await deleteMarker(page, markerName);
            await waitForMarkerGone(page, markerName).catch(() => {});
        }

        await requestApp(page, 'Messaging', 'Messaging.Debug.Reset').catch(() => undefined);

        await page.close();
        await browser.close();
    }
}
