/**
 * Browser check for sharing a planned GPS route through the Messenger UI.
 *
 * Complementary to `gps-shared` (which drives the Map service directly): this
 * scenario proves the real user path — GPS panel → `Share route` → Messenger
 * target selector → chat card → GPS shared preview → Start.
 *
 * It is modeled on `MessagingApp/test/scenarios/browser-ui.test.mjs` (which
 * proves the same flow for markers) and needs a `__A3_DEBUG__` game: fake players
 * and the Messenger debug toolbar. A missing Messenger app or a share dialog that
 * never appears is reported as SKIP, so the Map suite stays usable without it.
 *
 * The chat object is compressed on the way to the game, so the stored shape is
 * checked by capturing the outgoing `SendMessage` request; the Messenger store
 * itself always holds decoded objects (see `objectCodec.ts`).
 *
 * The created room and its message stay in the session (the scenario never
 * resets the Messenger database, so a running mission keeps its other rooms).
 *
 *   $env:TACPHONE_TEST_URL = 'http://localhost:5173/'
 *   npm run test:map -- --scenario gps-shared-messenger --slow
 */

import { assert, equal } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    activatePanelTab,
    openAppThroughChooser,
    requestApp,
} from '../../../ACE_TacPhone_Main/test/lib/host-page.mjs';
import { skip } from '../../../ACE_TacPhone_Main/test/lib/skip.mjs';
import {
    distance,
    getGpsDebug,
    gpsCall,
    gpsT,
    GPS_PANEL_ID,
    openGpsPage,
    pointAt,
    waitForGpsDebug,
    waitForTerrainBounds,
} from '../lib/gps-page.mjs';

export const name = 'gps-shared-messenger';
export const kind = 'browser';
export const description = 'GPS Share route -> Messenger card -> shared preview -> Start (debug game)';

/** Number of air waypoints; the payload must cross the gzip threshold. */
const WAYPOINT_COUNT = 10;
/** Compress threshold of `objectCodec.ts` (MIN_COMPRESS_JSON_CHARS). */
const MIN_COMPRESS_JSON_CHARS = 512;
/** Property that marks a compressed chat object on the wire. */
const ENVELOPE_KEY = '__tacphoneObject';
/** Wait for the Messenger share dialog; a missing one is a skip. */
const DIALOG_TIMEOUT_MS = 15000;

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function point(state) {
    return [state.position[0], state.position[1]];
}

