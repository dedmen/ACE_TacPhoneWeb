/**
 * Click handling for chat objects.
 *
 * Resolution order (see the app plan):
 * 1. a renderer registered through `MessengerApi.registerObjectRenderer()`;
 * 2. the serialized `action`, routed through `interApp.resolveAsync()`;
 * 3. a deleted `map.marker` keeps its card and offers the stored position.
 *
 * Everything here is defensive: a missing app, a rejected promise or a bad
 * payload turns into a notification, never into a broken panel.
 */

import type { ChatObject, ChatObjectAction } from './api';
import { MESSAGING_APP_NAME } from './api';
import { chatStore } from './state/ChatStore';

/** Chat object kind of a shared map marker. */
export const MARKER_OBJECT_KIND = 'map.marker';

/** Inter-app service of the Map app. */
const MAP_SERVICE = 'map';

/** Panel id of the Map app. */
const MAP_PANEL_ID = 'ACE_TacPhone_Map';

/** Outcome of activating one chat object card. */
export type ObjectActivation =
    | { status: 'ok' }
    | { status: 'deleted-marker' }
    | { status: 'error'; error: string };

type AnyMethod = (...args: unknown[]) => unknown;

/** Shows a Messenger notification; never throws. */
export function notify(title: string, body?: string): void {
    try {
        window.TacPhone.notifications.show({ title, body, app: MESSAGING_APP_NAME });
    } catch (error) {
        console.warn('Messaging: could not show a notification:', error);
    }
}

function describeError(error: unknown): string {
    if (error instanceof Error && error.message !== '') return error.message;

    return String(error);
}

/** Reads a `[x, y]` position out of an object payload. */
export function readObjectPosition(data: unknown): { x: number; y: number } | undefined {
    if (typeof data !== 'object' || data === null) return undefined;

    const position = (data as { position?: unknown }).position;
    if (!Array.isArray(position) || position.length < 2) return undefined;

    const [x, y] = position;
    if (typeof x !== 'number' || typeof y !== 'number') return undefined;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;

    return { x, y };
}

async function callAction(action: ChatObjectAction): Promise<unknown> {
    const info = await window.TacPhone.interApp.resolveAsync({
        service: action.service,
        panelId: action.panelId,
        openIfMissing: true,
        policy: action.policy,
    });

    const api = info?.api as Record<string, unknown> | undefined;
    const method = api?.[action.method];

    if (typeof method !== 'function') {
        throw new Error(`"${action.service}" did not provide ${action.method}().`);
    }

    return (method as AnyMethod).apply(api, action.args ?? []);
}

/**
 * Activates one chat object card.
 *
 * Resolves `deleted-marker` only for `map.marker`, whose `focusMarker()` returns
 * false when the marker no longer exists. The caller keeps the card and offers
 * the last known position.
 */
export async function activateChatObject(object: ChatObject): Promise<ObjectActivation> {
    const renderer = chatStore.getObjectRenderer(object.kind);

    if (renderer?.activate) {
        try {
            await renderer.activate(object.data);

            return { status: 'ok' };
        } catch (error) {
            const message = describeError(error);
            notify('Could not open the item', message);

            return { status: 'error', error: message };
        }
    }

    const action = object.action;
    if (!action || typeof action.service !== 'string' || typeof action.method !== 'string') {
        return { status: 'error', error: 'This item cannot be opened.' };
    }

    try {
        const result = await callAction(action);

        if (result === false && object.kind === MARKER_OBJECT_KIND) {
            return { status: 'deleted-marker' };
        }

        return { status: 'ok' };
    } catch (error) {
        const message = describeError(error);
        notify('Could not open the item', message);

        return { status: 'error', error: message };
    }
}

/**
 * Opens the Map app at the position stored in a `map.marker` object.
 *
 * Used when the marker was deleted but the message remembered where it was.
 */
export async function showLastKnownPosition(object: ChatObject): Promise<boolean> {
    const position = readObjectPosition(object.data);
    if (!position) {
        notify('No stored position', 'This item does not contain a position.');

        return false;
    }

    try {
        const info = await window.TacPhone.interApp.resolveAsync({
            service: MAP_SERVICE,
            panelId: MAP_PANEL_ID,
            openIfMissing: true,
        });

        const api = info?.api as { flyTo?: (options: { x: number; y: number }) => unknown } | undefined;
        if (!api || typeof api.flyTo !== 'function') {
            throw new Error('The Map app is not available.');
        }

        api.flyTo(position);

        return true;
    } catch (error) {
        notify('Could not open the map', describeError(error));

        return false;
    }
}

/** True when the card has something to do when clicked. */
export function isObjectInteractive(object: ChatObject): boolean {
    if (chatStore.getObjectRenderer(object.kind)?.activate) return true;

    return object.action !== undefined;
}
