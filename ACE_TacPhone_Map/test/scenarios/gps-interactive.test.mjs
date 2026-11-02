/**
 * Opt-in interactive GPS test: plan a short route in a vehicle, follow it, leave
 * it on purpose and let `gpsAutoRepath` bring the route back.
 *
 * This is the only scenario that needs a human. It is run through
 * `ACE_TacPhone_Map/test/run-interactive-tests.mjs`, which refuses to start
 * without `TACPHONE_GPS_INTERACTIVE=1/true` or `--opt-in`, and it is never listed
 * in `run-tests.mjs` or `scripts/test-all.mjs`.
 *
 * All progress assertions use a timeout scaled to the route: the planned route
 * gives an expected speed (`route.distance / route.eta`, falling back to the
 * vehicle's `maxSpeed * 0.8`), and the follow loop allows
 * `max(120 s, distance / speed * 4)` — a four times safety margin for traffic,
 * terrain and human reaction time.
 *
 *   $env:TACPHONE_GPS_INTERACTIVE = '1'
 *   npm run test:gps-interactive -- --slow
 */

import { assert, equal } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { requestApp } from '../../../ACE_TacPhone_Main/test/lib/host-page.mjs';
import {
    distance,
    getGpsDebug,
    gpsCall,
    openGpsPage,
    pointAt,
    waitForGpsDebug,
} from '../lib/gps-page.mjs';
import { getMapView } from '../lib/map-page.mjs';

export const name = 'gps-interactive';
export const kind = 'interactive';
export const description = 'In-vehicle follow with progress, deviation and auto-repath (needs a human)';

const MAP_APP = 'ACE_TacPhone_Map';
/** How often the wait-for-vehicle loop asks the game. */
const VEHICLE_POLL_MS = 2000;
/** Default wait for a human to get into a vehicle. */
const DEFAULT_VEHICLE_TIMEOUT_MS = 180000;
/** Follow loop poll interval. */
const PROGRESS_POLL_MS = 500;
/** Progress that counts as "the player is following" (metres). */
const MIN_PROGRESS_M = 100;
/** Progress before the deliberate deviation is requested (metres). */
const DEVIATION_PROGRESS_M = 40;
/** Auto-follow must centre the map within this distance at least once (metres). */
const FOLLOW_TOLERANCE_M = 150;
/** Lower bound of the dynamic follow timeout. */
const MIN_FOLLOW_TIMEOUT_MS = 120000;
/** Safety factor on the route's own expected travel time. */
const FOLLOW_SAFETY_FACTOR = 4;
/** Reminder interval when the player does not move (ms). */
const IDLE_REMINDER_MS = 20000;
/** How long the player may stay off-route during the first phase (ms). */
const MAX_OFF_ROUTE_MS = 10000;
/** Maximum goal distance (metres); the interactive scenario uses 5 km. */
const MAX_GOAL_M = 5000;
const GOAL_DISTANCE_M = 5000;
const MID_DISTANCE_M = 2500;
/** Off-route detection threshold of `GpsModule` (metres). */
const OFF_ROUTE_THRESHOLD_M = 100;
/** Auto-repath needs this much deviation plus its off-route delay (metres). */
const DEVIATION_DISTANCE_M = OFF_ROUTE_THRESHOLD_M + 60;

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function say(message) {
    console.log(`\n${message}`);
}

function point(state) {
    return [state.position[0], state.position[1]];
}

/** Expected ground speed from the planned route, or the vehicle fallback (m/s). */
function expectedSpeed(route, performance) {
    if (route?.eta !== null && route?.eta > 0 && route.distance > 0) {
        return route.distance / route.eta;
    }

    const maxSpeed = Number(performance?.maxSpeedKmh);
    if (Number.isFinite(maxSpeed) && maxSpeed > 0) {
        return (maxSpeed / 3.6) * 0.8;
    }

    return 5;
}

/** `max(120 s, distance / speed * 4)` in milliseconds. */
function followTimeoutFor(route, performance) {
    const speed = expectedSpeed(route, performance);
    const travel = (route?.distance ?? 0) / speed;
    return Math.max(MIN_FOLLOW_TIMEOUT_MS, travel * FOLLOW_SAFETY_FACTOR * 1000);
}

