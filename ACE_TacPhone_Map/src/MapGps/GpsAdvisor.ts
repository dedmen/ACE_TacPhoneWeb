/**
 * Transport-mode advisor flow for the GPS module: when a slower authored/shared
 * leg is passed it plans a faster alternative in the current mode and offers it
 * as a card, drawing the alternative as a dashed line while it is shown.
 *
 * Split out of `GpsModule` (the orchestrator). The class holds a back-reference
 * to the module (`m`) and drives the shared `TransportModeAdvisor` decision
 * state (`m.advisor`) plus the module's planner.
 */

import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import { Style, Stroke } from 'ol/style';

import { legSpeed } from '../routing/SpeedModel';
import { flattenToCoordinates } from './RouteSplice';
import type { ActiveRoute, AdvisorPrompt, RouteLeg, TravelMode } from './GpsTypes';
import type { GpsModule } from './GpsModule';

/** Player speed above which the advisor may offer an alternative. */
export const ADVISOR_MIN_SPEED = 1;

/** Travel-mode advisor planning and prompt lifecycle. */
export class GpsAdvisor {
    private readonly m: GpsModule;

    constructor(m: GpsModule) {
        this.m = m;
    }

    evaluateAdvisor(metrics: {
        along: number;
        segment: number;
        legIndex: number;
    }): void {
        const route = this.m.activeRoute;
        if (!route || !this.m.routeGeometry) {
            return;
        }

        const authoredLeg = route.legs[metrics.legIndex];
        if (!authoredLeg) {
            return;
        }

        const authoredPerf = route.shared?.vehicle;
        const authoredWater = authoredPerf?.canFloat === true;
        const authoredSpeed = authoredLeg.distance > 0 && authoredLeg.eta > 0
            ? authoredLeg.distance / authoredLeg.eta
            : legSpeed(authoredLeg.mode, authoredLeg.kind, authoredPerf, authoredWater);

        const decision = this.m.advisor.evaluate({
            now: Date.now(),
            source: route.source,
            navigating: this.m.navigating,
            moving: this.m.speed > ADVISOR_MIN_SPEED,
            onRoute: !this.m.offRoute,
            planningInFlight: this.m.advisorPlanning,
            mode: this.m.mode,
            authoredMode: authoredLeg.mode,
            legSource: authoredLeg.source,
            along: metrics.along,
            waypointAlong: this.m.waypointAlong,
            authoredSpeed,
        });

        if (decision.kind === 'cancel-prompt') {
            this.clearAdvisorPrompt();
            return;
        }

        if (decision.kind !== 'evaluate') {
            return;
        }

        this.requestAdvisorAlternative(decision, route, metrics, authoredLeg);
    }

    /** Plans the alternative the advisor asked for and shows the offer. */
    private requestAdvisorAlternative(
        decision: { nextWaypointIndex: number; authoredRemaining: number; threshold: number },
        route: ActiveRoute,
        metrics: { along: number; segment: number; legIndex: number },
        authoredLeg: RouteLeg,
    ): void {
        const waypoint = route.waypoints[decision.nextWaypointIndex];
        if (!waypoint) {
            return;
        }

        const authoredMode = authoredLeg.mode;

        this.m.advisorPlanning = true;
        const token = ++this.m.advisorToken;
        // The plan is only valid for the mode it was requested with: the player
        // can switch travel mode while it runs.
        const plannedMode = this.m.mode;

        void this.m.planner.plan({
            start: this.m.position ?? waypoint,
            waypoints: [waypoint],
            mode: plannedMode,
            waterCapable: this.m.effectiveWaterCapable(),
            performance: this.m.effectivePerformance(),
            cancelled: () => this.m.destroyed || token !== this.m.advisorToken,
        }).then((result) => {
            this.m.advisorPlanning = false;

            if (this.m.destroyed || token !== this.m.advisorToken || plannedMode !== this.m.mode) {
                return;
            }

            if (!result.ok || !result.route || result.route.eta === null) {
                const failed = this.m.advisor.markPlanFailed(
                    Date.now(),
                    result.reason === 'no-path' ? 'no-path' : 'error',
                );

                if (failed.warnUnreachable && !this.m.destroyed) {
                    this.m.status = { kind: 'advisor-unreachable', mode: this.m.mode };
                    this.m.emitState(true);
                }
                return;
            }

            this.m.advisor.markPlanSucceeded();
            if (this.m.status?.kind === 'advisor-unreachable') {
                this.m.status = null;
            }

            const alternativeSeconds = result.route.eta;
            if (!this.m.advisor.accepts(alternativeSeconds, decision.authoredRemaining)) {
                return;
            }

            const prompt: AdvisorPrompt = {
                authoredMode,
                mode: plannedMode,
                alternativeSeconds,
                savesSeconds: decision.authoredRemaining - alternativeSeconds,
                waypointIndex: decision.nextWaypointIndex,
            };
            this.m.advisor.showPrompt(prompt, {
                segment: metrics.segment,
                authoredRemaining: decision.authoredRemaining,
            });
            this.m.advisorAlternative = result.route;

            this.drawAdvisorAlternative(result.route, authoredMode);

            try {
                window.TacPhone.audio.play('alert');
            } catch (error) {
                console.warn('GPS: could not play the advisor sound', error);
            }

            this.m.emitState(true);
        }).catch((error: unknown) => {
            this.m.advisorPlanning = false;
            console.warn('GPS: advisor route planning failed', error);
        });
    }

    private drawAdvisorAlternative(route: ActiveRoute, authoredMode: TravelMode): void {
        this.m.advisorSource.clear();

        for (const leg of route.legs) {
            if (leg.points.length < 4) {
                continue;
            }
            const feature = new Feature(new LineString(flattenToCoordinates(leg.points)));
            feature.setStyle(new Style({
                stroke: new Stroke({
                    color: 'rgba(244, 114, 182, 0.95)',
                    width: 3,
                    lineDash: [3, 5],
                }),
            }));
            this.m.advisorSource.addFeature(feature);
        }

        // Keep the authored mode readable for the card text.
        this.m.advisorSource.set('authoredMode', authoredMode);
    }

    clearAdvisorPrompt(): void {
        const hadPrompt = this.m.advisor.prompt !== null;
        this.m.advisor.clearPrompt();
        this.m.advisorAlternative = null;

        if (!hadPrompt && this.m.advisorSource.getFeatures().length === 0) {
            return;
        }

        this.m.advisorToken += 1;
        this.m.advisorSource.clear();
    }
}
