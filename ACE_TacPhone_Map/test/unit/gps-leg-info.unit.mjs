/**
 * Unit tests for the route-leg hover helper (`routing/RouteLegInfo.ts`).
 *
 * The overlay must show the hovered leg's own average speed/time and the legs
 * from the previous waypoint or the player (whichever is closer) to the next
 * waypoint. These cases pin the along-route maths without a browser.
 */

import { equal, ok } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { buildRouteGeometry } from '../../src/MapGps/RouteSplice.ts';
import { describeRouteLegHover } from '../../src/routing/RouteLegInfo.ts';

export const name = 'gps-leg-info';
export const description = 'route-leg hover speed/time and span to the next waypoint';

const LEGS = [
    {
        mode: 'foot',
        kind: 'walk',
        surface: 'forest',
        points: [0, 0, 100, 0],
        distance: 100,
        eta: 25,
    },
    {
        mode: 'foot',
        kind: 'water',
        points: [100, 0, 300, 0],
        distance: 200,
        eta: 100,
    },
];
const WAYPOINTS = [[100, 0], [300, 0]];

export function run() {
    const geometry = buildRouteGeometry(LEGS);
    equal(geometry.legStarts.length, 2, 'geometry records both leg starts');

    // 1. The hovered water leg reports its own distance, average speed and time.
    const playerInside = describeRouteLegHover(LEGS, geometry, 1, [250, 0], WAYPOINTS);
    ok(playerInside, 'the water leg is described');
    equal(playerInside.kind, 'water', 'the leg kind is preserved');
    equal(Math.round(playerInside.distance), 200, 'the hovered leg distance is its own');
    equal(Math.round(playerInside.eta), 100, 'the hovered leg ETA is its own');
    equal(Math.round(playerInside.speed * 10) / 10, 2, 'the hovered leg average speed is distance / ETA');
    equal(playerInside.nextWaypointIndex, 1, 'the next waypoint is the second one');
    equal(playerInside.fromPlayer, true, 'a player inside the leg is the span start');
    equal(Math.round(playerInside.spanDistance), 50, 'the span starts at the player');
    equal(Math.round(playerInside.spanEta), 25, 'the remaining part of the water leg is 25 s');
    equal(Math.round(playerInside.spanSpeed * 10) / 10, 2, 'the span average speed matches the leg');

    // 2. A player behind the leg uses the previous waypoint instead.
    const previousStart = describeRouteLegHover(LEGS, geometry, 1, [50, 0], WAYPOINTS);
    ok(previousStart, 'the water leg is described from the previous waypoint');
    equal(previousStart.fromPlayer, false, 'a player before the leg loses to the previous waypoint');
    equal(Math.round(previousStart.spanDistance), 200, 'the span covers the whole water leg');
    equal(Math.round(previousStart.spanEta), 100, 'the span ETA is the whole water leg');

    // 3. Hovering the first leg: the span to the first waypoint is the leg itself.
    const firstLeg = describeRouteLegHover(LEGS, geometry, 0, null, WAYPOINTS);
    ok(firstLeg, 'the first leg is described without a player');
    equal(firstLeg.surface, 'forest', 'the hovered leg keeps its ground surface');
    equal(firstLeg.fromPlayer, false, 'without a player the route start is used');
    equal(Math.round(firstLeg.spanDistance), 100, 'the first span ends at the first waypoint');
    equal(Math.round(firstLeg.spanEta), 25, 'the first span ETA is the first leg ETA');
    equal(Math.round(firstLeg.spanSpeed * 10) / 10, 4, 'the first span average speed is 4 m/s');

    // 4. A player inside the first leg starts the span mid-leg.
    const midFirst = describeRouteLegHover(LEGS, geometry, 0, [50, 0], WAYPOINTS);
    ok(midFirst, 'the first leg is described from the player');
    equal(midFirst.fromPlayer, true, 'a player inside the first leg is the start');
    equal(Math.round(midFirst.spanDistance), 50, 'the span starts at the player');
    equal(Math.round(midFirst.spanEta), 13, 'half of the first leg remains');
}
