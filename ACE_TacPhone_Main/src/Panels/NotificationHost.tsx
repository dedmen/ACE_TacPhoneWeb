// Host UI for the notification stack (phone-style banners).
//
// Backend/Notifications.ts owns everything stateful: lifetimes, the cap of five
// entries, the `closing` flag and the removal timer. This file only renders the
// snapshot and turns user gestures into `dismiss()` calls, so it stays a thin
// view and the store can be used without the UI mounted.
//
// The stack is a fixed overlay rendered outside the flexlayout container (see
// App.tsx), so a maximized tab or a floating popup cannot clip it. It sits below
// TargetChooserDialog: when the chooser asks which panel should receive an
// action, that question must win over banner taps.
//
// Dismiss gestures:
// - Desktop (precise pointer): the close button, only shown under
//   `(hover: hover) and (pointer: fine)`.
// - Touch/pen: a horizontal swipe with pointer capture. Past the threshold the
//   card dismisses, otherwise it snaps back.
// - Tapping the card activates it through the `onActivate` prop, so this
//   component needs to know nothing about actions or panels.
//
// Pointer-up at the end of a swipe is not a tap: `swipedRef` swallows the click
// that follows it, and a rubber-band snap-back never counts as a tap either.

import React from "react";
import type { TacPhoneNotification } from "@ace-tacphone/api";
import styles from "./NotificationHost.module.css";

type NotificationHostProps = {
    /** Runs when a card is tapped, before the card is dismissed. */
    onActivate: (notification: TacPhoneNotification) => void;
};

/** Pointer travel below this is still a tap, not a drag; keeps taps honest. */
const DRAG_SLOP_PX = 8;
/** Swipe dismissal threshold: 72 px, or a quarter of the card width if larger. */
const SWIPE_THRESHOLD_PX = 72;
const SWIPE_THRESHOLD_RATIO = 0.25;

// Module scope on purpose: `useSyncExternalStore` resubscribes whenever the
// subscribe function identity changes, so these must not be re-created per render.
function subscribeToNotifications(listener: () => void): () => void {
    return window.TacPhone.notifications.subscribe(listener);
}

function getNotificationsSnapshot(): readonly TacPhoneNotification[] {
    return window.TacPhone.notifications.getSnapshot();
}

type NotificationCardProps = {
    notification: TacPhoneNotification;
    onActivate: (notification: TacPhoneNotification) => void;
};

/**
 * One banner. Keeps its own drag offset so a swipe re-renders a single card.
 *
 * The horizontal offset is exposed to CSS as `--notification-offset` instead of a
 * plain `transform`, so the `.Closing` class can add its own nudge on top of the
 * position the user dragged the card to.
 */
function NotificationCard(props: NotificationCardProps): React.ReactNode {
    const { notification, onActivate } = props;

    const cardRef = React.useRef<HTMLDivElement | null>(null);
    /** Horizontal offset in px while swiping; 0 when idle. */
    const [offset, setOffset] = React.useState(0);
    const [dragging, setDragging] = React.useState(false);
    /** Pointer that owns the gesture in progress; null when not swiping. */
    const pointerRef = React.useRef<number | null>(null);
    const startXRef = React.useRef(0);
    /** True once the pointer travelled past the tap slop. */
    const movedRef = React.useRef(false);
    /** Set when a swipe ended, so the click that follows it is not a tap. */
    const swipedRef = React.useRef(false);

    const handleClick = (): void => {
        if (swipedRef.current) {
            swipedRef.current = false;
            return;
        }

        // A card that is already fading out must not run its action again.
        if (notification.closing)
            return;

        onActivate(notification);
        window.TacPhone.notifications.dismiss(notification.id);
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
        // A new gesture starts clean: the previous swipe's click suppression must
        // never outlive it (a swallowed click also clears the flag itself).
        swipedRef.current = false;

        // Swiping is a touch/pen gesture; a mouse drag would fight text selection.
        if (event.pointerType === "mouse" || notification.closing)
            return;

        pointerRef.current = event.pointerId;
        startXRef.current = event.clientX;
        movedRef.current = false;
        setOffset(0);
        setDragging(true);

        // Capture so the card keeps receiving the gesture even when the finger
        // leaves the card bounds (the stack itself ignores pointer events).
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (pointerRef.current !== event.pointerId)
            return;

        const distance = event.clientX - startXRef.current;
        if (Math.abs(distance) > DRAG_SLOP_PX)
            movedRef.current = true;

        setOffset(distance);
    };

    const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (pointerRef.current !== event.pointerId)
            return;

        pointerRef.current = null;
        setDragging(false);

        if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);

        // Any real drag ends as a swipe, even when it was too short to dismiss:
        // releasing the finger is not a tap on the card.
        if (movedRef.current)
            swipedRef.current = true;

        const width = cardRef.current?.offsetWidth ?? 0;
        const threshold = Math.max(SWIPE_THRESHOLD_PX, width * SWIPE_THRESHOLD_RATIO);
        const distance = event.clientX - startXRef.current;

        if (Math.abs(distance) >= threshold) {
            // Keep the offset: the card fades out where the finger left it.
            window.TacPhone.notifications.dismiss(notification.id);
            return;
        }

        // Too short: snap back, animated by the CSS transition on the card.
        setOffset(0);
    };

    const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (pointerRef.current !== event.pointerId)
            return;

        // The browser took the gesture over (for example to scroll), so drop it.
        pointerRef.current = null;
        movedRef.current = false;
        setDragging(false);
        setOffset(0);
    };

    const handleCloseClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
        // Do not let the close button also activate the card.
        event.stopPropagation();
        window.TacPhone.notifications.dismiss(notification.id);
    };

    /** Keeps the swipe from starting on the close button. */
    const handleClosePointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
    };

    const className = [
        styles.Card,
        dragging ? styles.Dragging : "",
        notification.closing ? styles.Closing : ""
    ]
        .filter(Boolean)
        .join(" ");

    const style: React.CSSProperties & { "--notification-offset": string } = {
        "--notification-offset": `${Math.round(offset)}px`
    };

    return (
        <div
            ref={cardRef}
            className={className}
            style={style}
            role="status"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onClick={handleClick}
        >
            {notification.icon ? (
                <img className={styles.Icon} src={notification.icon} alt="" draggable={false} />
            ) : null}
            <div className={styles.Content}>
                <div className={styles.Title}>{notification.title}</div>
                {notification.body ? <div className={styles.Body}>{notification.body}</div> : null}
            </div>
            <button
                type="button"
                className={styles.Close}
                aria-label="Dismiss notification"
                onPointerDown={handleClosePointerDown}
                onClick={handleCloseClick}
            >
                <span aria-hidden="true">×</span>
            </button>
        </div>
    );
}

/**
 * Fixed notification stack, newest first.
 *
 * Renders nothing while the stack is empty; the store removes a notification
 * after its exit animation, so no extra "is it gone yet" bookkeeping is needed
 * here. Mount it once, outside the layout, and pass an `onActivate` that resolves
 * the notification's action.
 */
export function NotificationHost(props: NotificationHostProps): React.ReactNode {
    const notifications = React.useSyncExternalStore(subscribeToNotifications, getNotificationsSnapshot);

    if (notifications.length === 0)
        return null;

    // The store appends, so the newest notification is the last one.
    return (
        <div className={styles.Host} role="region" aria-label="Notifications" aria-live="polite">
            {notifications.toReversed().map(notification => (
                <NotificationCard
                    key={notification.id}
                    notification={notification}
                    onActivate={props.onActivate}
                />
            ))}
        </div>
    );
}
