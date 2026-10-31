/**
 * Bridge between the inter-app service and the panel UI for `shareObject()`.
 *
 * `MessengerApi.shareObject()` is called by another app and must resolve when
 * the user picks a target or cancels, which means it needs a dialog that only
 * the mounted panel can render. The service parks a request here; the panel
 * subscribes, renders the target selector and settles the promise.
 *
 * If the panel unmounts while a request is pending (layout change, tab close),
 * the panel settles it as cancelled so the calling app never hangs.
 */

import type { ChatObject, ShareOptions, ShareResult } from './api';

/** One pending share request. */
export interface PendingShare {
    /** The object that was shared by the other app. */
    object: ChatObject;
    /** Objects sent together with {@link object}; always starts with it. */
    objects: ChatObject[];
    /** Resolves the awaiting `shareObject()` call. */
    resolve(result: ShareResult): void;
}

let pending: PendingShare | undefined;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (error) {
            console.error('Messaging: share request listener failed:', error);
        }
    }
}

/** Subscribes to pending share requests. */
export function subscribeShareRequests(listener: () => void): () => void {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
}

/** The pending share request, or undefined. */
export function getPendingShare(): PendingShare | undefined {
    return pending;
}

/**
 * Asks the panel for a target room.
 *
 * A newer request supersedes a pending one, which resolves as cancelled: only
 * one target selector can be open at a time.
 */
export function requestShareTarget(object: ChatObject, options?: ShareOptions): Promise<ShareResult> {
    if (pending) settleShare({ ok: false, cancelled: true });

    return new Promise<ShareResult>(resolve => {
        pending = {
            object,
            objects: [object, ...(options?.objects ?? [])],
            resolve,
        };
        emit();
    });
}

/** Completes the pending request, if any. */
export function settleShare(result: ShareResult): void {
    const request = pending;
    if (!request) return;

    pending = undefined;
    emit();
    request.resolve(result);
}

/** Cancels the pending request; used when the panel unmounts. */
export function cancelShareRequest(): void {
    settleShare({ ok: false, cancelled: true });
}
