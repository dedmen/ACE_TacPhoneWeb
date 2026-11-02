/**
 * Unit tests for the transport-mode advisor state machine
 * (`TransportModeAdvisor.ts`).
 *
 * The advisor decides when to offer "your mode is faster than this shared
 * route's". Its whole point is timing, so the clock is injected: every case
 * passes `now` explicitly and the suite is instantaneous and deterministic
 * (no timers, no real waiting).
 */

import { deepEqual, equal, ok } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    TransportModeAdvisor,
} from '../../src/MapGps/TransportModeAdvisor.ts';
import { buildRouteGeometry, sliceLegsFrom } from '../../src/MapGps/RouteSplice.ts';
import { projectPointToPolyline } from '../../src/MapGps/SharedRoute.ts';

export const name = 'gps-advisor';
export const description = 'Transport-mode advisor state machine (injected clock)';

/** Baseline input: a shared foot route, player in a boat, moving on-route. */
const BASE_INPUT = {
    now: 0,
    source: 'shared',
    navigating: true,
    moving: true,
    onRoute: true,
    planningInFlight: false,
    mode: 'boat',
    authoredMode: 'foot',
    legSource: 'shared',
    along: 0,
    waypointAlong: [500, 1000],
    authoredSpeed: 1.4,
};

function input(overrides = {}) {
    return { ...BASE_INPUT, ...overrides };
}

function prompt(authoredMode, mode, waypointIndex = 0) {
    return {
        authoredMode,
        mode,
        alternativeSeconds: 120,
        savesSeconds: 240,
        waypointIndex,
    };
}

const META = { segment: 1, authoredRemaining: 360 };

