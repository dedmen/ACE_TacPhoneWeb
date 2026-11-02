/**
 * Decision logic of the transport-mode advisor.
 *
 * When a shared route was authored for a slower travel mode (a walk route, a
 * boat route), the GPS offers to plan the next stretch with the player's
 * current mode instead. This module owns *when* to offer that, and nothing
 * else: it never plans, draws or plays audio. `GpsModule` feeds it plain values
 * (including the clock) and interprets the returned decision, which keeps the
 * state machine game-free and unit testable without timers.
 *
 * Suppression is per authored mode: answering "no" for a walk route does not
 * suppress the offer for a boat stretch later on the same route.
 */

import type { AdvisorPrompt, RouteLeg, TravelMode } from './GpsTypes';

/** Everything the advisor needs for one navigation update. */
export interface AdvisorInput {
    /** Injected clock in milliseconds. */
    now: number;
    /** Where the followed route came from; only shared routes are advised. */
    source: 'planned' | 'shared';
    /** True while navigation is running. */
    navigating: boolean;
    /** True when the player moves faster than the advisor floor. */
    moving: boolean;
    /** True when the player is not off-route (and no connector is in flight). */
    onRoute: boolean;
    /** True while an advisor alternative is being planned. */
    planningInFlight: boolean;
    /** The player's current mode. */
    mode: TravelMode;
    /** Mode of the leg under the player. */
    authoredMode: TravelMode;
    /** Origin of the leg under the player; connector/advisor legs are ignored. */
    legSource?: RouteLeg['source'];
    /** Metres along the route. */
    along: number;
    /** Metres along the route for each waypoint. */
    waypointAlong: number[];
    /** Authored speed in m/s, from the leg's eta/distance or `legSpeed()`. */
    authoredSpeed: number;
}

/** What `GpsModule` should do with this update. */
export type AdvisorDecision =
    /** Not applicable (planned route, connector leg, no waypoint ahead). */
    | { kind: 'idle' }
    /** The follow delay is not reached yet. */
    | { kind: 'wait' }
    /** An alternative was rejected recently. */
    | { kind: 'cooldown' }
    /** The player already answered for this authored mode. */
    | { kind: 'suppressed' }
    /** Plan an alternative to `nextWaypointIndex`. */
    | {
        kind: 'evaluate';
        nextWaypointIndex: number;
        authoredRemaining: number;
        threshold: number;
    }
    /** Drop a shown prompt (mode changed, or it no longer applies). */
    | { kind: 'cancel-prompt' };

/** Tunables; the defaults are the shipped behaviour. */
export interface AdvisorThresholds {
    /** Minimum time on the authored mode before offering an alternative. */
    minFollowMs: number;
    /** Minimum distance on the authored mode before offering an alternative. */
    minFollowM: number;
    /** Delay between two planning attempts. */
    cooldownMs: number;
    /** Delay after a failed alternative plan. */
    failCooldownMs: number;
    /** Minimum absolute saving in seconds. */
    minSavingS: number;
    /** Minimum saving as a fraction of the authored remaining time. */
    minSavingRatio: number;
}

const DEFAULT_THRESHOLDS: AdvisorThresholds = {
    minFollowMs: 10000,
    minFollowM: 100,
    cooldownMs: 30000,
    failCooldownMs: 60000,
    minSavingS: 60,
    minSavingRatio: 0.2,
};

/** Metres a waypoint must be ahead of the player to be offered as a target. */
const WAYPOINT_AHEAD_M = 10;

/**
 * Decides when to offer a faster alternative on a shared route.
 *
 * All time comes from the injected `now`, so the machine is deterministic and
 * needs no timers.
 */
export class TransportModeAdvisor {
    private readonly thresholds: AdvisorThresholds;

    private currentPrompt: AdvisorPrompt | null = null;
    private promptSegment = 0;
    private promptAuthoredRemaining = 0;

    /** Authored mode the player already answered for. */
    private suppressedMode: TravelMode | null = null;
    /** Authored mode whose alternative could not be planned. */
    private unreachableMode: TravelMode | null = null;

    /** Authored mode the follow delay is measured on. */
    private enteredMode: TravelMode | null = null;
    private enteredAt = 0;
    private enteredAlong = 0;

    /** When the last alternative was requested; `-Infinity` allows the first. */
    private lastEvaluatedAt = Number.NEGATIVE_INFINITY;
    /** Authored mode of the alternative currently being planned. */
    private pendingAuthoredMode: TravelMode | null = null;

    constructor(thresholds: Partial<AdvisorThresholds> = {}) {
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    }

    /** The offer currently shown, if any. */
    public get prompt(): AdvisorPrompt | null {
        return this.currentPrompt;
    }

