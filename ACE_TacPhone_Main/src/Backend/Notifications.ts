// Host-side notification stack (phone-style banners).
//
// Apps call `window.TacPhone.notifications.show()` to raise a notification; the
// host UI (Panels/NotificationHost.tsx) subscribes through `subscribe()` and
// renders the current snapshot. The store is deliberately React-free: it lives in
// Backend so it can be used before the UI mounts, and so the snapshot can be
// consumed with `useSyncExternalStore`.
//
// Tap actions are resolved by the host, not here: the store only carries the
// sender-provided `action` on the stored notification. The action is always a
// page-local function; notifications are not sent from the game.
//
// Timers: every notification may have an auto-dismiss timer (its `duration`),
// and a dismissal starts the exit animation, which is a second, short timer.
// `dismiss()` is idempotent: repeated calls return while the removal timer runs.

import type {
    NotificationCenterApi,
    NotificationOptions,
    TacPhoneNotification,
} from "./Types";
import { appDirectory } from "./AppDirectory";
import { audio } from "./Audio";
import { networking } from "./Networking";
import { buildInGameNotifyRequest } from "./notifyRequest";

export type {
    NotificationAction,
    NotificationCenterApi,
    NotificationOptions,
    NotificationSound,
    NotificationTapHandler,
    TacPhoneNotification,
} from "./Types";

/** Default lifetime of a notification, in milliseconds. */
const DEFAULT_DURATION = 15_000;
/** Maximum number of stored (and therefore visible) notifications. */
const MAX_NOTIFICATIONS = 5;
/** Exit animation length, after which a closing notification is removed. */
const EXIT_ANIMATION_MS = 200;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * In-memory notification stack.
 *
 * Snapshots are immutable: `getSnapshot()` returns the current array reference
 * and every change replaces it, so React's `useSyncExternalStore` can compare
 * references. Subscribers are notified after the array was replaced.
 */
export class NotificationCenter
{
    private notifications: readonly TacPhoneNotification[] = [];
    private listeners = new Set<(notifications: readonly TacPhoneNotification[]) => void>();
    /** Auto-dismiss timer per notification id. */
    private autoTimers = new Map<string, number>();
    /** Exit-animation removal timer per notification id. */
    private removalTimers = new Map<string, number>();
    private nextId = 1;

    /** Current immutable snapshot; the reference changes on every change. */
    getSnapshot(): readonly TacPhoneNotification[] {
        return this.notifications;
    }

    /** Subscribes to snapshot changes; returns the unsubscribe function. */
    subscribe(listener: (notifications: readonly TacPhoneNotification[]) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Shows a notification and returns its id. */
    show(options: NotificationOptions): string {
        const id = `notification-${this.nextId++}`;
        const duration = typeof options.duration === "number" ? options.duration : DEFAULT_DURATION;

        const notification: TacPhoneNotification = {
            ...options,
            id,
            createdAt: Date.now(),
            icon: options.icon ?? this.defaultIcon(options.app),
            duration,
        };

        this.setNotifications([...this.notifications, notification]);
        this.trimToLimit();
        this.scheduleAutoDismiss(id, duration);

        // One sound per notification. The engine throttles bursts itself and
        // never throws; a missing/unknown preset only logs a warning.
        if (options.sound)
            audio.play(options.sound);

        // In-game channel: fire-and-forget Notify.Show. The banner above is
        // already shown, so the in-game path must never fail or block it.
        const inGameRequest = buildInGameNotifyRequest(options);
        if (inGameRequest)
            networking
                .Request(inGameRequest)
                .then(reply => {
                    // Suppression while the phone is open is expected and silent;
                    // a rate-limited one is worth one warning so chatty apps are
                    // diagnosable in release.
                    if (
                        reply !== null &&
                        typeof reply === "object" &&
                        (reply as { ok?: unknown }).ok === true &&
                        (reply as { shown?: unknown }).shown === false &&
                        (reply as { reason?: unknown }).reason === "rate limited"
                    )
                        console.warn(
                            "TacPhone in-game notification was rate limited by the game",
                        );
                })
                .catch(error => {
                    console.warn("TacPhone in-game notification request failed:", error);
                });

        return id;
    }

    /**
     * Starts the exit animation of one notification and removes it afterwards.
     * Idempotent: a second call while the notification is closing does nothing.
     */
    dismiss(id: string): void {
        const index = this.notifications.findIndex(notification => notification.id === id);
        if (index === -1)
            return;

        const notification = this.notifications[index];
        if (notification.closing)
            return;

        this.clearAutoTimer(id);

        const next = this.notifications.slice();
        next[index] = { ...notification, closing: true };
        this.setNotifications(next);

        // Defensive: never schedule the removal twice for the same notification.
        if (this.removalTimers.has(id))
            return;

        const timer = window.setTimeout(() => {
            this.removalTimers.delete(id);
            this.remove(id);
        }, EXIT_ANIMATION_MS);

        this.removalTimers.set(id, timer);
    }

    /** Removes every notification immediately, without the exit animation. */
    clear(): void {
        if (this.notifications.length === 0)
            return;

        for (const notification of this.notifications) {
            this.clearAutoTimer(notification.id);
            this.clearRemovalTimer(notification.id);
        }

        this.setNotifications([]);
    }

    private remove(id: string): void {
        const remaining = this.notifications.filter(notification => notification.id !== id);
        if (remaining.length === this.notifications.length)
            return;

        this.clearAutoTimer(id);
        this.setNotifications(remaining);
    }

    /** Drops the oldest notifications above MAX_NOTIFICATIONS, without animating. */
    private trimToLimit(): void {
        const excess = this.notifications.length - MAX_NOTIFICATIONS;
        if (excess <= 0)
            return;

        const dropped = this.notifications.slice(0, excess);
        for (const notification of dropped) {
            this.clearAutoTimer(notification.id);
            this.clearRemovalTimer(notification.id);
        }

        this.setNotifications(this.notifications.slice(excess));
    }

    private scheduleAutoDismiss(id: string, duration: number): void {
        // duration 0 (or negative) means "permanent until dismissed".
        if (!(duration > 0))
            return;

        const timer = window.setTimeout(() => {
            this.autoTimers.delete(id);
            this.dismiss(id);
        }, duration);

        this.autoTimers.set(id, timer);
    }

    private clearAutoTimer(id: string): void {
        const timer = this.autoTimers.get(id);
        if (timer === undefined)
            return;

        window.clearTimeout(timer);
        this.autoTimers.delete(id);
    }

    private clearRemovalTimer(id: string): void {
        const timer = this.removalTimers.get(id);
        if (timer === undefined)
            return;

        window.clearTimeout(timer);
        this.removalTimers.delete(id);
    }

    /** Replaces the snapshot and notifies every subscriber. */
    private setNotifications(notifications: readonly TacPhoneNotification[]): void {
        this.notifications = notifications;

        for (const listener of this.listeners) {
            try {
                listener(notifications);
            } catch (error) {
                console.error(`TacPhone notification listener failed: ${errorMessage(error)}`, error);
            }
        }
    }

    /** Default icon of an app: the resolved icon of its first panel. */
    private defaultIcon(app: string | undefined): string | undefined {
        if (!app)
            return undefined;

        try {
            return appDirectory.appIcon(app);
        } catch (error) {
            console.warn(`TacPhone failed to resolve the icon of app "${app}":`, error);
            return undefined;
        }
    }
}

/** The one notification stack of this page. */
export const notificationCenter: NotificationCenterApi = new NotificationCenter();