/** Waits until the human sits in a vehicle; returns the travel-mode reply. */
async function waitForVehicle(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let today = null;

    while (Date.now() < deadline) {
        today = await requestApp(page, MAP_APP, 'GetPlayerTravelMode').catch(() => null);

        if (today?.mode && today.mode !== 'foot') {
            return today;
        }

        say(`Get into a car/boat/aircraft now; waiting for a vehicle... (detected: ${today?.mode ?? 'unknown'})`);
        await sleep(VEHICLE_POLL_MS);
    }

    return today;
}

/** Builds the goal and the mid waypoint, both within `MAX_GOAL_M`. */
async function planTargets(page, state, bounds, mode, waterCapable) {
    const start = point(state);
    const heading = Number.isFinite(state.heading) ? state.heading : 0;
    const candidates = [heading + 20, heading + 200, heading + 110, heading + 290, heading + 340, heading + 70];

    for (const angleDeg of candidates) {
        const goal = pointAt(start, { angleDeg: angleDeg % 360, distanceM: GOAL_DISTANCE_M, bounds, margin: 80 });
        const goalDistance = distance(start, goal);

        if (goalDistance < 150 || goalDistance > MAX_GOAL_M) {
            continue;
        }

        if (mode === 'ground' && !waterCapable) {
            const goalWater = await gpsCall(page, 'queryWater', goal, 100).catch(() => null);
            if (!goalWater?.hasTerrain || goalWater.water) {
                continue;
            }
        }

        const mid = pointAt(start, {
            angleDeg: (angleDeg + 10) % 360,
            distanceM: Math.min(MID_DISTANCE_M, goalDistance * 0.6),
            bounds,
            margin: 80,
        });

        if (mode === 'ground' && !waterCapable) {
            const midWater = await gpsCall(page, 'queryWater', mid, 100).catch(() => null);
            if (!midWater?.hasTerrain || midWater.water) {
                continue;
            }
        }

        return { goal, mid, goalDistance, angleDeg };
    }

    throw new Error(
        mode === 'ground' && !waterCapable
            ? 'No dry <= 5 km goal was found for the non-amphibious vehicle; move away from the coast and rerun.'
            : 'The terrain around the player is too small for a <= 5 km goal; move away from the map edge and rerun.',
    );
}

