#!/usr/bin/env node
/**
 * Replans a route stored in a Messenger room and prints the resulting legs.
 *
 * Problem cases arrive as shared `map.gps_route` objects in Messenger. This
 * tool fetches the room's routes through the real `messenger` inter-app
 * service, feeds their origin/waypoints back into the live GPS panel and prints
 * distance, ETA and per-leg kind/coordinates. It is the fastest way to check a
 * routing fix without replaying the share flow by hand.
 *
 * Usage (from `websource`; needs Arma + the web host + the dev page):
 *
 *   node ACE_TacPhone_Map/test/tools/replan-room.mjs
 *   node ACE_TacPhone_Map/test/tools/replan-room.mjs --room testRoom --points
 *   node ACE_TacPhone_Map/test/tools/replan-room.mjs --mode foot --json
 *   node ACE_TacPhone_Map/test/tools/replan-room.mjs --room WaterLeg --headed
 *
 * An ad-hoc route can be supplied without Messenger. Waypoints are offsets
 * from the origin, matching the shared-route payload:
 *
 *   node ACE_TacPhone_Map/test/tools/replan-room.mjs --origin 11200,8710 \
 *     --waypoint 277,2588 --waypoint 3780,7275
 *
 * It is a diagnostic tool, not a scenario: it is not part of `test:map` or
 * `test:all` and it changes only the GPS panel's waypoints/route.
 */

import { getGpsDebug, gpsCall, openGpsPage, waitForTerrainBounds } from '../lib/gps-page.mjs';
import { WsClient } from '../../../ACE_TacPhone_Main/test/lib/ws-client.mjs';

function usage() {
    return [
        'Replan shared GPS routes from a Messenger room, or plan from the live player.',
        '',
        'Options:',
        '  --room <name>       Messenger room to read (default: testRoom)',
        '  --page-url <url>    Host page URL (default: http://localhost:5173/)',
        '  --ws-url <url>      Game WebSocket URL (default wss://localhost:8001/ws)',
        '  --mode <mode>       foot | ground | boat | air (default: foot)',
        '  --from-player       Use the real player position, travel mode and vehicle performance',
        '  --goal <x,y>        Absolute destination (with --from-player)',
        '  --origin <x,y>      Ad-hoc origin; skips Messenger',
        '  --waypoint <dx,dy>  Ad-hoc waypoint offset from the origin; repeatable',
        '  --timeout <ms>      Wait for the room/messages (default: 8000)',
        '  --points            Print every route point, not only the endpoints',
        '  --json              Print one JSON object instead of text',
        '  --headed            Show the browser window',
        '  --verbose           Log host/GPS helper progress',
        '  --help              Show this text',
    ].join('\n');
}

function numberPair(value) {
    const parts = String(value).split(',').map((part) => Number.parseFloat(part.trim()));
    if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) {
        throw new Error(`Expected "x,y", got "${value}"`);
    }
    return parts;
}

function parseArgs(argv) {
    const options = {
        room: 'testRoom',
        pageUrl: 'http://localhost:5173/',
        wsUrl: 'wss://localhost:8001/ws',
        mode: 'foot',
        fromPlayer: false,
        goal: null,
        origin: null,
        waypoints: [],
        timeout: 8000,
        points: false,
        json: false,
        headed: false,
        verbose: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) {
                throw new Error(`Missing value after ${arg}`);
            }
            return argv[index];
        };

        switch (arg) {
            case '--room': options.room = next(); break;
            case '--page-url': options.pageUrl = next(); break;
            case '--ws-url': options.wsUrl = next(); break;
            case '--mode': options.mode = next(); break;
            case '--from-player': options.fromPlayer = true; break;
            case '--goal': options.goal = numberPair(next()); break;
            case '--origin': options.origin = numberPair(next()); break;
            case '--waypoint': options.waypoints.push(numberPair(next())); break;
            case '--timeout': options.timeout = Number.parseInt(next(), 10); break;
            case '--points': options.points = true; break;
            case '--json': options.json = true; break;
            case '--headed': options.headed = true; break;
            case '--verbose': options.verbose = true; break;
            case '--help':
            case '-h': options.help = true; break;
            default:
                throw new Error(`Unknown option ${arg}\n\n${usage()}`);
        }
    }

    if (!['foot', 'ground', 'boat', 'air'].includes(options.mode)) {
        throw new Error(`Unknown mode "${options.mode}"`);
    }
    if (options.fromPlayer && !options.goal) {
        throw new Error('--from-player also needs --goal <x,y>');
    }
    if (options.goal && !options.fromPlayer && !options.origin) {
        throw new Error('--goal without --from-player also needs --origin <x,y>');
    }
    if (options.origin && options.waypoints.length === 0) {
        throw new Error('--origin also needs at least one --waypoint');
    }
    return options;
}

