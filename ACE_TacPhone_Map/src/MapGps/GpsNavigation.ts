/**
 * Navigation metrics, junction/turn handling, speech guidance and arrival for
 * the GPS module.
 *
 * Split out of `GpsModule` (the orchestrator). The class holds a back-reference
 * to the module (`m`) and reads/writes the shared GPS state through it. It is
 * driven by the module on every position fix and reads the deviation decision
 * from the shared `DeviationTracker`.
 */

import type { RouteLeg } from './GpsTypes';
import { computeRouteMetrics } from '../routing/RouteMetrics';
import {
    nextManeuver,
    nextSurfaceTransition,
    isRoadLeg,
    pointAtDistance,
    spokenDistance,
    guidanceCue,
    GUIDANCE_FAR_CUE_M,
    type Maneuver,
} from '../routing/TurnInstructions';
import { ADVISOR_MIN_SPEED } from './GpsAdvisor';
import type { GpsModule } from './GpsModule';

/** How long the Arrived badge stays before the finished route is cleared. */
const ARRIVAL_CLEAR_MS = 10_000;

/** Navigation metrics, junction handling, speech guidance and arrival. */
export class GpsNavigation {
    private readonly m: GpsModule;

    constructor(m: GpsModule) {
        this.m = m;
    }

    updateNavigation(): void {
        const metrics = this.currentMetrics();
        if (!metrics || !this.m.routeGeometry) {
            return;
        }

        const legs = this.m.activeRoute?.legs ?? [];
        const currentLeg = legs[metrics.legIndex];
        const nextLeg = legs[metrics.legIndex + 1];
        const transition = nextSurfaceTransition(
            legs,
            this.m.routeGeometry,
            metrics.along,
            metrics.legIndex,
            550,
        );
        const maneuver = nextManeuver(this.m.routeGeometry.points, metrics.along);
        const roadTurn = isRoadLeg(currentLeg)
            && (nextLeg === undefined || isRoadLeg(nextLeg))
            && this.isJunctionManeuver(maneuver, metrics.along);
        this.m.turn = roadTurn ? maneuver.turn : null;
        this.m.turnDistance = roadTurn ? maneuver.distance : null;

        if (this.m.navigating) {
            this.speakGuidance(metrics, currentLeg, transition);
        }

        if (Math.abs(metrics.along - this.m.lastRouteDrawAlong) > 5) {
            this.m.routes.drawRoute();
        }

        const decision = this.m.deviation.update({
            now: Date.now(),
            metrics,
            mode: this.m.mode,
            navigating: this.m.navigating,
            autoRepath: this.m.settings.autoRepath,
            waypointAlong: this.m.waypointAlong,
        });

        this.m.offRoute = decision.offRoute;

        if (decision.reachedWaypoint) {
            window.TacPhone.audio.play('message');
        }

        if (decision.repath && this.m.position && !this.m.calculating) {
            void this.m.routes.recalculateRemaining(this.m.position, 'auto');
        }

        if (decision.arrived) {
            this.completeArrival();
        }

        if (
            this.m.navigating
            && this.m.activeRoute?.source === 'shared'
            && !decision.offRoute
            && this.m.speed > ADVISOR_MIN_SPEED
        ) {
            this.m.advisorFlow.evaluateAdvisor(metrics);
        } else if (this.m.advisor.prompt) {
            this.m.advisorFlow.clearAdvisorPrompt();
        }
    }

    /**
     * Nearest real junction for a left/right maneuver, or null. The node
     * position is stable, so it also identifies the junction for speech
     * deduplication.
     */
    private maneuverJunction(maneuver: Maneuver, along: number): [number, number] | null {
        if (
            (maneuver.turn !== 'left' && maneuver.turn !== 'right')
            || maneuver.distance === null
            || !this.m.routeGeometry
        ) {
            return null;
        }

        const point = pointAtDistance(this.m.routeGeometry.points, along + maneuver.distance);
        return point ? this.m.planner.roadJunction(point, 20) : null;
    }

    /**
     * True when a maneuver happens at a real road junction. A bend in one
     * road, or two road ends meeting head-to-head, has only two branches and
     * must not produce a turn cue.
     */
    private isJunctionManeuver(maneuver: Maneuver, along: number): boolean {
        if (maneuver.turn === null) {
            return false;
        }
        if (maneuver.turn === 'straight') {
            return true;
        }
        return this.maneuverJunction(maneuver, along) !== null;
    }

