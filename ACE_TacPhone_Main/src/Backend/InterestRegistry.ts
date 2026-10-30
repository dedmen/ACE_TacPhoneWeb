// Host-side registry of the game data interests this page currently needs.
//
// An app announces that it needs a named "information interest" (for example
// "ACE_TacPhone_Map.markers") with `window.InterestRegistry.acquire()`. The host
// turns that into an `Interest.Set` request to the game, which then does the
// expensive work and only targets the clients that asked for it. `acquire()` is
// reference counted, so several panels of the same app (or several apps that
// happen to want the same data) share one game interest; the returned disposer
// releases one reference and is idempotent.
//
// The game treats `Interest.Set` as idempotent and stores the membership of one
// client as a set, so re-announcing an interest is always safe.
//
// Reconnects: the game deletes a websocket client's interests when its
// connection closes (`RemoveConnectionAsync`), so the registry keeps the desired
// set and re-announces every held interest whenever the transport reconnects
// (see Networking.OnConnectionChange). Requests are only sent while the
// transport is up; everything that is still desired is replayed on reconnect,
// so an interest is never silently dropped.
//
// The in-game browser never disconnects on its own, so a `pagehide` handler
// sends one best-effort `Interest.Clear` (covers a page reload).
//
// Nothing here throws on a runtime path: an invalid name is rejected with a
// warning, and a failed request is logged (a lost announcement is retried by the
// next flush or reconnect), because a lost interest must never break an app.

/** Longest accepted interest name; longer names are rejected. */
const MAX_INTEREST_LENGTH = 128;

/** Built-in app that owns the interest commands (there is no app processor for them). */
const INTEREST_APP = "main";

/** Shared disposer of a rejected `acquire()`; releasing it does nothing. */
const NOOP = (): void => undefined;

/**
 * Validated interest name, or undefined for anything that is not a usable name.
 *
 * Names are opaque strings namespaced by app ("<AppName>.<feature>"). Only the
 * shape is validated here: non-empty after trimming, at most
 * MAX_INTEREST_LENGTH characters. Whether anyone in the game handles the name is
 * not this registry's business.
 */
function normalizeInterest(interest: unknown): string | undefined {
    if (typeof interest !== "string")
        return undefined;

    const trimmed = interest.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_INTEREST_LENGTH)
        return undefined;

    return trimmed;
}

/**
 * Reference-counted registry of the data interests of one page.
 *
 * One instance lives at module scope as `window.InterestRegistry`. Apps acquire
 * an interest for as long as they need its data and release it otherwise; see
 * the README section "Data interests".
 */
export class InterestRegistry {
    /** References per desired interest. Only interests with a positive count are kept. */
    private readonly references = new Map<string, number>();
    /** Interests the game was already told about; emptied when the transport drops. */
    private readonly announced = new Set<string>();
    private readonly listeners = new Set<(interests: string[]) => void>();
    private unsubscribeConnection: (() => void) | undefined;
    private connected = false;
    private pagehideInstalled = false;
    private notifying = false;

    /**
     * Adds one reference to an interest.
     *
     * The game is told only on the first reference (0 -> 1); further calls just
     * increase the count. The returned disposer is idempotent and withdraws the
     * interest when the last reference is released (1 -> 0). An invalid name is
     * rejected with a warning and yields a disposer that does nothing.
     *
     * The request is issued synchronously, and both transports preserve request
     * order, so a follow-up request (for example a snapshot) cannot overtake it.
     */
    acquire(interest: string): () => void {
        const name = normalizeInterest(interest);
        if (!name) {
            console.warn(`TacPhone InterestRegistry: invalid interest name ${JSON.stringify(interest)}; use a non-empty string of at most ${MAX_INTEREST_LENGTH} characters.`);
            return NOOP;
        }

        this.ensureSubscriptions();

        const count = this.references.get(name) ?? 0;
        this.references.set(name, count + 1);

        if (count === 0) {
            this.flush();
            this.notifyChanged();
        }

        let released = false;
        return () => {
            if (released)
                return;

            released = true;
            this.release(name);
        };
    }

    /** True while this page holds at least one reference to the interest. */
    isActive(interest: string): boolean {
        const name = normalizeInterest(interest);
        return name !== undefined && (this.references.get(name) ?? 0) > 0;
    }