export async function run({ pageUrl, options, log }) {
    const startedAt = Date.now();
    const vehicleTimeoutMs = Number(process.env.TACPHONE_GPS_INTERACTIVE_TIMEOUT_MS)
        || DEFAULT_VEHICLE_TIMEOUT_MS;

    const { browser, page, consoleErrors } = await openGpsPage({
        pageUrl,
        headed: true,
        slowMo: options?.slow ?? 0,
        log,
    });

    let previousRepathOption = null;
    let repathOptionSet = false;

    try {
        // ---- 1. wait for a vehicle --------------------------------------
        say('TacPhone interactive GPS test: keep Arma in the foreground, the phone is open in the browser.');
        const travelMode = await waitForVehicle(page, vehicleTimeoutMs);

        assert(
            travelMode?.mode && travelMode.mode !== 'foot',
            'No vehicle detected; the interactive GPS test needs the player seated in a vehicle.',
        );

        if (!travelMode.waterCapable && travelMode.mode === 'ground') {
            log?.(`Detected ${travelMode.mode} (${travelMode.vehicleClass}), not amphibious`);
        } else {
            log?.(`Detected ${travelMode.mode} (${travelMode.vehicleClass})`);
        }

        // ---- 2. live fix, targets and route ------------------------------
        await waitForGpsDebug(page, (state) => state.hasFix && state.position !== null, 'the first live GPS fix', 30000);

        const bounds = await gpsCall(page, 'getTerrainBounds');
        assert(bounds && bounds.width > 200 && bounds.height > 200, 'The GPS has no usable terrain bounds');

        // Re-read right before planning: the player may still be moving.
        const state = await getGpsDebug(page);
        const { goal, mid, goalDistance, angleDeg } = await planTargets(
            page,
            state,
            bounds,
            travelMode.mode,
            travelMode.waterCapable,
        );
        assert(distance(point(state), goal) <= MAX_GOAL_M, 'The planned goal must stay within 5 km');
        log?.(`Goal ${goalDistance.toFixed(0)} m away at ${angleDeg.toFixed(0)}°`);

        // Auto-repath is part of this scenario; restore the previous value later.
        previousRepathOption = await page.evaluate(
            (app) => window.TacPhone.options.get(app, 'gpsAutoRepath'),
            MAP_APP,
        );
        await page.evaluate(
            (app) => window.TacPhone.options.set(app, 'gpsAutoRepath', true),
            MAP_APP,
        );
        repathOptionSet = true;

        await gpsCall(page, 'setMode', travelMode.mode);
        await gpsCall(page, 'setWaypoints', [mid, goal]);
        const planned = await gpsCall(page, 'calculateRoute');
        const plannedState = await getGpsDebug(page);

        if (planned !== true || !plannedState.route) {
            const reason = plannedState.status?.kind ?? 'unknown';
            if (travelMode.mode === 'boat') {
                throw new Error(
                    `No water route from here (${reason}); drive closer to water and rerun.`,
                );
            }
            throw new Error(`The route could not be planned (${reason}).`);
        }

        assert(
            plannedState.route.distance >= goalDistance * 0.9,
            `The route (${plannedState.route.distance.toFixed(0)} m) is shorter than the straight line (${goalDistance.toFixed(0)} m)`,
        );
        assert(plannedState.route.eta !== null && plannedState.route.eta > 0, 'The route needs a positive ETA');
        equal(plannedState.route.source, 'planned', 'The interactive route should be a planned route');

        const timeout = followTimeoutFor(plannedState.route, travelMode.performance);
        log?.(
            `Route ${plannedState.route.distance.toFixed(0)} m, ETA ${Math.round(plannedState.route.eta)} s at `
            + `${expectedSpeed(plannedState.route, travelMode.performance).toFixed(1)} m/s `
            + `(${Math.round(timeout / 1000)} s follow window)`,
        );

        // ---- 3. start ---------------------------------------------------
        const markerCountBefore = await requestApp(page, MAP_APP, 'GetAllMarkers')
            .then((reply) => (Array.isArray(reply?.markers) ? reply.markers.length : null))
            .catch(() => null);

        await gpsCall(page, 'startNavigation');
        const started = await waitForGpsDebug(page, (s) => s.navigating === true, 'navigation to start');
        assert(started.route && started.route.remaining > 0, 'The started route has no remaining distance');

        say(`Route started: ${plannedState.route.distance.toFixed(0)} m. Follow the line on the map.`);

        const progress = {
            initialRemaining: started.route.remaining,
            bestProgress: 0,
            centered: false,
            offRouteSince: 0,
            offRouteViolation: false,
            lastMoveAt: Date.now(),
            lastRemaining: started.route.remaining,
        };

        /** Polls the GPS state for one phase; returns the last state. */
        const follow = async (phaseMs, onState) => {
            const deadline = Date.now() + phaseMs;
            let latest = await getGpsDebug(page);

            while (Date.now() < deadline) {
                await sleep(PROGRESS_POLL_MS);
                latest = await getGpsDebug(page);

                if (!latest?.route) {
                    break;
                }

                const progressNow = Math.max(0, progress.initialRemaining - latest.route.remaining);
                progress.bestProgress = Math.max(progress.bestProgress, progressNow);

                if (latest.route.remaining < progress.lastRemaining - 1) {
                    progress.lastRemaining = latest.route.remaining;
                    progress.lastMoveAt = Date.now();
                }

                if (!progress.centered) {
                    const view = await getMapView(page).catch(() => null);
                    if (view && latest.position
                        && distance([view.x, view.y], point(latest)) <= FOLLOW_TOLERANCE_M) {
                        progress.centered = true;
                        log?.('Auto-follow centred the map on the player');
                    }
                }

                if (latest.offRoute) {
                    progress.offRouteSince ||= Date.now();
                    if (!progress.offRouteViolation
                        && Date.now() - progress.offRouteSince > MAX_OFF_ROUTE_MS) {
                        progress.offRouteViolation = true;
                    }
                } else {
                    progress.offRouteSince = 0;
                }

                if (Date.now() - progress.lastMoveAt > IDLE_REMINDER_MS) {
                    say('The player has not moved for a while. Drive along the route line to continue.');
                    progress.lastMoveAt = Date.now();
                }

                if (onState && (await onState(latest))) {
                    break;
                }

                if (latest.arrived) {
                    break;
                }
            }

            return latest;
        };

        // ---- 4. follow to the deviation point ---------------------------
        const deviating = await follow(timeout, (latest) => latest.arrived === true
            || progress.bestProgress >= DEVIATION_PROGRESS_M);

        if (!deviating.arrived) {
            assert(
                !progress.offRouteViolation,
                `The player stayed off-route for more than ${MAX_OFF_ROUTE_MS / 1000} s without a replan`,
            );
        }

        // ---- 5. deliberate deviation + auto-repath ----------------------
        const repathBefore = deviating.repathCount;

        if (!deviating.arrived) {
            say(
                `Now deliberately LEAVE the route: turn away and drive at least `
                + `${DEVIATION_DISTANCE_M} m away from the line, then keep driving. `
                + 'The GPS should replan automatically.',
            );

            const offRoute = await follow(timeout, (latest) => latest.offRoute === true);
            assert(
                offRoute.offRoute === true,
                `Leaving the route did not raise offRoute within ${Math.round(timeout / 1000)} s`,
            );
            log?.('The GPS reported offRoute; waiting for the automatic replan');

            const repathed = await follow(timeout, (latest) => latest.repathCount > repathBefore);
            assert(
                repathed.repathCount > repathBefore,
                `gpsAutoRepath did not replace the route within ${Math.round(timeout / 1000)} s `
                + `(offRoute=${repathed.offRoute}, repathCount=${repathed.repathCount})`,
            );
            equal(repathed.navigating, true, 'Auto-repath must not stop navigation');
            assert(repathed.route && repathed.route.distance > 0, 'The replanned route is empty');
            log?.(`Auto-repath #${repathed.repathCount} replaced the route (${repathed.route.distance.toFixed(0)} m)`);

            const backOnRoute = await follow(Math.min(timeout, 60000), (latest) => latest.offRoute === false);
            assert(
                backOnRoute.offRoute === false,
                'The player never got back on the replanned route',
            );
            log?.('Off-route cleared after the automatic replan');

            say('Follow the replanned line to the destination.');
        }

        // ---- 6. follow to the goal --------------------------------------
        const final = await follow(timeout, (latest) => latest.arrived === true);
        const routeAtEnd = final.route ?? (await getGpsDebug(page)).route;

        assert(routeAtEnd, 'The route disappeared before the goal');
        equal(routeAtEnd.source, 'planned', 'The interactive route should stay a planned route');
        assert(routeAtEnd.legs.length > 0, 'The final route has no legs');
        assert(
            final.arrived === true || progress.bestProgress >= MIN_PROGRESS_M,
            `The player made ${progress.bestProgress.toFixed(0)} m of progress; `
            + `${MIN_PROGRESS_M} m (or arriving) is required`,
        );
        assert(
            final.layers.route.features > 0,
            'The route line should still be drawn while navigating',
        );
        equal(final.layers.playerIcon.visible, true, 'The player icon should stay visible');

        if (markerCountBefore !== null) {
            const markerCountAfter = await requestApp(page, MAP_APP, 'GetAllMarkers')
                .then((reply) => (Array.isArray(reply?.markers) ? reply.markers.length : null))
                .catch(() => null);
            equal(markerCountAfter, markerCountBefore, 'The GPS must not create or delete map markers');
        }

        say(
            `Interactive GPS test finished: ${progress.bestProgress.toFixed(0)} m of `
            + `${plannedState.route.distance.toFixed(0)} m, `
            + `${final.repathCount} auto-repath(s), `
            + `${Math.round((Date.now() - startedAt) / 1000)} s, `
            + `${travelMode.mode} (${travelMode.vehicleClass || 'on foot'})`,
        );

        if (consoleErrors.length > 0) {
            throw new Error(`The GPS page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        if (repathOptionSet) {
            await page.evaluate(
                ({ app, value }) => window.TacPhone.options.set(app, 'gpsAutoRepath', value ?? false),
                { app: MAP_APP, value: previousRepathOption ?? false },
            ).catch(() => {});
        }

        await gpsCall(page, 'stopNavigation').catch(() => {});
        await gpsCall(page, 'clearWaypoints').catch(() => {});
        await gpsCall(page, 'discardSharedRoute').catch(() => {});
        await gpsCall(page, 'setLiveUpdates', true).catch(() => {});

        await waitForGpsDebug(
            page,
            (state) => state.route === null
                && state.layers.route.features === 0
                && state.layers.waypoints.features === 0
                && state.layers.shared.features === 0,
            'the GPS layers to clear after the interactive run',
            5000,
        ).catch(() => {});

        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}
