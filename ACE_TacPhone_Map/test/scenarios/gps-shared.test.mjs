/**
 * Browser checks for shared GPS routes (`map.gps_route`), driven directly
 * through the Map service instead of Messenger.
 *
 * The payload is built in the test from the documented `SharedRouteData` shape
 * and validated by the app's own decoder, so no app source is imported. All
 * coordinates are terrain-relative to the real player position and pointed at
 * the terrain centre, so nothing depends on where the map designer put roads or
 * water; only invariants (feature counts, styles, waypoint counts) are asserted.
 *
 * Live `GPS.Update` pushes are paused (`setLiveUpdates(false)`) and replaced with
 * one synthetic fix at the player position, because the dev mission spawns a
 * stationary player and the join logic must be deterministic.
 *
 *   $env:TACPHONE_TEST_URL = 'http://localhost:5173/'
 *   npm run test:map -- --scenario gps-shared --verbose
 */

import { assert, equal } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { requestApp } from '../../../ACE_TacPhone_Main/test/lib/host-page.mjs';
import { skip } from '../../../ACE_TacPhone_Main/test/lib/skip.mjs';
import {
    distance,
    getGpsDebug,
    gpsCall,
    gpsT,
    openGpsPage,
    pointAt,
    waitForGpsDebug,
} from '../lib/gps-page.mjs';
import { getMapView, waitForMapViewStable } from '../lib/map-page.mjs';

export const name = 'gps-shared';
export const kind = 'browser';
export const description = 'Shared route preview, discard, bad payload, start/join and replace confirmation';

/** Author written into the synthetic payload; asserted on the preview card. */
const AUTHOR = 'GPS test';
/** Label of the synthetic payload; the card title falls back to the shared title. */
const LABEL = 'Shared test route';
/** Distance from the player to the start of the shared line (metres). */
const CONNECTOR_M = 80;
/** Distance from the player to the end of the shared line (metres). */
const SHARED_M = 560;

/**
 * The two stroke colors `sharedStyle()` uses: the plain shared cyan for every
 * non-walk leg and the walk variant. The payload below is a pure walk leg.
 */
const SHARED_CYAN = 'rgba(34, 211, 238, 0.9)';
const SHARED_WALK_CYAN = 'rgba(56, 189, 248, 0.9)';

function near(actual, expected, tolerance, message) {
    assert(
        Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
        `${message}\n  expected: ${expected} ± ${tolerance}\n  actual:   ${actual}`,
    );
}

function point(state) {
    return [state.position[0], state.position[1]];
}

/** Opens the shared preview through the GPS service, like Messenger does. */
function openShared(page, data) {
    return page.evaluate(
        (payload) => window.TacPhone.interApp.list('gps')[0]?.api.openSharedRoute(payload),
        data,
    );
}

/**
 * Builds a flat `SharedRouteData` payload (version 1) relative to `origin`.
 * The leg starts `CONNECTOR_M` from the player so joining plans a connector.
 * @param {[number, number]} origin player position, the payload origin
 * @param {number} angleDeg direction towards the terrain centre
 * @param {{ width: number, height: number }} bounds
 */
function buildSharedPayload(origin, angleDeg, bounds) {
    const end = pointAt(origin, { angleDeg, distanceM: SHARED_M, bounds, margin: 60 });
    const delta = [end[0] - origin[0], end[1] - origin[1]];
    const length = Math.hypot(delta[0], delta[1]);

    if (length < 150) {
        skip(`The terrain around the player is too small for a shared route (${length.toFixed(0)} m available)`);
    }

    const along = (metres) => [
        origin[0] + (delta[0] / length) * metres,
        origin[1] + (delta[1] / length) * metres,
    ];

    const start = along(CONNECTOR_M);
    const mid = along(length * 0.55);
    const round = (value) => Math.round(value);

    // Integer metre offsets from the origin, exactly like `encodeSharedRoute`.
    const offsets = (worldPoint) => [
        round(worldPoint[0] - origin[0]),
        round(worldPoint[1] - origin[1]),
    ];

    const startOffset = offsets(start);
    const midOffset = offsets(mid);
    const endOffset = offsets(end);

    const legPoints = [...startOffset, ...midOffset, ...endOffset];
    const legLength = Math.hypot(midOffset[0] - startOffset[0], midOffset[1] - startOffset[1])
        + Math.hypot(endOffset[0] - midOffset[0], endOffset[1] - midOffset[1]);

    return {
        data: {
            v: 1,
            origin: [origin[0], origin[1]],
            // Waypoints are destinations only; the geometry starts at the player.
            waypoints: [...midOffset, ...endOffset],
            legs: [
                {
                    mode: 'foot',
                    kind: 'walk',
                    points: legPoints,
                    eta: Math.round(legLength / 1.4),
                },
            ],
            distance: legLength,
            eta: Math.round(legLength / 1.4),
            author: AUTHOR,
            createdAt: 1234,
            label: LABEL,
        },
        world: {
            start: [origin[0] + startOffset[0], origin[1] + startOffset[1]],
            mid: [origin[0] + midOffset[0], origin[1] + midOffset[1]],
            end: [origin[0] + endOffset[0], origin[1] + endOffset[1]],
        },
    };
}