    /** Resolution decision for one navigation update. */
    public evaluate(input: AdvisorInput): AdvisorDecision {
        if (input.source !== 'shared') {
            return { kind: 'idle' };
        }

        if (!input.navigating || !input.moving || !input.onRoute || input.planningInFlight) {
            return { kind: 'idle' };
        }

        if (input.legSource === 'connector' || input.legSource === 'advisor') {
            return { kind: 'idle' };
        }

        const authoredMode = input.authoredMode;

        // The player already travels the authored mode: nothing to offer.
        if (authoredMode === input.mode) {
            this.clearPrompt();
            this.enteredMode = null;
            return { kind: 'cancel-prompt' };
        }

        // A shown offer only survives while both modes still match.
        if (
            this.currentPrompt
            && (this.currentPrompt.authoredMode !== authoredMode || this.currentPrompt.mode !== input.mode)
        ) {
            this.clearPrompt();
            return { kind: 'cancel-prompt' };
        }

        if (this.suppressedMode === authoredMode) {
            return { kind: 'suppressed' };
        }

        if (this.enteredMode !== authoredMode) {
            this.enteredMode = authoredMode;
            this.enteredAt = input.now;
            this.enteredAlong = input.along;
            this.unreachableMode = null;
        }

        const followedLongEnough = input.now - this.enteredAt >= this.thresholds.minFollowMs;
        const movedEnough = input.along - this.enteredAlong >= this.thresholds.minFollowM;
        if (!followedLongEnough && !movedEnough) {
            return { kind: 'wait' };
        }

        // An offer is already on screen: keep it until the player answers.
        if (this.currentPrompt) {
            return { kind: 'idle' };
        }

        if (input.now - this.lastEvaluatedAt < this.thresholds.cooldownMs) {
            return { kind: 'cooldown' };
        }

        let nextWaypointIndex = -1;
        for (let index = 0; index < input.waypointAlong.length; index += 1) {
            if (input.waypointAlong[index] > input.along + WAYPOINT_AHEAD_M) {
                nextWaypointIndex = index;
                break;
            }
        }

        if (nextWaypointIndex < 0) {
            return { kind: 'idle' };
        }

        const nextAlong = input.waypointAlong[nextWaypointIndex];
        const authoredRemaining = Math.max(1, nextAlong - input.along) / Math.max(0.5, input.authoredSpeed);

        this.lastEvaluatedAt = input.now;
        this.pendingAuthoredMode = authoredMode;

        return {
            kind: 'evaluate',
            nextWaypointIndex,
            authoredRemaining,
            threshold: this.threshold(authoredRemaining),
        };
    }

    /** True when the alternative saves enough to be worth offering. */
    public accepts(alternativeSeconds: number, authoredRemaining: number): boolean {
        return authoredRemaining - alternativeSeconds >= this.threshold(authoredRemaining);
    }

    /** Records the offer the player can accept. */
    public showPrompt(
        prompt: AdvisorPrompt,
        meta: { segment: number; authoredRemaining: number },
    ): void {
        this.currentPrompt = prompt;
        this.promptSegment = meta.segment;
        this.promptAuthoredRemaining = meta.authoredRemaining;
    }

    /** Flattened segment the offer was made on. */
    public get segment(): number {
        return this.promptSegment;
    }

    /** Authored remaining time in seconds the offer was compared against. */
    public get authoredRemaining(): number {
        return this.promptAuthoredRemaining;
    }

    /** Player accepted: suppress the authored mode and drop the offer. */
    public accept(): AdvisorPrompt | null {
        return this.answer();
    }

    /** Player declined: same effect as {@link accept}. */
    public dismiss(): AdvisorPrompt | null {
        return this.answer();
    }

    /**
     * Records a failed alternative plan.
     *
     * `warnUnreachable` is true when the caller should tell the player that the
     * authored mode cannot reach the next waypoint - once per authored mode.
     */
    public markPlanFailed(
        now: number,
        reason: 'no-path' | 'error',
    ): { warnUnreachable: boolean } {
        // A failure waits the fail cooldown (which is longer than the normal one).
        this.lastEvaluatedAt = now
            + this.thresholds.failCooldownMs
            - this.thresholds.cooldownMs;

        const authoredMode = this.pendingAuthoredMode;
        if (reason !== 'no-path' || authoredMode === null || this.unreachableMode === authoredMode) {
            return { warnUnreachable: false };
        }

        this.unreachableMode = authoredMode;
        return { warnUnreachable: true };
    }

    /** Records a successful alternative plan; clears the unreachable marker. */
    public markPlanSucceeded(): void {
        this.unreachableMode = null;
    }

    /** Drops the shown offer without suppressing anything. */
    public clearPrompt(): void {
        this.currentPrompt = null;
        this.promptSegment = 0;
        this.promptAuthoredRemaining = 0;
    }

    /** True when this authored mode was already answered for. */
    public isSuppressed(authoredMode: TravelMode): boolean {
        return this.suppressedMode === authoredMode;
    }

    /** New shared route, manual recalculation or a new Start. */
    public reset(): void {
        this.clearPrompt();
        this.suppressedMode = null;
        this.unreachableMode = null;
        this.enteredMode = null;
        this.pendingAuthoredMode = null;
    }

    /** Threshold in seconds for a given authored remaining time. */
    private threshold(authoredRemaining: number): number {
        return Math.max(
            this.thresholds.minSavingS,
            authoredRemaining * this.thresholds.minSavingRatio,
        );
    }

    /** Suppresses the offered mode and drops the offer. */
    private answer(): AdvisorPrompt | null {
        const prompt = this.currentPrompt;
        if (!prompt) {
            return null;
        }

        this.suppressedMode = prompt.authoredMode;
        this.clearPrompt();
        return prompt;
    }
}
