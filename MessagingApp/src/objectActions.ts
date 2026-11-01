/**
 * Click handling for chat objects.
 *
 * Resolution order:
 * 1. the `activate()` callback of the renderer registered by the app that owns
 *    the object kind (for example the Map app for `map.marker`);
 * 2. the serialized `action`, routed through `interApp.resolveAsync()`.
 *
 * Messenger never contains kind-specific routing. Everything here is defensive:
 * a missing app, a rejected promise or a bad payload turns into a notification,
 * never into a broken panel.
 */

import type { ChatObject, ChatObjectAction } from './api';
import { MESSAGING_APP_NAME } from './api';
import { chatStore } from './state/ChatStore';
import { t } from './i18n';

/** Outcome of activating one chat object card. */
export type ObjectActivation =
    | { status: 'ok' }
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
 * The provider's renderer handles its own semantics, including when the target
 * no longer exists. The serialized action is only a fallback for a provider that
 * is not currently mounted.
 */
export async function activateChatObject(object: ChatObject): Promise<ObjectActivation> {
    const renderer = chatStore.getObjectRenderer(object.kind);

    if (renderer?.activate) {
        try {
            await renderer.activate(object.data);

            return { status: 'ok' };
        } catch (error) {
            const message = describeError(error);
            notify(t('STR_ACE_Tacphone_Messenger_Object_OpenFailedTitle'), message);

            return { status: 'error', error: message };
        }
    }

    const action = object.action;
    if (!action || typeof action.service !== 'string' || typeof action.method !== 'string') {
        return { status: 'error', error: t('STR_ACE_Tacphone_Messenger_Object_CannotOpen') };
    }

    try {
        const result = await callAction(action);

        if (result === false) {
            const message = t('STR_ACE_Tacphone_Messenger_Object_Unavailable');
            notify(t('STR_ACE_Tacphone_Messenger_Object_OpenFailedTitle'), message);

            return { status: 'error', error: message };
        }

        return { status: 'ok' };
    } catch (error) {
        const message = describeError(error);
        notify(t('STR_ACE_Tacphone_Messenger_Object_OpenFailedTitle'), message);

        return { status: 'error', error: message };
    }
}

/** True when the card has something to do when clicked. */
export function isObjectInteractive(object: ChatObject): boolean {
    if (chatStore.getObjectRenderer(object.kind)?.activate) return true;

    return object.action !== undefined;
}