export async function run() {
    // 1. Planned routes are never advised.
    {
        const advisor = new TransportModeAdvisor();
        equal(
            advisor.evaluate(input({ source: 'planned' })).kind,
            'idle',
            'a planned route never triggers the advisor',
        );
    }

    // 2. Follow delay by time (minFollowMs = 10000).
    {
        const advisor = new TransportModeAdvisor();
        equal(advisor.evaluate(input({ now: 0, along: 0 })).kind, 'wait', 't=0 waits');
        equal(advisor.evaluate(input({ now: 9999, along: 0 })).kind, 'wait', 't=9 999 m=0 waits');
        const decision = advisor.evaluate(input({ now: 10000, along: 0 }));
        equal(decision.kind, 'evaluate', 't=10 000 evaluates');
        equal(decision.nextWaypointIndex, 0, 'the first waypoint ahead is the target');
        // remaining = (500 - 0) / 1.4, threshold = max(60, 20% of it)
        equal(decision.authoredRemaining, 500 / 1.4, 'the authored remaining time is used');
        equal(decision.threshold, Math.max(60, (500 / 1.4) * 0.2), 'the threshold follows the ratio rule');
    }

    // 3. Follow delay by distance (minFollowM = 100).
    {
        const advisor = new TransportModeAdvisor();
        equal(advisor.evaluate(input({ now: 0, along: 0 })).kind, 'wait', 'the first sample waits');
        equal(advisor.evaluate(input({ now: 1, along: 99 })).kind, 'wait', '99 m in 1 ms still waits');
        equal(
            advisor.evaluate(input({ now: 1, along: 100 })).kind,
            'evaluate',
            '100 m in 1 ms evaluates',
        );
    }

    // 4. Dismissal suppresses the authored mode only.
    {
        const advisor = new TransportModeAdvisor();
        equal(advisor.evaluate(input({ now: 0, along: 0 })).kind, 'wait', 'the first sample waits');
        equal(advisor.evaluate(input({ now: 10000, along: 100 })).kind, 'evaluate', 'the offer is requested');
        advisor.showPrompt(prompt('foot', 'boat'), META);
        ok(advisor.prompt, 'the prompt is shown');

        const dismissed = advisor.dismiss();
        ok(dismissed, 'dismiss returns the answered prompt');
        equal(advisor.prompt, null, 'dismissing clears the prompt');
        equal(advisor.isSuppressed('foot'), true, 'the authored mode is suppressed');
        equal(
            advisor.evaluate(input({ now: 10000 })).kind,
            'suppressed',
            'the suppressed authored mode never asks again',
        );

        equal(
            advisor.evaluate(input({ now: 40000, authoredMode: 'ground' })).kind,
            'wait',
            'a new authored mode restarts the follow delay',
        );
        equal(
            advisor.evaluate(input({ now: 50000, authoredMode: 'ground' })).kind,
            'evaluate',
            'a different authored mode is evaluated again',
        );
    }

    // 5. Accepting suppresses like dismissing, and reset() clears it.
    {
        const advisor = new TransportModeAdvisor();
        advisor.evaluate(input({ now: 0, along: 0 }));
        advisor.evaluate(input({ now: 10000, along: 100 }));
        advisor.showPrompt(prompt('foot', 'boat'), META);
        const accepted = advisor.accept();
        ok(accepted, 'accept returns the answered prompt');
        equal(advisor.prompt, null, 'accepting clears the prompt');
        equal(advisor.isSuppressed('foot'), true, 'accepting suppresses the authored mode');
        equal(advisor.evaluate(input({ now: 10000 })).kind, 'suppressed', 'accept suppresses the offer');

        advisor.reset();
        equal(advisor.isSuppressed('foot'), false, 'reset clears the suppression');
        equal(advisor.prompt, null, 'reset leaves no prompt');
        equal(
            advisor.evaluate(input({ now: 100000 })).kind,
            'wait',
            'after a reset the follow delay restarts',
        );
        equal(
            advisor.evaluate(input({ now: 110000 })).kind,
            'evaluate',
            'after a reset the authored mode is offered again',
        );
    }

    // 6. Saving threshold: saves >= max(minSavingS, ratio * authoredRemaining).
    {
        const advisor = new TransportModeAdvisor();
        equal(advisor.accepts(400, 500), true, 'saving exactly 100 s of 500 s is accepted');
        equal(advisor.accepts(460, 500), false, 'saving 40 s of 500 s is rejected');
        equal(advisor.accepts(130, 200), true, 'saving 70 s of 200 s is accepted');
        equal(advisor.accepts(150, 200), false, 'saving 50 s of 200 s is rejected');
        equal(advisor.accepts(140, 200), true, 'the exact threshold boundary is accepted');
        equal(advisor.accepts(20, 50), false, 'the 60 s absolute floor binds on a short leg');
        equal(advisor.accepts(0, 50), false, 'saving everything is not enough on a short leg');
    }

    // 7. Cooldown between two requests (cooldownMs = 30000).
    {
        const advisor = new TransportModeAdvisor();
        equal(advisor.evaluate(input({ now: 0, along: 0 })).kind, 'wait', 'the first sample waits');
        equal(advisor.evaluate(input({ now: 10000, along: 100 })).kind, 'evaluate', 'the first request');
        equal(advisor.evaluate(input({ now: 39999, along: 200 })).kind, 'cooldown', '29 999 ms is too early');
        equal(advisor.evaluate(input({ now: 40000, along: 200 })).kind, 'evaluate', '30 000 ms allows a retry');
    }

    // 8. A mode change cancels the prompt and re-arms the new mode.
    {
        const advisor = new TransportModeAdvisor();
        advisor.evaluate(input({ now: 10000, mode: 'boat', authoredMode: 'ground' }));
        advisor.showPrompt(prompt('ground', 'boat'), META);
        ok(advisor.prompt, 'the boat offer is shown');

        const cancelled = advisor.evaluate(input({ now: 20000, mode: 'foot', authoredMode: 'ground' }));
        equal(cancelled.kind, 'cancel-prompt', 'changing the player mode cancels the offer');
        equal(advisor.prompt, null, 'the cancelled prompt is gone');
        equal(advisor.isSuppressed('ground'), false, 'cancelling does not suppress the mode');

        const retried = advisor.evaluate(input({ now: 50000, mode: 'foot', authoredMode: 'ground' }));
        equal(retried.kind, 'evaluate', 'the new mode is evaluated after the cooldown');
    }

    // 9. Travelling the authored mode cancels the offer and never evaluates.
    {
        const advisor = new TransportModeAdvisor();
        advisor.showPrompt(prompt('ground', 'boat'), META);
        const decision = advisor.evaluate(input({ mode: 'ground', authoredMode: 'ground' }));
        equal(decision.kind, 'cancel-prompt', 'matching modes cancel the offer');
        equal(advisor.prompt, null, 'the matching-mode prompt is cleared');
    }

    // 10. Connector and advisor legs are ignored.
    {
        for (const legSource of ['connector', 'advisor']) {
            const advisor = new TransportModeAdvisor();
            equal(
                advisor.evaluate(input({ now: 10000, legSource })).kind,
                'idle',
                `a ${legSource} leg never triggers the advisor`,
            );
        }
    }

    // 11. Stationary, off-route and in-flight updates never evaluate.
    {
        for (const overrides of [
            { moving: false },
            { onRoute: false },
            { planningInFlight: true },
            { navigating: false },
        ]) {
            const advisor = new TransportModeAdvisor();
            const decision = advisor.evaluate(input({ now: 10000, ...overrides }));
            equal(decision.kind, 'idle', `${JSON.stringify(overrides)} must not evaluate`);
        }
    }

    // 12. Failed plans warn once per authored mode and wait the fail cooldown.
    {
        const advisor = new TransportModeAdvisor();
        equal(advisor.evaluate(input({ now: 0, along: 0 })).kind, 'wait', 'the first sample waits');
        equal(advisor.evaluate(input({ now: 10000, along: 100 })).kind, 'evaluate', 'a request is made');

        equal(
            advisor.markPlanFailed(10000, 'error').warnUnreachable,
            false,
            'a planning error does not warn about unreachable modes',
        );
        equal(
            advisor.evaluate(input({ now: 40000, along: 100 })).kind,
            'cooldown',
            'a failure waits the 60 s fail cooldown',
        );
        equal(advisor.evaluate(input({ now: 70000, along: 100 })).kind, 'evaluate', 'after the fail cooldown');
        equal(
            advisor.markPlanFailed(70000, 'no-path').warnUnreachable,
            true,
            'a no-path failure warns once',
        );
        equal(advisor.evaluate(input({ now: 130000, along: 100 })).kind, 'evaluate', 'the next request');
        equal(
            advisor.markPlanFailed(130000, 'no-path').warnUnreachable,
            false,
            'the same authored mode never warns twice',
        );
    }

    // 13. Accepting splices only up to the next waypoint.
    {
        const connector = {
            mode: 'foot',
            kind: 'walk',
            points: [0, 0, 0, 5],
            distance: 5,
            eta: 3.6,
            source: 'connector',
        };
        const sharedRoad = {
            mode: 'ground',
            kind: 'road',
            points: [0, 5, 50, 5],
            distance: 50,
            eta: 8,
            source: 'shared',
        };
        const sharedWater = {
            mode: 'boat',
            kind: 'water',
            points: [52, 5, 52, 60],
            distance: 55,
            eta: 9,
            source: 'shared',
        };

        const legs = [connector, sharedRoad, sharedWater];
        const geometry = buildRouteGeometry(legs);

        // The next shared waypoint is the start of the water leg; the request
        // index 1 points at it in the route's waypoint list.
        const waypoints = [[0, 5], [52, 5], [52, 60]];
        const waypointAlong = [0, 60, 120];

        const advisor = new TransportModeAdvisor();
        equal(
            advisor.evaluate(input({
                now: 0,
                along: 0,
                waypointAlong,
                authoredSpeed: 6.25,
                authoredMode: 'ground',
                mode: 'boat',
            })).kind,
            'wait',
            'the first sample waits',
        );
        const decision = advisor.evaluate(input({
            now: 10000,
            along: 5,
            waypointAlong,
            authoredSpeed: 6.25,
            authoredMode: 'ground',
            mode: 'boat',
        }));
        equal(decision.kind, 'evaluate', 'an alternative is requested');
        equal(decision.nextWaypointIndex, 1, 'the next waypoint ahead is index 1');

        const alternative = {
            source: 'planned',
            legs: [{
                mode: 'boat',
                kind: 'water',
                points: [5, 5, 52, 10],
                distance: 47.4,
                eta: 6.3,
                source: 'planned',
            }],
            waypoints: [[52, 10]],
            distance: 47.4,
            eta: 6.3,
            createdAt: 1,
        };

        advisor.showPrompt(
            prompt('ground', 'boat', decision.nextWaypointIndex),
            { segment: decision.nextWaypointIndex, authoredRemaining: decision.authoredRemaining },
        );
        ok(advisor.accept(), 'the offer is accepted');

        // Mirror of GpsModule.acceptAdvisor (the module itself needs OpenLayers).
        const waypoint = waypoints[decision.nextWaypointIndex];
        const cutProjection = projectPointToPolyline(waypoint[0], waypoint[1], geometry.points);
        const cutSegment = cutProjection ? cutProjection.segment : 0;
        const remaining = sliceLegsFrom(legs, geometry, cutSegment, null);
        const alternativeLegs = alternative.legs.map(leg => ({ ...leg, source: 'advisor' }));
        const spliced = [...alternativeLegs, ...remaining].filter(leg => leg.points.length >= 4);
        const distance = spliced.reduce((total, leg) => total + leg.distance, 0);
        const eta = spliced.reduce((total, leg) => total + leg.eta, 0);

        equal(spliced.length, 2, 'the alternative and the water leg remain');
        equal(spliced[0].source, 'advisor', 'the alternative leg is marked as an advisor leg');
        ok(
            !spliced.some(leg => leg.source === 'connector'),
            'the connector leg is gone after accepting',
        );
        ok(
            !spliced.some(leg => leg.kind === 'road'),
            'everything before the waypoint is gone',
        );
        equal(spliced[1].kind, 'water', 'the water leg survives the splice');
        deepEqual(spliced[1].points.slice(-2), [52, 60], 'the destination survives the splice');
        ok(
            Math.abs(distance - (alternative.distance + sharedWater.distance)) < 1e-9,
            `the spliced distance is the sum of the kept legs, got ${distance}`,
        );
        ok(
            Math.abs(eta - (alternative.eta + sharedWater.eta)) < 1e-9,
            `the spliced eta is the sum of the kept legs, got ${eta}`,
        );
    }

    // 14. No waypoint ahead means nothing to evaluate.
    {
        const advisor = new TransportModeAdvisor();
        equal(advisor.evaluate(input({ now: 0, along: 0, waypointAlong: [0, 5] })).kind, 'wait', 'first sample');
        equal(
            advisor.evaluate(input({ now: 10000, along: 100, waypointAlong: [0, 5] })).kind,
            'idle',
            'past the last waypoint nothing is evaluated',
        );
    }
}