    /**
     * Voice guidance for the next road turn or road/off-road transition.
     *
     * Each junction and each surface transition is announced once, when it
     * first comes within 500 m; the spoken distance is the real distance, not
     * a fixed bucket. Off-road turns are deliberately silent. English text is
     * a test implementation and is not a stringtable key.
     */
    private speakGuidance(
        metrics: { along: number },
        currentLeg: RouteLeg | undefined,
        transition: ReturnType<typeof nextSurfaceTransition>,
    ): void {
        const audio = window.TacPhone.audio;
        if (typeof audio?.speak !== 'function') {
            return;
        }

        const now = Date.now();
        if (now - this.m.lastSpeechAt < 3000) {
            return;
        }

        const speak = (key: string, text: string): void => {
            this.m.spokenGuidance.add(key);
            this.m.lastSpeechAt = now;
            try {
                audio.speak(text);
            } catch {
                // Voice guidance must never break navigation.
            }
        };

        if (transition && transition.distance <= GUIDANCE_FAR_CUE_M) {
            // The leg boundary is a route distance, so it stays stable while
            // the player moves; it is a good identity for the transition.
            const key = `transition:${Math.round(transition.boundaryAlong)}`;
            if (!this.m.spokenGuidance.has(key)) {
                const direction = transition.direction;
                const meters = spokenDistance(transition.distance);
                speak(
                    key,
                    transition.enteringRoad
                        ? `in ${meters} meters, enter the road and continue ${direction === 'straight' ? 'straight' : `to the ${direction}`}`
                        : `in ${meters} meters, leave the road${direction === 'straight' ? '' : ` to the ${direction}`} and continue offroad`,
                );
                return;
            }
        }

        if (!isRoadLeg(currentLeg) || !this.m.routeGeometry) {
            return;
        }

        const maneuver = nextManeuver(this.m.routeGeometry.points, metrics.along, 550);
        if (maneuver.turn !== 'left' && maneuver.turn !== 'right') {
            return;
        }
        const cue = maneuver.distance === null ? null : guidanceCue(maneuver.distance);
        if (cue === null || maneuver.distance === null) {
            return;
        }

        const junction = this.maneuverJunction(maneuver, metrics.along);
        if (!junction) {
            return;
        }

        // A surface transition at this junction already includes the
        // direction; announcing the turn again would double the message.
        if (
            transition
            && Math.abs(transition.boundaryAlong - (metrics.along + maneuver.distance)) < 80
        ) {
            return;
        }

        // The graph node identifies the junction even when the sampled turn
        // distance drifts by a few metres between fixes. The far and near
        // cues are separate, so approaching a junction gets exactly two
        // announcements.
        const key = `turn:${Math.round(junction[0])},${Math.round(junction[1])}:${cue}`;
        if (this.m.spokenGuidance.has(key)) {
            return;
        }
        speak(key, `turn ${maneuver.turn} in ${spokenDistance(maneuver.distance)} meters`);
    }

    completeArrival(): void {
        if (this.m.arrived) {
            return;
        }

        this.m.arrived = true;
        this.m.navigating = false;
        this.m.advisorFlow.clearAdvisorPrompt();
        if (!this.m.arrivalSoundPlayed) {
            this.m.arrivalSoundPlayed = true;
            window.TacPhone.audio.play('success');
        }

        // Keep the Arrived badge visible, then drop the finished route and
        // leave waypoint-planning mode.
        this.cancelArrivalClear();
        this.m.arrivalTimer = window.setTimeout(() => {
            this.m.arrivalTimer = null;
            if (this.m.destroyed) {
                return;
            }
            this.m.planning = false;
            this.m.clearWaypoints();
        }, ARRIVAL_CLEAR_MS);
    }

    /** Cancels a pending post-arrival route clear. */
    cancelArrivalClear(): void {
        if (this.m.arrivalTimer !== null) {
            window.clearTimeout(this.m.arrivalTimer);
            this.m.arrivalTimer = null;
        }
    }

    currentMetrics() {
        if (!this.m.position || !this.m.routeGeometry) {
            return null;
        }
        return computeRouteMetrics(this.m.position, this.m.routeGeometry);
    }
}