/** `M:SS`, or `Hh MMm` above an hour. */
function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return '--';
    }
    const total = Math.max(1, Math.round(seconds));
    if (total >= 3600) {
        return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
    }
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function pointPairs(points) {
    const pairs = [];
    for (let index = 0; index + 1 < points.length; index += 2) {
        pairs.push([points[index], points[index + 1]]);
    }
    return pairs;
}

function formatPoint(point) {
    return `[${point[0].toFixed(1)}, ${point[1].toFixed(1)}]`;
}

function formatLeg(leg, includePoints) {
    const pairs = leg.points;
    const first = pairs[0];
    const last = pairs[pairs.length - 1];
    const type = leg.roadKind === 'track'
        ? 'track'
        : leg.roadKind === 'trail'
            ? 'trail'
            : leg.roadKind === 'rail'
                ? 'rail'
                : leg.surface === 'forest'
                    ? 'forest'
                    : leg.kind;
    const base = `${type.padEnd(7)} ${String(Math.round(leg.distance)).padStart(6)} m  `
        + `${formatDuration(leg.eta).padStart(7)}  ${formatPoint(first)} -> ${formatPoint(last)}`;
    if (!includePoints) {
        return base;
    }
    return `${base}\n${JSON.stringify(pairs)}`;
}

/** Reads a room's route objects through the Messenger inter-app service. */
async function readRoomRoutes(page, roomName, timeout) {
    return page.evaluate(async ({ name, waitMs }) => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const info = await window.TacPhone.interApp.resolveAsync({
            service: 'messenger',
            panelId: 'Messaging',
            openIfMissing: true,
        });
        if (!info) {
            return { error: 'The messenger service is unavailable; install/open the Messenger app.' };
        }

        const deadline = Date.now() + waitMs;
        let room = info.api.getRooms().find((entry) => entry.name === name);
        while (!room && Date.now() < deadline) {
            await wait(200);
            room = info.api.getRooms().find((entry) => entry.name === name);
        }
        if (!room) {
            return {
                error: `Room "${name}" was not found.`,
                rooms: info.api.getRooms().map((entry) => entry.name),
            };
        }

        let routes = [];
        while (Date.now() < deadline) {
            routes = info.api.getMessages(room.id)
                .flatMap((message) => message.objects ?? [])
                .filter((object) => object.kind === 'map.gps_route')
                .map((object) => object.data);
            if (routes.length > 0) {
                break;
            }
            await wait(200);
        }

        return { room: room.name, routes };
    }, { name: roomName, waitMs: timeout });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }

    const { page, browser } = await openGpsPage({
        pageUrl: options.pageUrl,
        headed: options.headed,
        log: options.verbose ? console.log : undefined,
    });

    try {
        // Route results without the slope grid are not representative: the
        // planner cannot price terrain until the Map has passed the snapshot.
        await waitForTerrainBounds(page, 30000);
        await gpsCall(page, 'setLiveUpdates', false);

        let effectiveMode = options.mode;
        let playerInfo = null;
        let routes;
        if (options.fromPlayer) {
            const client = new WsClient(options.wsUrl, {
                connectTimeout: options.timeout,
                requestTimeout: options.timeout,
            });
            try {
                const position = await client.request('GetPlayerPos', {}, { app: 'main' });
                const travel = await client.request('GetPlayerTravelMode', {}, { app: 'ACE_TacPhone_Map' });
                if (!Array.isArray(position) || position.length < 2) {
                    throw new Error('GetPlayerPos did not return a position array');
                }
                if (!travel || typeof travel !== 'object') {
                    throw new Error('GetPlayerTravelMode returned no vehicle information');
                }
                playerInfo = { position, travel };
                effectiveMode = travel.mode;
                await gpsCall(page, 'applyVehicle', travel);
                const goal = options.goal;
                routes = [{
                    origin: [position[0], position[1]],
                    waypoints: [goal[0] - position[0], goal[1] - position[1]],
                    label: `player -> ${goal[0]},${goal[1]}`,
                    author: 'replan-room',
                }];
                if (!options.json) {
                    console.log(`Player: ${position[0].toFixed(1)}, ${position[1].toFixed(1)}`);
                    console.log(`Vehicle: ${travel.vehicleClass || '(on foot)'} · mode ${travel.mode}`
                        + ` · waterCapable ${travel.waterCapable}`
                        + ` · performance ${JSON.stringify(travel.performance)}`);
                }
            } finally {
                await client.close();
            }
        } else if (options.origin) {
            const goals = options.goal
                ? [options.goal]
                : options.waypoints.map(([dx, dy]) => [options.origin[0] + dx, options.origin[1] + dy]);
            routes = [{
                origin: options.origin,
                waypoints: goals.flatMap(([x, y]) => [x - options.origin[0], y - options.origin[1]]),
                label: 'ad-hoc route',
                author: 'replan-room',
            }];
        } else {
            const room = await readRoomRoutes(page, options.room, options.timeout);
            if (room.error) {
                console.error(room.error);
                if (room.rooms) {
                    console.error(`Rooms: ${room.rooms.join(', ') || '(none)'}`);
                }
                process.exitCode = 1;
                return;
            }
            routes = room.routes;
            if (routes.length === 0) {
                console.error(`Room "${room.room}" has no map.gps_route objects.`);
                process.exitCode = 1;
                return;
            }
            if (!options.json) {
                console.log(`Room "${room.room}": ${routes.length} route(s)`);
            }
        }

        await gpsCall(page, 'setMode', effectiveMode);

        const results = [];
        for (const [routeIndex, route] of routes.entries()) {
            const origin = route.origin;
            const offsets = route.waypoints;
            const goals = [];
            for (let index = 0; index + 1 < offsets.length; index += 2) {
                goals.push([origin[0] + offsets[index], origin[1] + offsets[index + 1]]);
            }

            await gpsCall(page, 'applyFix', {
                position: origin,
                view: [0, 1, 0],
                direction: 0,
                speed: 0,
                velocity: [0, 0, 0],
            });
            await gpsCall(page, 'setMode', effectiveMode);
            await gpsCall(page, 'setWaypoints', goals);
            const calculated = await gpsCall(page, 'calculateRoute');
            const state = await getGpsDebug(page);
            const snapshot = await gpsCall(page, 'getRouteDebugSnapshot');
            const planned = snapshot?.route;
            if (!calculated || !planned) {
                console.error(`Route ${routeIndex + 1}: planning failed (${state?.status ?? 'no route'})`);
                process.exitCode = 1;
                continue;
            }

            const result = {
                source: options.fromPlayer
                    ? 'player'
                    : options.origin
                        ? 'ad-hoc'
                        : options.room,
                player: playerInfo,
                label: route.label ?? null,
                mode: options.mode,
                origin,
                goals,
                distance: planned.distance,
                eta: planned.eta,
                legs: planned.legs.map((leg) => ({
                    kind: leg.kind,
                    surface: leg.surface,
                    roadKind: leg.roadKind,
                    distance: leg.distance,
                    eta: leg.eta,
                    points: pointPairs(leg.points),
                })),
            };
            results.push(result);

            if (options.json) {
                continue;
            }

            console.log('');
            console.log(`Route ${routeIndex + 1}: ${route.label ?? '(unlabeled)'}`
                + ` — ${Math.round(planned.distance)} m, ${formatDuration(planned.eta)}`);
            if (route.author !== undefined) {
                console.log(`Author: ${route.author}`);
            }
            for (const leg of result.legs) {
                console.log(`  ${formatLeg(leg, options.points)}`);
            }
            const water = result.legs.filter((leg) => leg.kind === 'water');
            console.log(`  Water legs: ${water.length}`
                + (water.length > 0 ? ` (${Math.round(water.reduce((sum, leg) => sum + leg.distance, 0))} m)` : ''));
        }

        if (options.json) {
            console.log(JSON.stringify(results, null, 2));
        }
        if (results.length === 0) {
            process.exitCode = 1;
        }
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
