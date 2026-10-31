/**
 * Messenger notifications.
 *
 * A notification is raised for every *new* message from somebody else, unless
 * the user can already see it: the Messenger panel is visible and focused, the
 * document is visible, and the message's room is the active room. The plan
 * defines the suppression with "only when" (all three together), so a message
 * that arrives in a background room still notifies while the panel is open.
 *
 * Room invites are ordinary messages carrying a
 * {@link CHAT_OBJECT_KIND_ROOM_INVITE} object; they notify with an invite title.
 *
 * Everything here is idempotent: `init()` in `main.tsx` may run twice under
 * StrictMode and only one subscription is created.
 */

import type { NotificationOptions } from '@ace-tacphone/api';

import type { ChatMessage, ChatRoomSummary, MessengerApi } from './api';
import { MESSAGING_APP_NAME, MESSAGING_PANEL_ID, MESSENGER_SERVICE } from './api';
import type { ChatStoreState } from './state/ChatStore';
import { chatStore } from './state/ChatStore';
import type { RoomInviteObjectData } from './protocol';
import {
    findRoomInvite,
    messagePreview,
    roomDisplayName,
} from './state/roomUtils';

let unsubscribe: (() => void) | undefined;

/**
 * Starts forwarding new messages to the host notification stack.
 *
 * Returns the unsubscribe function. Repeated calls return the same subscription.
 */
export function installMessengerNotifications(): () => void {
    if (unsubscribe) return unsubscribe;

    const stop = chatStore.onEvent(event => {
        if (event.type !== 'message' || !event.isNew) return;

        maybeNotify(event.message, event.room);
    });

    unsubscribe = () => {
        stop();
        unsubscribe = undefined;
    };

    return unsubscribe;
}

/**
 * True when showing a notification would only duplicate what the user sees.
 *
 * All three conditions must hold; see the module comment.
 */
export function shouldSuppressMessageNotification(
    state: ChatStoreState,
    message: ChatMessage,
): boolean {
    if (state.self !== undefined && message.senderUid === state.self.uid) return true;
    if (state.activeRoomId !== message.roomId) return false;
    if (!state.panel.visible || !state.panel.active) return false;
    if (!isDocumentVisible()) return false;

    return true;
}

function isDocumentVisible(): boolean {
    if (typeof document === 'undefined') return true;

    return document.visibilityState === 'visible';
}

function maybeNotify(message: ChatMessage, room: ChatRoomSummary | undefined): void {
    // Group membership notices are not user messages.
    if (message.system === true) return;

    const state = chatStore.getSnapshot();
    if (shouldSuppressMessageNotification(state, message)) return;

    const notifications = typeof window === 'undefined' ? undefined : window.TacPhone?.notifications;
    if (!notifications) return;

    const invite = findRoomInvite(message);
    const options: NotificationOptions = invite
        ? inviteOptions(message, invite)
        : messageOptions(message, room, state);

    try {
        notifications.show(options);
    } catch (error) {
        console.warn('Messaging: failed to show a notification:', error);
    }
}

function messageOptions(
    message: ChatMessage,
    room: ChatRoomSummary | undefined,
    state: ChatStoreState,
): NotificationOptions {
    const preview = messagePreview(message);
    const isDirect = room?.kind === 'direct';
    const title = isDirect
        ? message.senderName
        : roomDisplayName(room, state.self?.uid) || message.senderName;
    const body = isDirect ? preview : `${message.senderName}: ${preview}`;

    return {
        title,
        body,
        app: MESSAGING_APP_NAME,
        sound: 'message',
        data: { kind: 'message', roomId: message.roomId, messageId: message.id },
        action: () => openMessengerRoom(message.roomId),
    };
}

function inviteOptions(message: ChatMessage, invite: RoomInviteObjectData): NotificationOptions {
    const roomName = invite.roomName.trim() || 'a room';

    return {
        title: `Invite to ${roomName}`,
        body: `${message.senderName} invited you to ${roomName}`,
        app: MESSAGING_APP_NAME,
        sound: 'message',
        data: {
            kind: 'invite',
            roomId: invite.roomId,
            inviteKey: invite.inviteKey,
            messageId: message.id,
        },
        action: () => openMessengerRoom(invite.roomId),
    };
}

/**
 * Brings the Messenger panel to the front and selects one room.
 *
 * Routing goes through `resolveAsync()` because only the selected tab of a
 * tabset is mounted; the panel activates, registers its service, and the room
 * is selected through the inter-app API. The store is the fallback, so the room
 * is already selected when the panel mounts later.
 */
export function openMessengerRoom(roomId: string): void {
    void (async () => {
        try {
            const target = await window.TacPhone.interApp.resolveAsync({
                service: MESSENGER_SERVICE,
                panelId: MESSAGING_PANEL_ID,
                openIfMissing: true,
            });
            const api = target?.api as Partial<MessengerApi> | undefined;

            if (api && typeof api.openRoom === 'function' && api.openRoom(roomId)) return;
        } catch (error) {
            console.warn('Messaging: failed to open the Messenger panel:', error);
        }

        chatStore.setActiveRoom(roomId);
    })();
}