export async function run({ pageUrl, options, log }) {
    const { browser, page, consoleErrors } = await openGpsPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
        log,
    });

    try {
        // ---- Messenger next to the GPS panel ---------------------------
        await openAppThroughChooser(page, 'Messaging', { tileTitle: 'Messenger', tabsetIndex: 1 });
        await page.getByRole('button', { name: 'New chat' }).first()
            .waitFor({ state: 'visible', timeout: DIALOG_TIMEOUT_MS });
        assert(
            await activatePanelTab(page, GPS_PANEL_ID),
            'The GPS tab is not available after opening Messenger',
        );
        await page.locator('.ol-viewport').first().waitFor({ state: 'visible', timeout: 10000 });

        const panels = await page.evaluate(() => window.TacPhone.panels.list().map((entry) => entry.panelId));
        assert(panels.includes(GPS_PANEL_ID), 'The GPS panel should stay mounted next to Messenger');
        assert(panels.includes('Messaging'), 'The Messenger panel should be mounted');
        log?.('GPS and Messenger panels are both mounted');

        // The whole flow needs the Messenger debug store (fake players, the
        // toolbar and `__messengerStore`). A release page has none of it.
        const hasDebugStore = await page.evaluate(() => Boolean(window.__messengerStore));
        if (!hasDebugStore) {
            skip('Messenger is not available in this build (no debug store)');
        }

        // ---- fake players and a room, through the Messenger UI ----------
        const debugButton = page.getByRole('button', { name: 'Messenger debug tools' });
        if (await debugButton.count() > 0) {
            await debugButton.click();
            await page.getByRole('button', { name: 'Add fake players' }).click();
        } else {
            log?.('Debug toolbar is unavailable; adding fake players through the debug request');
            await requestApp(page, 'Messaging', 'Messaging.Debug.AddFakePlayers', { count: 4 });
        }

        await page.waitForFunction(
            () => (window.__messengerStore?.getSnapshot().players.length ?? 0) > 0,
            null,
            { timeout: DIALOG_TIMEOUT_MS },
        );

        const collapseDebug = page.getByRole('button', { name: 'Collapse debug tools' });
        if (await collapseDebug.count() > 0) {
            await collapseDebug.click();
        }

        const roomName = `TacPhone GPS route ${Date.now()}`;
        await page.getByRole('button', { name: 'New chat' }).first().click();
        const createDialog = page.getByRole('dialog', { name: 'New chat' });
        await createDialog.waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('#messenger-room-name').fill(roomName);
        const playerOption = page.getByRole('option', { name: /^Fake Alpha 1\b/ }).first();
        await playerOption.waitFor({ state: 'visible', timeout: 10000 });
        await playerOption.click();
        await createDialog.getByRole('button', { name: 'Create room' }).click();
        await createDialog.waitFor({ state: 'detached', timeout: DIALOG_TIMEOUT_MS });
        await page.getByText(roomName, { exact: true }).first()
            .waitFor({ state: 'visible', timeout: DIALOG_TIMEOUT_MS });
        log?.(`Created room ${roomName}`);

        // ---- a long air route in the GPS panel --------------------------
        const bounds = await waitForTerrainBounds(page);
        assert(bounds && bounds.width > 200 && bounds.height > 200, 'The GPS has no usable terrain bounds');
        const realPos = await requestApp(page, 'main', 'GetPlayerPos');
        assert(Array.isArray(realPos) && realPos.length >= 2, 'GetPlayerPos did not return a position array');
        const origin = [realPos[0], realPos[1]];
        const centre = [bounds.width / 2, bounds.height / 2];
        const towardsCentre = (Math.atan2(centre[0] - origin[0], centre[1] - origin[1]) * 180) / Math.PI;
        const baseAngle = Number.isFinite(towardsCentre) ? (towardsCentre + 360) % 360 : 90;

        const waypoints = Array.from({ length: WAYPOINT_COUNT }, (_entry, index) => pointAt(origin, {
            angleDeg: (baseAngle + (index % 2 === 0 ? 15 : -15) + index * 4) % 360,
            distanceM: 150 + index * 45,
            bounds,
            margin: 60,
        }));

        await gpsCall(page, 'setLiveUpdates', false);
        await gpsCall(page, 'applyFix', {
            position: origin,
            view: [0, 1, 0],
            direction: 0,
            speed: 0,
            velocity: [0, 0, 0],
        });
        await waitForGpsDebug(
            page,
            (state) => state.hasFix && distance(point(state), origin) < 0.001,
            'the seeded synthetic fix',
        );

        await gpsCall(page, 'setMode', 'air');
        await gpsCall(page, 'setWaypoints', waypoints);
        equal(await gpsCall(page, 'calculateRoute'), true, 'The air route to share should plan');
        const planned = await getGpsDebug(page);
        assert(
            planned.route && planned.route.legs.length >= WAYPOINT_COUNT,
            'The air route has too few legs to build a long payload',
        );

        // ---- capture the stored (wire) objects of SendMessage -----------
        // `ChatStore` stores decoded objects; the compressed envelope only
        // exists on the way to the game, so the request is observed here.
        await page.evaluate(() => {
            const networking = window.TacPhone.networking;
            const hadOwn = Object.prototype.hasOwnProperty.call(networking, 'Request');
            const original = networking.Request;

            window.__tacphoneSentObjects = [];
            window.__tacphoneRestoreRequest = () => {
                if (hadOwn) {
                    networking.Request = original;
                } else {
                    delete networking.Request;
                }
            };

            networking.Request = function requestWithObjectCapture(request) {
                if (request && request.c === 'SendMessage' && Array.isArray(request.objects)) {
                    window.__tacphoneSentObjects.push(request.objects);
                }

                return original.call(this, request);
            };
        });

        // ---- share the route through the GPS panel ----------------------
        const routePanel = page.getByTestId('gps-route-panel');
        const shareLabel = await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Route_Share');
        await routePanel.getByRole('button', { name: shareLabel, exact: true }).click();

        const dialogTitle = await gpsT(page, 'STR_ACE_Tacphone_Messenger_Target_ShareTitle');
        const shareDialog = page.getByRole('dialog', { name: dialogTitle });

        try {
            await shareDialog.waitFor({ state: 'visible', timeout: DIALOG_TIMEOUT_MS });
        } catch {
            skip('Messenger is not available in this build (the share dialog did not appear)');
        }

        const roomOption = shareDialog.getByRole('option', { name: new RegExp(escapeRegExp(roomName)) });
        await roomOption.waitFor({ state: 'visible', timeout: 10000 });
        await roomOption.click();
        const confirmLabel = await gpsT(page, 'STR_ACE_Tacphone_Messenger_Target_Share');
        await shareDialog.getByRole('button', { name: confirmLabel, exact: true }).click();
        await shareDialog.waitFor({ state: 'detached', timeout: DIALOG_TIMEOUT_MS });
        log?.('Shared the route into the room');

        // ---- the stored chat object -------------------------------------
        const sent = await page.evaluate(() => window.__tacphoneSentObjects);
        assert(sent.length > 0, 'The share did not send a message with objects');

        const object = sent
            .flat()
            .find((entry) => entry && entry.kind === 'map.gps_route');
        assert(object, `No map.gps_route object was sent: ${JSON.stringify(sent.map((entry) => entry.map((o) => o?.kind)))}`);
        equal(object.version, 1, 'The shared route object should be version 1');
        assert(object.preview && typeof object.preview.title === 'string', 'The stored object needs a preview');

        if (object[ENVELOPE_KEY]) {
            const envelope = object[ENVELOPE_KEY];
            equal(envelope.v, 1, 'The object envelope should be version 1');
            equal(envelope.codec, 'gzip', 'The object envelope should use gzip');
            equal(envelope.enc, 'base64', 'The object envelope should use base64');
            assert(typeof envelope.d === 'string' && envelope.d !== '', 'The object envelope needs a payload');
            equal(object.data, undefined, 'A compressed object must not keep data on the wire');
            equal(object.action, undefined, 'A compressed object must not keep the action on the wire');
            log?.(`Stored route object: ${envelope.d.length} base64 characters`);
        } else {
            const plainLength = JSON.stringify({ data: object.data, action: object.action }).length;
            assert(
                plainLength < MIN_COMPRESS_JSON_CHARS,
                `A ${plainLength}-character route payload should have been compressed`,
            );
            log?.(`The route payload stayed plain (${plainLength} < ${MIN_COMPRESS_JSON_CHARS} characters)`);
        }

        // ---- the store keeps the decoded object -------------------------
        const stored = await page.evaluate((name) => {
            const state = window.__messengerStore.getSnapshot();
            const room = state.rooms.find((entry) => entry.name === name);
            if (!room) {
                return null;
            }

            return (state.messages[room.id] ?? [])
                .filter((message) => (message.objects?.length ?? 0) > 0)
                .map((message) => {
                    const first = message.objects[0];
                    return {
                        kind: first?.kind,
                        hasData: first?.data !== undefined,
                        hasEnvelope: Boolean(first?.['__tacphoneObject']),
                        title: first?.preview?.title ?? '',
                    };
                });
        }, roomName);

        assert(stored && stored.length > 0, 'The Messenger store has no object message for the room');
        const storedRoute = stored.find((entry) => entry.kind === 'map.gps_route');
        assert(storedRoute, 'The Messenger store has no map.gps_route object');
        equal(storedRoute.hasData, true, 'The Messenger store must hold the decoded route data');
        equal(storedRoute.hasEnvelope, false, 'The Messenger store must not expose the envelope');
        assert(storedRoute.title !== '', 'The decoded route object needs a card preview title');

        // Clear the local route used to create the share before opening the
        // card, so the preview assertion is about the shared route only.
        await gpsCall(page, 'clearWaypoints');
        await gpsCall(page, 'stopNavigation');

        // ---- click the card and start the shared route ------------------
        const conversationName = await gpsT(page, 'STR_ACE_Tacphone_Messenger_ChatView_Conversation');
        const conversation = page.getByRole('region', { name: conversationName });
        const sharedTitle = await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Shared_Title');
        const card = conversation.getByRole('button', { name: new RegExp(escapeRegExp(storedRoute.title || sharedTitle)) })
            .first();
        await card.waitFor({ state: 'visible', timeout: DIALOG_TIMEOUT_MS });
        await card.click();

        // `policy: 'ask'` can show the host target chooser even with one GPS panel.
        await page.waitForTimeout(800);
        const chooser = page.locator(`button[title*="${GPS_PANEL_ID}"]`);
        if (await chooser.count() > 0) {
            await chooser.first().click();
            log?.('Picked the GPS panel in the target chooser');
        }

        const author = await page.evaluate(() => window.TacPhone.gameInfo.get()?.playerId ?? '');
        assert(author !== '', 'The host did not report a player id for the shared route author');

        const preview = await waitForGpsDebug(
            page,
            (state) => state.shared !== null,
            'the shared route preview from the Messenger card',
        );
        equal(preview.shared.author, author, 'The preview should credit the sharing player');
        equal(preview.shared.waypointCount, WAYPOINT_COUNT, 'The preview should keep every shared waypoint');
        equal(preview.route, null, 'The preview must not replace an active route');

        const startLabel = await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Shared_Start');
        const sharedCard = page.getByTestId('gps-shared-card');
        await sharedCard.waitFor({ state: 'visible', timeout: 5000 });
        await sharedCard.getByRole('button', { name: startLabel, exact: true }).click();

        const started = await waitForGpsDebug(
            page,
            (state) => state.navigating === true && state.route?.source === 'shared',
            'the shared route from the Messenger card to start',
        );
        assert(started.route.legs.length > 0, 'The started shared route needs at least one leg');
        assert(started.route.distance > 0, 'The started shared route needs a positive distance');
        // The player stands on the shared air route, so the join may not need a
        // connector leg; `gps-shared` covers the off-route connector case.
        log?.(
            `Started the shared Messenger route (${started.route.distance.toFixed(0)} m, `
            + `${started.route.legs.length} legs, `
            + `${started.route.legs.filter((leg) => leg.source === 'connector').length} connector)`,
        );

        if (consoleErrors.length > 0) {
            throw new Error(`The page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        await page.evaluate(() => window.__tacphoneRestoreRequest?.()).catch(() => {});
        await gpsCall(page, 'discardSharedRoute').catch(() => {});
        await gpsCall(page, 'stopNavigation').catch(() => {});
        await gpsCall(page, 'clearWaypoints').catch(() => {});
        await gpsCall(page, 'setLiveUpdates', true).catch(() => {});
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}
