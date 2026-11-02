/**
 * Opt-in interactive water test: spawns a boat and a water-capable vehicle,
 * teleports the player beside them and follows a planned water route.
 *
 * The script-side helpers are debug-only (`Debug.PrepareBoat`,
 * `Debug.PrepareWaterVehicle`). The Web UI finds the road/water/road waypoints
 * through `gps.findWaterRouteWaypoints`, using the same terrain/road data as the
 * route planner.
 *
 *   $env:TACPHONE_GPS_INTERACTIVE = '1'
 *   npm run test:gps-interactive -- --scenario gps-water-interactive --slow
 *
 * This scenario is never part of `test:map` or `test:all`.
 */

import { assert } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { requestApp } from '../../../ACE_TacPhone_Main/test/lib/host-page.mjs';
import {
    getGpsDebug,
    gpsCall,
    openGpsPage,
    waitForGpsDebug,
} from '../lib/gps-page.mjs';

export const name = 'gps-water-interactive';
export const kind = 'interactive';
export const description = 'spawned boat + water-capable vehicle road/water/road route';

const HUMAN_TIMEOUT_MS = Number(process.env.TACPHONE_GPS_INTERACTIVE_TIMEOUT_MS || 180000);

function announce(message) {
    console.log(`\n>>> ${message}\n`);
}

async function waitForArrival(page, label) {
    return waitForGpsDebug(
        page,
        (state) => state.arrived === true,
        `${label} to arrive (drive to the destination marker)`,
        HUMAN_TIMEOUT_MS,
    );
}

export async function run({ pageUrl, options, log }) {
    const { page, browser } = await openGpsPage({
        pageUrl,
        headed: true,
        slowMo: options?.slow ?? 0,
        log,
    });

    try {
        await gpsCall(page, 'setLiveUpdates', true);
        const initial = await waitForGpsDebug(page, (state) => state.hasFix, 'the first GPS fix');
        const origin = initial.position;
        assert(origin, 'The GPS has no player position');

        // ---- 1. boat ---------------------------------------------------
        announce('Spawning a boat near the shore. Get into it when it appears.');
        const boat = await requestApp(page, 'ACE_TacPhone_Map', 'Debug.PrepareBoat', {
            searchRadius: 4000,
        });
        assert(boat?.ok, `Debug.PrepareBoat failed: ${JSON.stringify(boat)}`);
        log?.(`Boat ${boat.class} spawned at water ${boat.water.join(',')}, shore ${boat.player.join(',')}`);

        announce('Get into the spawned boat. The test waits until the GPS detects boat mode.');
        const boatFix = await waitForGpsDebug(
            page,
            (state) => state.detectedMode === 'boat',
            'the player to enter the boat',
            HUMAN_TIMEOUT_MS,
        );

        const boatTarget = await gpsCall(page, 'findBoatTarget', boatFix.position);
        assert(boatTarget, 'The Web UI could not find a water-only boat destination near the player');
        log?.(`Boat water target: ${boatTarget.join(',')}`);

        await gpsCall(page, 'setMode', 'boat');
        await gpsCall(page, 'setWaypoints', [boatTarget]);
        assert(await gpsCall(page, 'calculateRoute'), 'The boat route did not plan');
        await gpsCall(page, 'startNavigation');
        announce('Drive the boat to the destination marker.');
        const arrivedByBoat = await waitForArrival(page, 'the boat route');
        assert(arrivedByBoat.arrived === true, 'The boat route did not report arrival');

        // Return to the shore and get out before switching to the ground test.
        announce('Drive the boat back to the shore marker and get out of it.');
        await gpsCall(page, 'setWaypoints', [boat.player]);
        const returnPlanned = await gpsCall(page, 'calculateRoute');
        if (returnPlanned) {
            await gpsCall(page, 'startNavigation');
        } else {
            announce('The return route did not plan; drive back to the shore marker manually.');
        }
        const onFoot = await waitForGpsDebug(
            page,
            (state) => state.detectedMode === 'foot',
            'the player to leave the boat',
            HUMAN_TIMEOUT_MS,
        );
        assert(onFoot.detectedMode === 'foot', 'The player did not leave the boat');
        await gpsCall(page, 'stopNavigation');
        await gpsCall(page, 'clearWaypoints');

        // ---- 2. water-capable ground vehicle ---------------------------
        const roadway = await gpsCall(page, 'findWaterRouteWaypoints', onFoot.position);
        assert(roadway, 'The Web UI could not find road/water/road waypoints');

        announce('Spawning a water-capable ground vehicle on the road. Get into it.');
        const vehicle = await requestApp(page, 'ACE_TacPhone_Map', 'Debug.PrepareWaterVehicle', {
            position: roadway.playerStart,
        });
        assert(vehicle?.ok, `Debug.PrepareWaterVehicle failed: ${JSON.stringify(vehicle)}`);
        log?.(`Water vehicle ${vehicle.class} spawned at ${vehicle.position.join(',')}`);

        const teleported = await requestApp(page, 'main', 'GetPlayerPos');
        if (Array.isArray(teleported) && Array.isArray(vehicle.player)) {
            const offset = Math.hypot(
                teleported[0] - vehicle.player[0],
                teleported[1] - vehicle.player[1],
            );
            assert(offset <= 15, `The player is ${offset.toFixed(1)} m from the spawned water vehicle`);
            log?.(`Player teleported ${offset.toFixed(1)} m from the water vehicle`);
        }

        announce('Get into the spawned water-capable vehicle. The test waits for ground mode.');
        const vehicleFix = await waitForGpsDebug(
            page,
            (state) => state.detectedMode === 'ground' && state.waterCapable === true,
            'the player to enter a water-capable vehicle',
            HUMAN_TIMEOUT_MS,
        );
        log?.(`Water-capable ground mode detected at ${vehicleFix.position.join(',')}`);

        await gpsCall(page, 'setMode', 'ground');
        await gpsCall(page, 'setWaypoints', [
            roadway.roadStart,
            roadway.waterPoint,
            roadway.roadEnd,
        ]);
        assert(await gpsCall(page, 'calculateRoute'), 'The water-capable route did not plan');
        const route = await getGpsDebug(page);
        assert(route.route, 'The water-capable route is missing');
        const hasRoad = route.route.legs.some((leg) => leg.kind === 'road');
        const hasWater = route.route.legs.some((leg) => leg.kind === 'water');
        assert(hasRoad, 'The water-capable route has no road leg');
        assert(hasWater, 'The water-capable route has no water leg');
        log?.(`Water route: ${route.route.distance.toFixed(0)} m, ${route.route.legs.length} legs, road=${hasRoad}, water=${hasWater}`);

        await gpsCall(page, 'startNavigation');
        announce('Drive the water-capable vehicle: road, into the water, then back onto the road.');
        const arrivedByVehicle = await waitForArrival(page, 'the water-capable route');
        assert(arrivedByVehicle.arrived === true, 'The water-capable route did not report arrival');
        await gpsCall(page, 'stopNavigation');
        await gpsCall(page, 'clearWaypoints');
    } finally {
        await gpsCall(page, 'stopNavigation').catch(() => {});
        await gpsCall(page, 'clearWaypoints').catch(() => {});
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}
