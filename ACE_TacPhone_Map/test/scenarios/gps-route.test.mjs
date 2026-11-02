/**
 * Browser checks for GPS waypoints, per-mode route planning and navigation.
 *
 * The scenario is layout independent: every coordinate is terrain-relative to
 * the real player position and clamped by `pointAt()`, so nothing depends on
 * where the map designer put roads or water. Only invariants are asserted
 * (leg kinds, speed bounds, feature counts), never a specific path.
 *
 * Live `GPS.Update` pushes are paused (`setLiveUpdates(false)`) and replaced
 * with synthetic fixes, because the dev mission spawns a stationary player and
 * the assertions need a deterministic position, heading and speed.
 *
 *   $env:TACPHONE_TEST_URL = 'http://localhost:5173/'
 *   npm run test:map -- --scenario gps-route --verbose
 */

import { assert, equal } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { requestApp } from '../../../ACE_TacPhone_Main/test/lib/host-page.mjs';
import {
    distance,
    getGpsDebug,
    gpsCall,
    gpsPixel,
    gpsT,
    openGpsPage,
    pointAt,
    waitForGpsDebug,
} from '../lib/gps-page.mjs';
import { getMapView, waitForMapView, waitForMapViewStable } from '../lib/map-page.mjs';

export const name = 'gps-route';
export const kind = 'browser';
export const description = 'Waypoint clicks, air/foot/ground/boat routes, start/stop/follow and layer cleanup';

/** Speed of a synthetic fix that counts as moving (m/s). */
const FIX_SPEED = 4;
/** Vehicle velocity matching `FIX_SPEED` along +X. */
const FIX_VELOCITY = [FIX_SPEED, 0, 0];
/** Heading of the moving fix: +X is east, so 90 degrees. */
const FIX_HEADING = 90;
/** Waypoints are placed within this many resolutions of the clicked pixel. */
const CLICK_TOLERANCE_PIXELS = 2;
/** `followSuspendedUntil` is 5000 ms after a pan; check well inside it. */
const FOLLOW_SUSPENSION_WINDOW_MS = 4000;

function near(actual, expected, tolerance, message) {
    assert(
        Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
        `${message}\n  expected: ${expected} ± ${tolerance}\n  actual:   ${actual}`,
    );
}

function point(state) {
    return [state.position[0], state.position[1]];
}

/** Every leg of every planned route collected on the way, for the invariants. */
function legInvariants(route, label) {
    for (const leg of route.legs) {
        assert(
            Number.isInteger(leg.pointCount) && leg.pointCount >= 2,
            `${label}: a leg needs at least two points (got ${leg.pointCount})`,
        );
        assert(
            Number.isFinite(leg.distance) && leg.distance >= 0,
            `${label}: a leg has an invalid distance (${leg.distance})`,
        );
        assert(
            Number.isFinite(leg.eta) && leg.eta >= 0,
            `${label}: a leg has an invalid eta (${leg.eta})`,
        );
    }
}

function statusOf(state) {
    return state?.status?.kind ?? 'no status';
}

