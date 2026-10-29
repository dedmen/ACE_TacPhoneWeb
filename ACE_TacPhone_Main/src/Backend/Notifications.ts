// Host-side notification stack (phone-style banners).
//
// Apps call `window.Notifications.show()` to raise a notification; the host UI
// (Panels/NotificationHost.tsx) subscribes through `subscribe()` and renders the
// current snapshot. The store is deliberately React-free: it lives in Backend so
// it can be used before the UI mounts, and so the snapshot can be consumed with
// `useSyncExternalStore`.
//
// Tap actions are resolved by the host, not here: the store only carries the
// sender-provided `action` on the stored notification. The action is always a
// page-local function; notifications are not sent from the game.
//
// Timers: every notification may have an auto-dismiss timer (its `duration`),
// and a dismissal starts the exit animation, which is a second, short timer.
// `dismiss()` is idempotent: repeated calls return while the removal timer runs.

/** Runs when a notification is tapped; may be async. */
export type NotificationTapHandler = (
    notification: TacPhoneNotification
) => void | Promise<void>;

/** The tap action of a notification. */
export type NotificationAction = NotificationTapHandler;

/** Options accepted by NotificationCenter.show(). */
export interface NotificationOptions {
    title: string;
    body?: string;
    /** App name, used to resolve the default app icon. */
    app?: string;
    /** Explicit icon URL; overrides the app icon. */
    icon?: string;
    /** Milliseconds; 0 = permanent until dismissed. Default 15000. */
    duration?: number;
    /** Arbitrary payload available to the tap handler on the stored notification. */
    data?: unknown;
    /** Runs when the notification is tapped. */
    action?: NotificationAction;
}

/** Stored notification; what subscribers render. */
export interface TacPhoneNotification extends NotificationOptions {
    id: string;
    createdAt: number;
    /** True while the exit animation runs; the store removes it afterwards. */
    closing?: boolean;
}

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

    /** Default icon of an app: the first panel's GetTacPhoneIcon(). */
    private defaultIcon(app: string | undefined): string | undefined {
        if (!app)
            return undefined;

        try {
            const icon = window.AppDirectory?.knownApps?.get(app)?.panels?.[0]?.GetTacPhoneIcon();
            return typeof icon === "string" && icon.length > 0 ? icon : undefined;
        } catch (error) {
            console.warn(`TacPhone failed to resolve the icon of app "${app}":`, error);
            return undefined;
        }
    }
}

declare global {
    interface Window {
        // Host notification stack; see Backend/Notifications.ts.
        Notifications: NotificationCenter;
    }
}

window.Notifications = new NotificationCenter();