    /** Every interest this page currently holds, in the order they were acquired. */
    list(): string[] {
        return [...this.references.keys()];
    }

    /** Subscribes to changes of the held set. Returns an unsubscribe function. */
    onDidChange(listener: (interests: string[]) => void): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Drops one reference; the interest is withdrawn from the game on 1 -> 0. */
    private release(name: string): void {
        const count = this.references.get(name) ?? 0;
        if (count <= 0)
            return;

        if (count > 1) {
            this.references.set(name, count - 1);
            return;
        }

        this.references.delete(name);
        this.flush();
        this.notifyChanged();
    }

    /**
     * Brings the game in sync with the desired set: announces interests it does
     * not know about yet and withdraws the ones nobody wants anymore.
     *
     * Nothing is sent while the transport is down; the reconnect handler replays
     * the whole desired set, so a live connection is the only requirement.
     */
    private flush(): void {
        if (!this.connected)
            return;

        for (const name of [...this.references.keys()]) {
            if (this.announced.has(name))
                continue;

            // Marked before the request settles: a second acquire while the first
            // request is in flight must not send a duplicate.
            this.announced.add(name);
            this.post(
                { a: INTEREST_APP, c: "Interest.Set", interest: name, active: true },
                () => this.announced.delete(name)
            );
        }

        for (const name of [...this.announced]) {
            if (this.references.has(name))
                continue;

            this.announced.delete(name);
            // A failed withdrawal is not retried: the only reason it fails is a
            // transport that is gone, and the game drops those interests itself.
            this.post({ a: INTEREST_APP, c: "Interest.Set", interest: name, active: false });
        }
    }

    /** Sends one interest request; failures are logged, never thrown. */
    private post(request: object, onFailure?: () => void): void {
        const networking = window.Networking;
        if (!networking) {
            console.warn("TacPhone InterestRegistry: the transport is missing; interest request dropped:", request);
            onFailure?.();
            return;
        }

        try {
            // Promise.resolve keeps a transport that answers synchronously (or not
            // at all) from throwing here, and still reports a rejection.
            Promise.resolve(networking.Request(request)).catch((error: unknown) => {
                onFailure?.();
                console.warn("TacPhone InterestRegistry: interest request failed:", error);
            });
        } catch (error) {
            onFailure?.();
            console.warn("TacPhone InterestRegistry: interest request failed:", error);
        }
    }

    /** Transport went up or down; a reconnect replays the whole desired set. */
    private readonly handleConnectionChange = (connected: boolean): void => {
        if (this.connected === connected)
            return;

        this.connected = connected;

        // The game dropped this client's interests with the connection, so
        // everything the page still wants has to be announced again.
        this.announced.clear();

        if (connected)
            this.flush();
    };

    /** Best effort on unload: the in-game browser never disconnects by itself. */
    private readonly handlePageHide = (): void => {
        if (this.references.size === 0 || !this.connected)
            return;

        this.announced.clear();
        this.post({ a: INTEREST_APP, c: "Interest.Clear" });
    };

    /** Connects to the transport and the page lifecycle once, on first use. */
    private ensureSubscriptions(): void {
        if (this.unsubscribeConnection === undefined) {
            const networking = window.Networking;
            if (!networking) {
                // Retried on the next acquire: the transport may not exist yet.
                console.warn("TacPhone InterestRegistry: the transport is missing; interests are only tracked locally.");
            } else {
                this.unsubscribeConnection = networking.OnConnectionChange(this.handleConnectionChange);
            }
        }

        if (this.pagehideInstalled)
            return;

        this.pagehideInstalled = true;
        window.addEventListener("pagehide", this.handlePageHide);
    }

    /** Forwards the current interest list to the listeners; listener failures are contained. */
    private notifyChanged(): void {
        // A listener may call back into the registry; one notification is enough.
        if (this.listeners.size === 0 || this.notifying)
            return;

        this.notifying = true;

        try {
            const interests = this.list();

            for (const listener of [...this.listeners]) {
                try {
                    listener(interests);
                } catch (error) {
                    console.error("TacPhone InterestRegistry listener failed:", error);
                }
            }
        } finally {
            this.notifying = false;
        }
    }
}

declare global {
    interface Window {
        // Demand-driven game data: acquire/release named data interests (see Backend/InterestRegistry.ts).
        InterestRegistry: InterestRegistry;
    }
}

window.InterestRegistry = new InterestRegistry();