export async function run({ pageUrl, options, log }) {
    const { browser, page, consoleErrors } = await openGpsPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
        log,
        // The test seeds a stationary fix immediately; a live moving player
        // keeps reloading GPS tiles and would never reach a quiet window.
        waitForQuiet: false,
    });

    const panel = page.getByTestId('gps-route-panel');
    const viewport = page.locator('.ol-viewport').first();

    try {
        const box = await viewport.boundingBox();
        assert(box, 'The OpenLayers viewport has no layout box');

        const bounds = await gpsCall(page, 'getTerrainBounds');
        assert(
            bounds && bounds.width > 200 && bounds.height > 200,
            `The GPS has no usable terrain bounds (${JSON.stringify(bounds)})`,
        );

        const realPos = await requestApp(page, 'main', 'GetPlayerPos');
        assert(
            Array.isArray(realPos) && realPos.length >= 2,
            'GetPlayerPos did not return a position array',
        );
        const origin = [realPos[0], realPos[1]];

        // ---- deterministic fix -----------------------------------------
        await gpsCall(page, 'setLiveUpdates', false);
        await gpsCall(page, 'applyFix', {
            position: origin,
            view: [0, 1, 0],
            direction: 0,
            speed: 0,
            velocity: [0, 0, 0],
        });
        const seeded = await waitForGpsDebug(
            page,
            (state) => state.hasFix && state.speed === 0,
            'the seeded synthetic fix at the player position',
        );
        near(distance(point(seeded), origin), 0, 0.001, 'The seeded fix should be the player position');
        log?.(`Seeded fix at ${origin[0].toFixed(0)},${origin[1].toFixed(0)} (heading 0, speed 0)`);

        // Debug-only viewport scan: it must produce a grid and a cost layer
        // without planning a route.
        const debugToggle = page.getByTestId('gps-debug-toggle');
        if (await debugToggle.count()) {
            await debugToggle.click();
            await page.getByTestId('gps-debug-scan').click();
            const scanned = await waitForGpsDebug(
                page,
                (state) => state.debug?.hasGrid === true,
                'the debug viewport scan',
            );
            assert(scanned.debug.costLayer, 'The debug scan did not create a cost layer');
            await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
            const readout = page.getByTestId('gps-debug-readout');
            await readout.waitFor({ state: 'visible', timeout: 5000 });
            assert(
                (await readout.textContent())?.includes('Cost:'),
                'The debug hover readout does not show the cost',
            );

            await page.getByTestId('gps-debug-panel').locator('input[type=checkbox]').nth(1).check();
            await waitForGpsDebug(
                page,
                (state) => state.debug?.heightLayer === true,
                'the height overlay layer',
            );
            await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
            assert(
                (await readout.textContent())?.includes('Height:'),
                'The debug hover readout does not show the height',
            );
            log?.('Debug viewport scan produced cost/height layers and a hover readout');
            await debugToggle.click();
        }

        // ---- 1. waypoints by map click ---------------------------------
        const addLabel = await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Route_AddWaypoint');
        const clearLabel = await gpsT(page, 'str_disp_arcmap_clear');
        const hintText = await gpsT(page, 'STR_ACE_Tacphone_Map_Gps_Route_PlanningHint');

        const addButton = panel.getByRole('button', { name: addLabel, exact: true });
        await addButton.click();
        await page.waitForFunction(
            (label) => {
                const buttons = [...document.querySelectorAll('[data-testid="gps-route-panel"] button')];
                const button = buttons.find((entry) => (entry.textContent ?? '').trim() === label);
                return button?.getAttribute('aria-pressed') === 'true';
            },
            addLabel,
            { timeout: 5000 },
        );
        equal(await addButton.getAttribute('aria-pressed'), 'true', 'Add waypoint should switch planning on');
        await waitForGpsDebug(page, (state) => state.planning === true, 'planning mode');
        await panel.getByText(hintText, { exact: false }).first()
            .waitFor({ state: 'visible', timeout: 5000 });

        const firstPoint = pointAt(origin, { angleDeg: 0, distanceM: 300, bounds });
        const secondPoint = pointAt(origin, { angleDeg: 60, distanceM: 500, bounds });

        const allX = [origin[0], firstPoint[0], secondPoint[0]];
        const allY = [origin[1], firstPoint[1], secondPoint[1]];
        const spanX = Math.max(...allX) - Math.min(...allX);
        const spanY = Math.max(...allY) - Math.min(...allY);
        const fitResolution = Math.max(
            0.05,
            Math.max(spanX / (box.width * 0.6), spanY / (box.height * 0.6)),
        );
        const contentCenter = [
            (Math.max(...allX) + Math.min(...allX)) / 2,
            (Math.max(...allY) + Math.min(...allY)) / 2,
        ];
        // Shift the view so the content sits in the upper-left 70% of the map:
        // the route panel is anchored to the bottom-right, and a waypoint under
        // the panel would swallow the click.
        const viewCenter = [
            contentCenter[0] + box.width * 0.15 * fitResolution,
            contentCenter[1] - box.height * 0.10 * fitResolution,
        ];

        await page.evaluate(
            ({ x, y, resolution }) => {
                window.TacPhone.interApp.list('map')[0]?.api
                    .flyTo({ x, y, resolution, animate: false });
            },
            { x: viewCenter[0], y: viewCenter[1], resolution: fitResolution },
        );
        const fitted = await waitForMapView(
            page,
            (view) => Math.abs(view.resolution - fitResolution) <= fitResolution * 0.02,
            'flyTo to frame both waypoints',
        );
        const resolution = fitted.resolution;

        // The panel grows upward as waypoints are added, so re-measure before
        // every click instead of trusting the first box.
        const isUnderPanel = async (pixel) => {
            const current = await panel.boundingBox();
            return current !== null
                && box.x + pixel[0] >= current.x
                && box.x + pixel[0] <= current.x + current.width
                && box.y + pixel[1] >= current.y
                && box.y + pixel[1] <= current.y + current.height;
        };

        const firstPixel = await gpsPixel(page, firstPoint);
        assert(firstPixel, 'The first waypoint is outside the viewport after flyTo');
        assert(
            firstPixel[0] >= 0 && firstPixel[0] <= box.width
                && firstPixel[1] >= 0 && firstPixel[1] <= box.height,
            `The first waypoint pixel is outside the viewport: ${JSON.stringify(firstPixel)}`,
        );
        assert(
            !(await isUnderPanel(firstPixel)),
            'The first waypoint pixel is covered by the route panel; the click would not reach the map',
        );

        await page.mouse.click(box.x + firstPixel[0], box.y + firstPixel[1]);
        const afterFirst = await waitForGpsDebug(
            page,
            (state) => state.waypoints.length === 1,
            'the first map-click waypoint',
        );
        near(
            distance(afterFirst.waypoints[0], firstPoint),
            0,
            CLICK_TOLERANCE_PIXELS * resolution,
            'The first waypoint is not where the click landed',
        );
        equal(afterFirst.planning, true, 'Clicking a waypoint should keep planning on');
        equal(afterFirst.layers.waypoints.features, 1, 'One waypoint should draw one feature');
        const firstPreview = await waitForGpsDebug(
            page,
            (state) => state.route !== null,
            'the live route preview after the first waypoint',
        );
        equal(firstPreview.route?.source, 'planned', 'The live preview should be a planned route');

        const secondPixel = await gpsPixel(page, secondPoint);
        assert(secondPixel, 'The second waypoint is outside the viewport after flyTo');
        assert(
            !(await isUnderPanel(secondPixel)),
            'The second waypoint pixel is covered by the route panel',
        );
        await page.mouse.click(box.x + secondPixel[0], box.y + secondPixel[1]);
        const afterSecond = await waitForGpsDebug(
            page,
            (state) => state.waypoints.length === 2,
            'the second map-click waypoint',
        );
        near(
            distance(afterSecond.waypoints[1], secondPoint),
            0,
            CLICK_TOLERANCE_PIXELS * resolution,
            'The second waypoint is not where the click landed',
        );
        equal(afterSecond.layers.waypoints.features, 2, 'Two waypoints should draw two features');
        equal(
            await page.locator('[data-testid="gps-waypoint-list"] li').count(),
            2,
            'The waypoint list should list both waypoints',
        );
        log?.(`Placed two waypoints by map click (resolution ${resolution})`);

        // The second waypoint is draggable, like a polyline vertex.
        const beforeDrag = await waitForGpsDebug(
            page,
            (state) => state.route !== null,
            'the live route preview after the second waypoint',
        );
        const dragFrom = await gpsPixel(page, beforeDrag.waypoints[0]);
        assert(dragFrom, 'The first waypoint has no pixel to drag');
        const dragTo = [dragFrom[0] + 36, dragFrom[1] + 28];
        await page.mouse.move(box.x + dragFrom[0], box.y + dragFrom[1]);
        await page.mouse.down();
        await page.mouse.move(box.x + dragTo[0], box.y + dragTo[1], { steps: 6 });
        await page.mouse.up();
        const afterDrag = await waitForGpsDebug(
            page,
            (state) => distance(state.waypoints[0], beforeDrag.waypoints[0]) > 10,
            'the dragged waypoint',
        );
        near(
            distance(afterDrag.waypoints[1], beforeDrag.waypoints[1]),
            0,
            1,
            'Dragging one waypoint must not move the other',
        );
        assert(afterDrag.route !== null, 'The route preview must survive a waypoint drag');
        log?.('Dragged a waypoint and updated the preview');

        await panel.getByRole('button', { name: clearLabel, exact: true }).click();
        const clearedByButton = await waitForGpsDebug(
            page,
            (state) => state.waypoints.length === 0 && state.route === null,
            'Clear to remove the waypoints',
        );
        equal(clearedByButton.layers.waypoints.features, 0, 'Clear should remove the waypoint features');

        const waypointA = firstPoint;
        const waypointB = secondPoint;
        const straightLine = distance(origin, waypointA) + distance(waypointA, waypointB);
        const routes = [];

        // ---- 2. air route (exact, layout independent) ------------------
        await gpsCall(page, 'setMode', 'air');
        await gpsCall(page, 'setWaypoints', [waypointA, waypointB]);
        equal(await gpsCall(page, 'calculateRoute'), true, 'The air route should plan');

        const air = await getGpsDebug(page);
        assert(air.route, 'No air route after calculateRoute resolved true');
        equal(air.route.source, 'planned', 'The air route should be a planned route');
        equal(air.route.legs.length, 2, 'The air route should have one leg per waypoint');

        for (const leg of air.route.legs) {
            equal(leg.kind, 'air', 'An air route should only have air legs');
            equal(leg.mode, 'air', 'An air route should plan in air mode');
        }

        near(
            air.route.legs[0].distance,
            distance(origin, waypointA),
            1,
            'The first air leg is not the straight line to the first waypoint',
        );
        near(
            air.route.legs[1].distance,
            distance(waypointA, waypointB),
            1,
            'The second air leg is not the straight line to the second waypoint',
        );
        near(air.route.distance, straightLine, 2, 'The air route distance is not the sum of its legs');
        assert(air.route.eta !== null && air.route.eta > 0, 'The air route needs a positive ETA');
        const airSpeed = air.route.distance / air.route.eta;
        assert(
            airSpeed >= 20 && airSpeed <= 120,
            `The air route speed ${airSpeed.toFixed(1)} m/s is outside [20, 120]`,
        );
        equal(air.layers.route.features, 2, 'The air route should draw one feature per leg');
        assert(
            air.layers.route.lineDash.length > 0,
            'Air legs should be drawn dashed',
        );
        legInvariants(air.route, 'air');
        routes.push({ label: 'air', route: air.route });
        log?.(`Air route: ${air.route.distance.toFixed(0)} m at ${airSpeed.toFixed(1)} m/s`);

        // ---- 3. foot route ---------------------------------------------
        await gpsCall(page, 'setMode', 'foot');
        await gpsCall(page, 'setWaypoints', [waypointA, waypointB]);
        const footPlanned = await gpsCall(page, 'calculateRoute');
        const foot = await getGpsDebug(page);

        assert(
            footPlanned === true && foot.route,
            `The foot route failed (${statusOf(foot)})`,
        );
        for (const leg of foot.route.legs) {
            assert(
                leg.kind === 'walk' || leg.kind === 'water',
                `A foot route may only have walk/water legs (got ${leg.kind})`,
            );
            equal(leg.mode, 'foot', 'A foot route should plan in foot mode');
        }

        assert(
            foot.route.distance >= straightLine * 0.95,
            `The foot route (${foot.route.distance.toFixed(0)} m) is shorter than the straight line`,
        );
        assert(
            foot.route.distance <= straightLine * 6,
            `The foot route (${foot.route.distance.toFixed(0)} m) is more than 6x the straight line`,
        );

        for (const leg of foot.route.legs) {
            const legSpeed = leg.distance / leg.eta;
            if (leg.kind === 'water') {
                near(legSpeed, 0.5, 0.02, 'A water leg should travel at the swim speed');
            } else {
                assert(
                    legSpeed >= 5 / 3.6 * 0.98 && legSpeed <= 14 / 3.6 * 1.02,
                    `A walk leg speed ${legSpeed.toFixed(2)} m/s is outside the 5–14 km/h foot range`,
                );
            }
        }

        legInvariants(foot.route, 'foot');

        // The second identical foot plan must reuse the coarse height grid and
        // the peak/ring cache instead of requesting the same heights again.
        const firstCoarse = foot.heights.coarseRequests;
        await gpsCall(page, 'calculateRoute');
        const repeatedFoot = await getGpsDebug(page);
        assert(
            repeatedFoot.heights.coarseRequests === firstCoarse,
            `A repeated foot plan requested ${repeatedFoot.heights.coarseRequests - firstCoarse} new coarse height chunk(s)`,
        );
        log?.(`Height cache reused across foot plans (${repeatedFoot.heights.coarseRequests} coarse requests total)`);
        routes.push({ label: 'foot', route: foot.route });
        log?.(`Foot route: ${foot.route.distance.toFixed(0)} m in ${foot.route.legs.length} legs`);

        // ---- 4. ground route -------------------------------------------
        await gpsCall(page, 'setMode', 'ground');
        let ground = null;

        for (const bearing of [0, 90, 270]) {
            const candidateA = pointAt(origin, { angleDeg: bearing, distanceM: 300, bounds });
            const candidateB = pointAt(origin, { angleDeg: bearing + 60, distanceM: 500, bounds });
            await gpsCall(page, 'setWaypoints', [candidateA, candidateB]);
            const planned = await gpsCall(page, 'calculateRoute');
            const state = await getGpsDebug(page);

            if (planned === true && state.route) {
                ground = state;
                if (bearing !== 0) {
                    log?.(`Ground route planned on the fallback bearing ${bearing}`);
                }
                break;
            }

            log?.(`Ground route on bearing ${bearing} failed (${statusOf(state)})`);
        }

        assert(ground, 'No ground route could be planned on this terrain with 3 bearings');
        equal(ground.mode, 'ground', 'The ground route should plan in ground mode');

        for (const leg of ground.route.legs) {
            assert(
                ['road', 'offroad', 'water'].includes(leg.kind),
                `A ground route may only have road/offroad/water legs (got ${leg.kind})`,
            );
            const legSpeed = leg.distance / leg.eta;
            assert(
                legSpeed >= 0.5 && legSpeed <= 40,
                `A ground leg speed of ${legSpeed.toFixed(2)} m/s is outside [0.5, 40]`,
            );
        }

        if (ground.waterCapable !== true) {
            equal(
                ground.route.legs.filter((leg) => leg.kind === 'water').length,
                0,
                'A non-amphibious ground route must not have water legs',
            );
        }

        if (ground.road && ground.road.nodes > 0) {
            const goal = ground.waypoints[ground.waypoints.length - 1];
            const roadQuery = await gpsCall(page, 'debugRoadQuery', origin, goal);
            if (roadQuery?.startNode !== null && roadQuery?.goalNode !== null) {
                assert(
                    Number.isFinite(roadQuery.pathLength) && roadQuery.pathLength > 0,
                    'The road graph has connected nodes but findPath returned no length',
                );
                log?.(`Road graph: ${ground.road.polylines} polylines, ${ground.road.nodes} nodes, ${ground.road.segments} segments, ${roadQuery.pathLength.toFixed(0)} m path`);
            }
        }

        const roadLegs = ground.route.legs.filter((leg) => leg.kind === 'road');
        const offroadLegs = ground.route.legs.filter((leg) => leg.kind === 'offroad');
        if (roadLegs.length > 0 && offroadLegs.length > 0) {
            const average = (legs) => legs.reduce((total, leg) => total + leg.distance / leg.eta, 0) / legs.length;
            const road = average(roadLegs);
            const offroad = average(offroadLegs);
            assert(
                road >= offroad * 0.95,
                `Road legs (${road.toFixed(2)} m/s) should not be slower than offroad legs (${offroad.toFixed(2)} m/s)`,
            );
            log?.(`Ground speeds: road ${road.toFixed(2)} m/s, offroad ${offroad.toFixed(2)} m/s`);
        }

        if (ground.detectedMode === 'ground') {
            const maxSpeed = await requestApp(page, 'ACE_TacPhone_Map', 'GetPlayerTravelMode');
            const limit = Number(maxSpeed?.performance?.maxSpeedKmh) / 3.6 * 0.8;
            if (Number.isFinite(limit) && limit > 0) {
                for (const leg of roadLegs) {
                    assert(
                        leg.distance / leg.eta <= limit + 0.01,
                        `A road leg is faster than maxSpeedKmh * 0.8 (${limit.toFixed(2)} m/s)`,
                    );
                }
            }
        }

        legInvariants(ground.route, 'ground');
        routes.push({ label: 'ground', route: ground.route });
        log?.(`Ground route: ${ground.route.distance.toFixed(0)} m in ${ground.route.legs.length} legs`);

        // ---- 5. boat route (find water anywhere within 4 km) -----------
        const water = await gpsCall(page, 'queryWater', origin, 4000);
        // The route planner's own water mask is authoritative: queryWater uses a
        // different bbox/cell and can name a tiny pond the route raster misses.
        const waterRoute = await gpsCall(page, 'findWaterRouteWaypoints', origin);
        const waterTarget = waterRoute?.waterPoint ?? water?.nearestWater;

        if (!water?.hasTerrain || !waterTarget) {
            log?.('No water within 4 km; boat geometry not asserted (boat speed maths is unit tested)');
        } else {
            await gpsCall(page, 'setMode', 'boat');
            await gpsCall(page, 'setWaypoints', [waterTarget]);
            const planned = await gpsCall(page, 'calculateRoute');
            const boat = await getGpsDebug(page);

            if (!planned || !boat.route) {
                log?.(`No boat route from this position (${statusOf(boat)}); boat geometry not asserted`);
            } else {
            const walkLegs = boat.route.legs
                .map((leg, index) => ({ leg, index }))
                .filter((entry) => entry.leg.kind === 'walk');
            const lastIndex = boat.route.legs.length - 1;

            for (const { index } of walkLegs) {
                assert(
                    index === 0 || index === lastIndex,
                    `Boat route walk legs must be first or last (walk at index ${index})`,
                );
            }

            for (const leg of boat.route.legs) {
                assert(
                    leg.kind === 'water' || leg.kind === 'walk',
                    `A boat route may only have water/walk legs (got ${leg.kind})`,
                );
            }

            if (walkLegs.length > 0) {
                const walkDistance = walkLegs.reduce((total, entry) => total + entry.leg.distance, 0);
                near(
                    boat.route.walkDistance,
                    walkDistance,
                    0.01,
                    'route.walkDistance should be the sum of the walk legs',
                );
            }

            legInvariants(boat.route, 'boat');
            routes.push({ label: 'boat', route: boat.route });
            log?.(`Boat route: ${boat.route.distance.toFixed(0)} m in ${boat.route.legs.length} legs`);
            }
        }

        // ---- 5a. Web UI can find the road/water/road test waypoints ----
        if (waterRoute) {
            const roadStartWater = await gpsCall(page, 'queryWater', waterRoute.roadStart, 10);
            const waterWater = await gpsCall(page, 'queryWater', waterRoute.waterPoint, 10);
            const roadEndWater = await gpsCall(page, 'queryWater', waterRoute.roadEnd, 10);
            equal(roadStartWater.water, false, 'The first road waypoint must be on land');
            equal(waterWater.water, true, 'The middle waypoint must be in water');
            equal(roadEndWater.water, false, 'The last waypoint must be back on land');
            log?.(`Water-capable waypoints: road ${waterRoute.roadStart.join(',')} -> water ${waterRoute.waterPoint.join(',')} -> road ${waterRoute.roadEnd.join(',')}`);
        } else {
            log?.('No road/water/road waypoint set found; water-capable waypoint check skipped');
        }

        // ---- 5b. amphibious ground vehicle may enter water ------------
        if (water?.hasTerrain && waterTarget) {
            await gpsCall(page, 'applyVehicle', {
                mode: 'ground',
                vehicleClass: 'test_amphibious',
                waterCapable: true,
                performance: {
                    maxSpeedKmh: 80,
                    enginePowerKw: 120,
                    massKg: 2500,
                    canFloat: true,
                    waterSpeedCoef: 0.35,
                },
            });
            await gpsCall(page, 'setMode', 'ground');
            await gpsCall(page, 'setWaypoints', [waterTarget]);
            const amphibiousPlanned = await gpsCall(page, 'calculateRoute');
            const amphibious = await getGpsDebug(page);

            if (!amphibiousPlanned || !amphibious.route) {
                log?.(`No amphibious route to water (${statusOf(amphibious)}); water leg not asserted`);
            } else {
                const waterLegs = amphibious.route.legs.filter((leg) => leg.kind === 'water');
                assert(
                    waterLegs.length > 0,
                    'An amphibious ground vehicle should produce a water leg when the destination is in water',
                );
                legInvariants(amphibious.route, 'ground');
                routes.push({ label: 'amphibious', route: amphibious.route });
                log?.(`Amphibious route: ${amphibious.route.distance.toFixed(0)} m with ${waterLegs.length} water leg(s)`);
            }
        }

        // ---- 6. shared route invariants --------------------------------
        for (const { label, route } of routes) {
            equal(route.source, 'planned', `${label}: the route should be a planned route`);
            for (const leg of route.legs) {
                assert(
                    Number.isFinite(leg.distance) && leg.distance >= 0
                        && Number.isFinite(leg.eta) && leg.eta >= 0,
                    `${label}: a leg has invalid distance/eta`,
                );
            }
        }
        log?.(`Checked leg invariants for ${routes.length} planned routes`);

        // ---- 7. start, follow, pan and stop ----------------------------
        await gpsCall(page, 'clearWaypoints');
        const followTarget = pointAt(origin, { angleDeg: 0, distanceM: 300, bounds });
        await gpsCall(page, 'setMode', 'air');
        await gpsCall(page, 'setWaypoints', [followTarget]);
        equal(await gpsCall(page, 'calculateRoute'), true, 'The navigation route should plan');

        await gpsCall(page, 'startNavigation');
        const started = await waitForGpsDebug(
            page,
            (state) => state.navigating === true && state.planning === false,
            'navigation to start',
        );
        const stopLabel = await gpsT(page, 'str_a3_stop');
        equal(
            await panel.getByRole('button', { name: stopLabel, exact: true }).count(),
            1,
            'The route panel should offer the localized Stop button while navigating',
        );

        // The ETA comes from the route's own expected speed, so it is shown
        // even while the player stands still (the fix below has speed 0).
        const etaPattern = /\d+:\d{2}/;
        await page.waitForFunction(
            (source) => new RegExp(source).test(
                document.querySelector('[data-testid="gps-route-summary"]')?.textContent ?? '',
            ),
            etaPattern.source,
            { timeout: 5000 },
        );
        const stationarySummary = (await page.getByTestId('gps-route-summary').textContent()) ?? '';
        assert(
            etaPattern.test(stationarySummary),
            `The ETA should be an M:SS estimate while stationary, got "${stationarySummary}"`,
        );
        log?.('The stationary summary shows the planned M:SS estimate');
        assert(
            started.route && started.route.remaining > 0,
            'The route summary should show the remaining distance',
        );

        const nearStart = pointAt(origin, { angleDeg: 0, distanceM: 30, bounds });
        await gpsCall(page, 'applyFix', {
            position: nearStart,
            view: [1, 0, 0],
            direction: FIX_HEADING,
            speed: FIX_SPEED * 3.6,
            velocity: FIX_VELOCITY,
        });
        const moving = await waitForGpsDebug(
            page,
            (state) => Math.abs(state.speed - FIX_SPEED) < 0.05,
            'the moving fix',
        );
        assert(
            moving.layers.route.features > 0,
            'The route ahead must stay vivid after the passed part fades',
        );
        near(
            moving.mapRotation,
            moving.rotating ? 270 : 0,
            2,
            'mapRotation should match the heading with the rotation option',
        );
        await waitForMapView(
            page,
            (view) => distance([view.x, view.y], nearStart) < 5,
            'auto-follow to center the moving fix',
        );

        await page.waitForFunction(
            () => /\d+:\d{2}/.test(
                document.querySelector('[data-testid="gps-route-summary"]')?.textContent ?? '',
            ),
            null,
            { timeout: 5000 },
        );
        log?.(`Following at ${FIX_SPEED} m/s; the ETA switched to M:SS`);

        // Pan the map: the next fix must not recenter while follow is suspended.
        const beforePan = await getMapView(page);
        assert(beforePan, 'The Map view disappeared before panning');
        await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.4 + 120, box.y + box.height * 0.5 + 70, { steps: 10 });
        await page.mouse.up();
        const panned = await waitForMapViewStable(page, 'the manual pan to settle', 8000);
        assert(
            distance([panned.x, panned.y], [beforePan.x, beforePan.y]) > 1,
            'The drag did not pan the map',
        );

        const dragAt = Date.now();
        const awayFix = pointAt(origin, { angleDeg: 0, distanceM: 90, bounds });
        await gpsCall(page, 'applyFix', {
            position: awayFix,
            view: [1, 0, 0],
            direction: FIX_HEADING,
            speed: FIX_SPEED * 3.6,
            velocity: FIX_VELOCITY,
        });
        await waitForGpsDebug(
            page,
            (state) => distance(point(state), awayFix) < 0.001,
            'the fix after the pan',
        );
        const afterFixView = await getMapView(page);
        assert(
            distance([afterFixView.x, afterFixView.y], [panned.x, panned.y]) < 2,
            'The map recentered while auto-follow was suspended by the drag',
        );
        assert(
            Date.now() - dragAt < FOLLOW_SUSPENSION_WINDOW_MS,
            'The follow-suspension check took too long (the suspension lasts 5 s)',
        );
        log?.('A manual pan suspends auto-follow for the next fix');

        // Starting navigation again clears the suspension and recenters.
        const resumeFix = pointAt(origin, { angleDeg: 0, distanceM: 120, bounds });
        await gpsCall(page, 'startNavigation');
        await gpsCall(page, 'applyFix', {
            position: resumeFix,
            view: [1, 0, 0],
            direction: FIX_HEADING,
            speed: FIX_SPEED * 3.6,
            velocity: FIX_VELOCITY,
        });
        await waitForMapView(
            page,
            (view) => distance([view.x, view.y], resumeFix) < 5,
            'startNavigation to resume auto-follow',
        );
        log?.('startNavigation resumed auto-follow and recentered the map');

        await page.waitForFunction(
            () => document.querySelectorAll('[data-testid="gps-hud"] svg').length >= 2,
            null,
            { timeout: 5000 },
        );
        const hudArrowsBefore = await page.locator('[data-testid="gps-hud"] svg').count();
        assert(
            hudArrowsBefore >= 2,
            `The HUD should show the player icon and the route arrow while navigating (got ${hudArrowsBefore} svg)`,
        );

        await gpsCall(page, 'stopNavigation');
        const stopped = await waitForGpsDebug(
            page,
            (state) => state.navigating === false,
            'navigation to stop',
        );
        equal(stopped.arrived, false, 'Stopping navigation must not report arrival');
        equal(stopped.advisor, null, 'Stopping navigation must clear the advisor');
        await page.waitForFunction(
            (expected) => document.querySelectorAll('[data-testid="gps-hud"] svg').length === expected,
            hudArrowsBefore - 1,
            { timeout: 5000 },
        );
        log?.('Stopped: the HUD route arrow is gone');

        // ---- 7b. long ground route and turn indicator -------------------
        const longGoal = pointAt(origin, { angleDeg: 90, distanceM: 5000, bounds });
        await gpsCall(page, 'setMode', 'ground');
        await gpsCall(page, 'setWaypoints', [longGoal]);
        const longPlanned = await gpsCall(page, 'calculateRoute');
        if (longPlanned) {
            const longRoute = await getGpsDebug(page);
            assert(longRoute.route, 'The 5 km ground route should exist');
            assert(
                longRoute.route.legs.length >= 1,
                'The 5 km ground route should have at least one leg',
            );
            log?.(`5 km ground route: ${longRoute.route.distance.toFixed(0)} m in ${longRoute.route.legs.length} legs`);
            await gpsCall(page, 'startNavigation');
            await gpsCall(page, 'applyFix', {
                position: [origin[0], origin[1]],
                view: [0, 1, 0],
                direction: 0,
                speed: 4,
                velocity: [0, 4, 0],
            });
            const turnState = await waitForGpsDebug(
                page,
                (state) => state.navigating === true && state.turn !== null,
                'the turn indicator on the 5 km ground route',
            );
            assert(
                turnState.turn === 'left' || turnState.turn === 'right' || turnState.turn === 'straight',
                `The turn indicator returned ${String(turnState.turn)}`,
            );
            log?.(`Turn indicator: ${turnState.turn}`
                + (turnState.turnDistance === null ? '' : ` in ${Math.round(turnState.turnDistance)} m`));
            await gpsCall(page, 'stopNavigation');
        } else {
            log?.('No 5 km ground route from this position; the turn-indicator case was skipped');
        }

        // ---- 7c. synthetic off-route auto-repath -----------------------
        // Air keeps the route a straight line, so the synthetic off-route fix
        // is guaranteed to be outside the threshold regardless of road layout.
        await gpsCall(page, 'setMode', 'air');
        const repathGoal = pointAt(origin, { angleDeg: 0, distanceM: 1200, bounds });
        await gpsCall(page, 'setWaypoints', [repathGoal]);
        const repathPlanned = await gpsCall(page, 'calculateRoute');
        if (repathPlanned) {
            await page.evaluate(() => window.TacPhone.options.set(
                'ACE_TacPhone_Map',
                'gpsAutoRepath',
                true,
            ));
            await gpsCall(page, 'startNavigation');

            const offRoute = pointAt(origin, { angleDeg: 90, distanceM: 600, bounds });
            const offFix = {
                position: offRoute,
                view: [1, 0, 0],
                direction: 90,
                speed: 5 * 3.6,
                velocity: [0, 5, 0],
            };
            await gpsCall(page, 'applyFix', offFix);
            await waitForGpsDebug(page, (state) => state.offRoute === true, 'the off-route state');

            // The tracker needs 4 s of continuous deviation before it repaths.
            await page.waitForTimeout(4500);
            await gpsCall(page, 'applyFix', offFix);
            const repathed = await waitForGpsDebug(
                page,
                (state) => state.repathCount > 0,
                'the synthetic auto-repath',
            );
            assert(repathed.repathCount > 0, 'The off-route delay did not trigger a repath');
            log?.(`Synthetic auto-repath count: ${repathed.repathCount}`);
            await gpsCall(page, 'stopNavigation');
            await page.evaluate(() => window.TacPhone.options.set(
                'ACE_TacPhone_Map',
                'gpsAutoRepath',
                false,
            ));
        } else {
            log?.('No ground route for the synthetic auto-repath case; skipped');
        }

        // ---- 8. route layers after Clear -------------------------------
        await gpsCall(page, 'clearWaypoints');
        const cleared = await waitForGpsDebug(
            page,
            (state) => state.route === null
                && state.layers.route.features === 0
                && state.layers.waypoints.features === 0,
            'Clear to empty the route and waypoint layers',
        );
        equal(cleared.layers.playerIcon.visible, true, 'The player icon should stay visible after Clear');

        // ---- 9. inter-app service starts a route -----------------------
        const serviceStarted = await page.evaluate(
            async ({ x, y }) => {
                const mapApi = window.TacPhone.interApp.list('map')[0]?.api;
                const gpsApi = window.TacPhone.interApp.list('gps')[0]?.api;
                if (mapApi && typeof mapApi.startRouteTo === 'function') {
                    return 'map-has-gps-method';
                }
                if (!gpsApi || typeof gpsApi.startRouteTo !== 'function') {
                    return 'missing';
                }
                if (typeof gpsApi.flyTo !== 'function') {
                    return 'gps-missing-map-methods';
                }
                return await gpsApi.startRouteTo([x, y]);
            },
            { x: waypointA[0], y: waypointA[1] },
        );
        assert(
            serviceStarted === true,
            `map.startRouteTo did not start a route (${String(serviceStarted)})`,
        );
        const serviceState = await waitForGpsDebug(
            page,
            (state) => state.navigating === true && state.route !== null,
            'the inter-app route to start',
        );
        equal(serviceState.route.source, 'planned', 'The inter-app route should be planned');
        log?.(`Inter-app startRouteTo planned ${serviceState.route.distance.toFixed(0)} m`);
        await gpsCall(page, 'stopNavigation');
        await gpsCall(page, 'clearWaypoints');

        if (consoleErrors.length > 0) {
            throw new Error(`The GPS page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        await page.evaluate(() => window.TacPhone.options.set(
            'ACE_TacPhone_Map',
            'gpsAutoRepath',
            false,
        )).catch(() => {});
        await gpsCall(page, 'setLiveUpdates', true).catch(() => {});
        await gpsCall(page, 'clearWaypoints').catch(() => {});
        await gpsCall(page, 'stopNavigation').catch(() => {});
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}
