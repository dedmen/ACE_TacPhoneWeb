/**
 * Debug-only helpers for the Messenger app.
 *
 * Every helper is compiled in only for `debug` builds: `DEBUG_FAKE_PLAYERS_ENABLED`
 * is `import.meta.env.MODE === 'debug'`, which becomes the literal `false` in a
 * release build, so bundlers drop the branch and the fake-player tooling.
 *
 * The game side of each command lives under `#ifdef __A3_DEBUG__` in the messaging
 * add-on (`Messaging.Debug.*`). Release game builds do not compile it, and the
 * request then fails harmlessly because every helper swallows errors.
 *
 * There is no UI here: Task 5 calls these helpers from the debug-only toolbar.
 */

import type { ChatPresence } from './api';
import { MESSAGING_APP_NAME } from './api';
import { chatStore } from './state/ChatStore';

/** True only in `npm run build:debug` / `vite --mode debug` builds. */
export const DEBUG_FAKE_PLAYERS_ENABLED = import.meta.env.MODE === 'debug';

// Debug builds only: lets the stored test checklist inspect panel/notification
// state without adding a public host API.
if (DEBUG_FAKE_PLAYERS_ENABLED) {
    (window as typeof window & { __messengerStore?: typeof chatStore }).__messengerStore = chatStore;
}

/** Debug commands, matching the `Messaging.Debug.*` SQF command names. */
export const DEBUG_COMMANDS = {
    addFakePlayers: 'Messaging.Debug.AddFakePlayers',
    reset: 'Messaging.Debug.Reset',
    injectMessage: 'Messaging.Debug.InjectMessage',
    groupUnit: 'Messaging.Debug.GroupUnit',
    setAllowEnemyChat: 'Messaging.Debug.SetAllowEnemyChat',
    setPresence: 'Messaging.Debug.SetPresence',
    setLocalDisplayMode: 'Messaging.Debug.SetLocalDisplayMode',
    saveState: 'Messaging.Debug.SaveState',
    loadState: 'Messaging.Debug.LoadState',
    status: 'Messaging.Debug.Status',
} as const;

export type DebugCommand = (typeof DEBUG_COMMANDS)[keyof typeof DEBUG_COMMANDS];

/** Presence values accepted by `Messaging.Debug.SetPresence`. */
export const DEBUG_PRESENCE_VALUES: readonly ChatPresence[] = ['available', 'minimized', 'offline'];

/** Display modes accepted by `Messaging.Debug.SetLocalDisplayMode`. */
export const DEBUG_DISPLAY_MODES = ['HUD', 'DIALOG', 'CLOSED', 'HIDDEN'] as const;

export type DebugDisplayMode = (typeof DEBUG_DISPLAY_MODES)[number];

/** What `Messaging.Debug.Status` reports. */
export interface MessagingDebugStatus {
    ok: boolean;
    /** True when the game was built with `__A3_DEBUG__`. */
    enabled?: boolean;
    error?: string;
}

/**
 * Sends one debug request. Resolves to undefined in release builds and never
 * throws on a failed request; callers are diagnostics, not user flows.
 */
export async function debugRequest<T = unknown>(
    command: DebugCommand,
    payload: Record<string, unknown> = {},
): Promise<T | undefined> {
    if (!DEBUG_FAKE_PLAYERS_ENABLED) return undefined;

    try {
        return await window.TacPhone.networking.Request({
            a: MESSAGING_APP_NAME,
            c: command,
            ...payload,
        }) as unknown as T;
    } catch (error) {
        console.warn(`Messaging: debug request "${command}" failed:`, error);

        return undefined;
    }
}

/** Adds deterministic fake players, groups and rooms for UI testing. */
export function debugAddFakePlayers(count = 8): Promise<unknown> {
    return debugRequest(DEBUG_COMMANDS.addFakePlayers, { count });
}

/** Clears debug players, rooms and injected messages. */
export function debugReset(): Promise<unknown> {
    return debugRequest(DEBUG_COMMANDS.reset);
}

/** Appends a message as a fake sender and pushes it to connected clients. */
export function debugInjectMessage(roomId: string | undefined, content: string): Promise<unknown> {
    return debugRequest(DEBUG_COMMANDS.injectMessage, { roomId, content });
}

/** Toggles the enemy-chat server setting for tests. */
export function debugSetAllowEnemyChat(enabled: boolean): Promise<unknown> {
    return debugRequest(DEBUG_COMMANDS.setAllowEnemyChat, { enabled });
}

/** Forces a presence value for a fake or real player. */
export function debugSetPresence(uid: string, presence: ChatPresence): Promise<unknown> {
    return debugRequest(DEBUG_COMMANDS.setPresence, { uid, presence });
}

/** Simulates a local phone display mode (HUD/DIALOG/CLOSED/HIDDEN). */
export function debugSetLocalDisplayMode(mode: DebugDisplayMode): Promise<unknown> {
    return debugRequest(DEBUG_COMMANDS.setLocalDisplayMode, { mode });
}

/** Exercises the disabled persistence scaffolding. */
export function debugSaveState(): Promise<unknown> {
    return debugRequest(DEBUG_COMMANDS.saveState);
}

/** Exercises the disabled persistence scaffolding. */
export function debugLoadState(): Promise<unknown> {
    return debugRequest(DEBUG_COMMANDS.loadState);
}

/** Reports whether the game was built with `__A3_DEBUG__` support. */
export function debugGetStatus(): Promise<MessagingDebugStatus | undefined> {
    return debugRequest<MessagingDebugStatus>(DEBUG_COMMANDS.status);
}

/**
 * All debug helpers in one object, so the debug toolbar does not depend on
 * individual imports. Unused in release builds.
 */
export const messagingDebug = {
    enabled: DEBUG_FAKE_PLAYERS_ENABLED,
    commands: DEBUG_COMMANDS,
    presenceValues: DEBUG_PRESENCE_VALUES,
    displayModes: DEBUG_DISPLAY_MODES,
    addFakePlayers: debugAddFakePlayers,
    reset: debugReset,
    injectMessage: debugInjectMessage,
    setAllowEnemyChat: debugSetAllowEnemyChat,
    setPresence: debugSetPresence,
    setLocalDisplayMode: debugSetLocalDisplayMode,
    saveState: debugSaveState,
    loadState: debugLoadState,
    status: debugGetStatus,
} as const;
