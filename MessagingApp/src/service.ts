/**
 * The `messenger` inter-app service.
 *
 * Registered by the mounted Messenger panel (see `MessengerApp.tsx`) and reached
 * by other apps through:
 *
 * ```ts
 * const target = await window.TacPhone.interApp.resolveAsync({
 *     service: 'messenger',
 *     panelId: 'Messaging',
 *     openIfMissing: true,
 * });
 * await (target?.api as MessengerApi).shareObject(object);
 * ```
 *
 * All state lives in the module-level `chatStore`, so the API object itself is a
 * module singleton and can be registered repeatedly under StrictMode without
 * resetting anything.
 */

import type { ChatObject, MessengerApi, ShareResult } from './api';
import { MESSENGER_SERVICE, MESSENGER_SERVICE_VERSION } from './api';
import { requestShareTarget } from './dialogBus';
import type { PanelInstance } from '@ace-tacphone/api';
import { chatStore } from './state/ChatStore';

/**
 * Sends objects as a message with empty text.
 *
 * Shared by `shareObject({ roomId })` and the target selector, so both paths
 * produce the same result shape.
 */
export async function sendObjectMessage(roomId: string, objects: ChatObject[]): Promise<ShareResult> {
    const result = await chatStore.sendMessage(roomId, '', objects);

    if (!result.ok) {
        return { ok: false, roomId, error: result.error ?? 'The item could not be sent.' };
    }

    return { ok: true, roomId, message: result.message };
}

/** The service implementation other apps receive. */
export const messengerApi: MessengerApi = {
    getRooms() {
        return chatStore.getRooms();
    },

    getRoom(roomId) {
        return chatStore.getRoom(roomId);
    },

    openRoom(roomId) {
        if (!chatStore.getRoom(roomId)) return false;

        chatStore.setActiveRoom(roomId);

        return true;
    },

    sendMessage(roomId, content, objects) {
        return chatStore.sendMessage(roomId, content, objects);
    },

    async shareObject(object, options) {
        const objects = [object, ...(options?.objects ?? [])];

        // A direct target needs no UI; the calling app gets a synchronous result.
        if (options?.roomId) return sendObjectMessage(options.roomId, objects);

        // Otherwise the panel opens its target selector and settles the promise.
        return requestShareTarget(object, options);
    },

    joinRoom(roomId, inviteKey) {
        return chatStore.joinRoom(roomId, inviteKey);
    },

    registerObjectRenderer(renderer) {
        return chatStore.registerObjectRenderer(renderer);
    },
};

/**
 * Registers the service for one panel instance.
 *
 * Returns the host's unregister function, ready to be returned from a React
 * effect.
 */
export function registerMessengerService(panel: PanelInstance): () => void {
    return window.TacPhone.interApp.register(panel, {
        service: MESSENGER_SERVICE,
        version: MESSENGER_SERVICE_VERSION,
        api: messengerApi,
    });
}