export async function run({ pageUrl, options, log }) {
    const { browser, page, consoleErrors } = await openGpsPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
        log,
    });

    const card = page.getByTestId('gps-shared-card');

    try {
        const bounds = await gpsCall(page, 'getTerrainBounds');
        assert(
            bounds && bounds.width > 200 && bounds.height > 200,
            `The GPS has no usable terrain bounds (${JSON.stringify(bounds)})`,
        );

        const realPos = await requestApp(page, 'main', 'GetPlayerPos');
        assert(Array.isArray(realPos) && realPos.length >= 2, 'GetPlayerPos did not return a position array');
        const origin = [realPos[0], realPos[1]];

        // ---- deterministic fix at the real player position --------------
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
            'the seeded synthetic fix at the player position',
        );

        // Point the shared line at the terrain centre so the clamped end stays
        // inside the bounds whatever the player position is.
        const centre = [bounds.width / 2, bounds.height / 2];
        const towardsCentre = (Math.atan2(centre[0] - origin[0], centre[1] - origin[1]) * 180) / Math.PI;
        const angleDeg = Number.isFinite(towardsCentre) ? (towardsCentre + 360) % 360 : 90;

        const { data: shared, world } = buildSharedPayload(origin, angleDeg, bounds);
        log?.(`Shared payload: ${shared.distance.toFixed(0)} m walk leg, ${shared.waypoints.length / 2} waypoints`);

        // ---- 1. service path: preview -----------------------------------
        equal(await openShared(page, shared), true, 'openSharedRoute should accept the payload');
        const preview = await waitForGpsDebug(
            page,
            (state) => state.shared?.author === AUTHOR,
            'the shared route preview',
        );

        equal(preview.shared.mode, 'foot', 'A pure walk payload should preview in foot mode');
        near(preview.shared.distance, shared.distance, 1e-6, 'The preview distance should be the payload distance');
        equal(preview.shared.eta, shared.eta, 'The preview ETA should be the payload ETA');
        equal(preview.shared.waypointCount, 2, 'The preview should report both shared waypoints');
        equal(preview.shared.label, LABEL, 'The preview should keep the payload label');
        near(
            preview.shared.walkDistance,
            shared.distance,
            1e-6,
            'A pure walk payload should count its whole distance as walking',
        );

        await card.waitFor({ state: 'visible', timeout: 5000 });
        const cardText = (await card.textContent()) ?? '';
        assert(cardText.includes(LABEL), `The shared card should show its label, got "${cardText}"`);
        assert(
            cardText.includes(await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Shared_From', AUTHOR)),
            `The shared card should show who sent it, got "${cardText}"`,
        );

        const startLabel = await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Shared_Start');
        const discardLabel = await gpsT(page, 'str_a3_rscdisplaylogin_bx_discard');
        equal(
            await card.getByRole('button', { name: startLabel, exact: true }).count(),
            1,
            'The shared card should offer a Start button',
        );

        assert(preview.layers.shared.features >= 1, 'The preview should draw at least one feature');
        assert(preview.layers.shared.lineDash.length > 0, 'The shared preview must be dashed');
        assert(
            preview.layers.shared.colors.includes(SHARED_WALK_CYAN)
                || preview.layers.shared.colors.includes(SHARED_CYAN),
            `The preview should use a shared cyan stroke, got ${JSON.stringify(preview.layers.shared.colors)}`,
        );
        equal(preview.route, null, 'A preview must not replace the active route');
        equal(preview.navigating, false, 'A preview must not start navigation');
        log?.('Preview state, card and dashed cyan layer are correct');

        // ---- 2. discard --------------------------------------------------
        await waitForMapViewStable(page, 'the preview fly-to to settle');
        const beforeDiscard = await getMapView(page);
        assert(beforeDiscard, 'The Map view disappeared before the discard');

        await card.getByRole('button', { name: discardLabel, exact: true }).click();
        const discarded = await waitForGpsDebug(
            page,
            (state) => state.shared === null && state.layers.shared.features === 0,
            'Discard to remove the preview',
        );
        equal(discarded.waypoints.length, 0, 'Discard must not add local waypoints');

        await waitForMapViewStable(page, 'the view to settle after the discard');
        const afterDiscard = await getMapView(page);
        near(
            distance([afterDiscard.x, afterDiscard.y], [beforeDiscard.x, beforeDiscard.y]),
            0,
            1,
            'Discard must not move the map view',
        );
        log?.('Discard cleared the preview and left the view alone');

        // ---- 3. bad payload ----------------------------------------------
        const rejected = await openShared(page, { ...shared, v: 2 });
        equal(rejected, false, 'A payload with an unsupported version must be rejected');
        await page.getByTestId('gps-notice').waitFor({ state: 'visible', timeout: 4000 });
        const noticeText = await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Shared_Unavailable');
        const notice = (await page.getByTestId('gps-notice').textContent()) ?? '';
        assert(notice.includes(noticeText), `The notice should say "${noticeText}", got "${notice}"`);
        equal((await getGpsDebug(page)).shared, null, 'A rejected payload must not leave a preview');
        log?.('An unsupported payload was rejected with a localized notice');

        // ---- 4. start and join -------------------------------------------
        equal(await openShared(page, shared), true, 'openSharedRoute should accept the payload again');
        await card.waitFor({ state: 'visible', timeout: 5000 });
        await card.getByRole('button', { name: startLabel, exact: true }).click();

        const joined = await waitForGpsDebug(
            page,
            (state) => state.navigating === true && state.route?.source === 'shared',
            'the shared route to start',
            30000,
        );

        assert(joined.route.legs.length >= 1, 'The joined route needs at least one leg');
        equal(joined.route.legs[0].source, 'connector', 'Joining should plan a connector leg first');
        assert(joined.route.distance > 0, 'The joined route needs a positive distance');
        assert(joined.route.eta !== null && joined.route.eta > 0, 'The joined route needs a positive ETA');
        for (const leg of joined.route.legs) {
            assert(
                Number.isFinite(leg.distance) && Number.isFinite(leg.eta),
                'Every joined leg needs a finite distance and ETA',
            );
        }
        equal(joined.stale, false, 'A freshly joined route must not be stale');
        equal(joined.advisor, null, 'Joining in the same mode must not raise the advisor');

        // The local waypoint list is replaced by the shared destinations that are
        // still ahead. Both shared waypoints are ahead of the join point.
        equal(joined.waypoints.length, 2, 'Starting should keep both shared destinations');
        near(
            distance(joined.waypoints[joined.waypoints.length - 1], world.end),
            0,
            1,
            'The last waypoint should be the shared destination',
        );
        near(distance(joined.waypoints[0], world.mid), 0, 1, 'The first waypoint should be the shared mid point');
        equal(joined.layers.shared.features, 0, 'Starting should consume the preview layer');
        log?.(`Joined the shared route with a ${joined.route.legs.length}-leg route`);

        await gpsCall(page, 'stopNavigation');
        await gpsCall(page, 'clearWaypoints');
        await waitForGpsDebug(
            page,
            (state) => state.navigating === false && state.route === null,
            'navigation and the joined route to clear',
        );

        // ---- 5. replace confirmation -------------------------------------
        const localA = pointAt(origin, { angleDeg: (angleDeg + 60) % 360, distanceM: 250, bounds });
        const localB = pointAt(origin, { angleDeg: (angleDeg + 75) % 360, distanceM: 400, bounds });
        await gpsCall(page, 'setMode', 'foot');
        await gpsCall(page, 'setWaypoints', [localA, localB]);
        equal(await gpsCall(page, 'calculateRoute'), true, 'The local foot route should plan');
        await gpsCall(page, 'startNavigation');
        const local = await waitForGpsDebug(
            page,
            (state) => state.navigating === true && state.route?.source === 'planned',
            'the local route to start',
        );

        equal(await openShared(page, shared), true, 'openSharedRoute should accept the payload during navigation');
        await card.waitFor({ state: 'visible', timeout: 5000 });
        await card.getByRole('button', { name: startLabel, exact: true }).click();

        const confirmText = await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Shared_ReplaceConfirm');
        await page.getByText(confirmText, { exact: true }).first()
            .waitFor({ state: 'visible', timeout: 4000 });

        const stillLocal = await getGpsDebug(page);
        equal(stillLocal.navigating, true, 'The replace prompt must not stop the running navigation');
        equal(stillLocal.route.source, 'planned', 'The replace prompt must keep the local route');
        equal(stillLocal.shared?.author, AUTHOR, 'The preview should stay visible while the prompt is up');
        log?.('Starting over a running route asked for confirmation first');

        const replaceLabel = await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Shared_Replace');
        await card.getByRole('button', { name: replaceLabel, exact: true }).click();
        const replaced = await waitForGpsDebug(
            page,
            (state) => state.route?.source === 'shared' && state.navigating === true,
            'the replace confirmation to start the shared route',
            30000,
        );
        assert(replaced.route.distance > 0, 'The replaced route needs a positive distance');
        log?.(`Replace confirmation switched from the local route to the shared route (${local.route.distance.toFixed(0)} m -> ${replaced.route.distance.toFixed(0)} m)`);

        // Manual Recalculate on a shared route must plan a fresh local route to
        // the adopted waypoints, not just splice the old shared geometry.
        await gpsCall(page, 'recalculate');
        const recalculated = await waitForGpsDebug(
            page,
            (state) => state.route?.source === 'planned' && state.route !== null,
            'Recalculate to replace the shared route with a local plan',
            30000,
        );
        assert(
            recalculated.route.distance > 0,
            'The recalculated shared-route waypoints need a positive distance',
        );
        log?.(`Recalculate replaced the shared route with a ${recalculated.route.distance.toFixed(0)} m local plan`);

        if (consoleErrors.length > 0) {
            throw new Error(`The GPS page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        await gpsCall(page, 'discardSharedRoute').catch(() => {});
        await gpsCall(page, 'stopNavigation').catch(() => {});
        await gpsCall(page, 'clearWaypoints').catch(() => {});
        await gpsCall(page, 'setLiveUpdates', true).catch(() => {});
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}
