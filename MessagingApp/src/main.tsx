import type { AppPanelInfo } from '@ace-tacphone/api';
import { TACPHONE_API_VERSION } from '@ace-tacphone/api';

import { MESSAGING_PANEL_ID, MESSENGER_DISPLAY_NAME } from './api';
import { MessengerApp } from './MessengerApp';
import { installMessengerNotifications } from './notifications';
import type { GameMessage } from './protocol';
import { PUSH_COMMANDS } from './protocol';
import { chatStore } from './state/ChatStore';

/** Version of the host contract this app was built against. */
export const apiVersion = TACPHONE_API_VERSION;

// One registry per app. It is created at module load (the host imports the app
// before delivering any game message) and routes every push into the store, so
// messages are handled even when no Messenger panel is mounted.
const commandRegistry = new window.TacPhone.utils.CommandRegistry();

for (const command of Object.values(PUSH_COMMANDS)) {
    commandRegistry.register(command, payload => {
        chatStore.handleGameMessage(payload as GameMessage);
    });
}

// The host may call `init()` more than once (StrictMode, reloads); the store and
// the notification subscription are both idempotent, and only the first call
// starts the transport handshake.
let initialization: Promise<void> | undefined;

/**
 * App module `init`: starts the Messenger store and its notification bridge.
 *
 * Safe to call repeatedly: the `Hello`/`RequestChatState` handshake runs once per
 * connection, and a reconnect re-runs it through `OnConnectionChange`.
 */
export function init(): Promise<void> {
    if (!initialization) {
        installMessengerNotifications();
        initialization = chatStore.initialize().catch(error => {
            console.error('Messaging: app initialization failed:', error);
        });
    }

    return initialization;
}

export function GetTacPhoneApps(): Array<AppPanelInfo> {
    return [
        {
            id: MESSAGING_PANEL_ID,
            appComponent: MessengerApp,
            GetDefaultTitle() {
                return MESSENGER_DISPLAY_NAME;
            },
            GetTacPhoneIcon() {
                // Simple chat bubble, encoded as a data URL (ascii only).
                return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Cpath fill='%23222222' d='M64 64h384v288H224L128 432v-80H64z'/%3E%3C/svg%3E";
            },
        },
    ];
}

/**
 * Delivers every game -> web push to the store through the command registry.
 * The store handles sync, optimistic reconciliation, presence and errors.
 */
export function OnMessageFromGame(message: object): void {
    commandRegistry.routeMessage(message as { c: string });
}
