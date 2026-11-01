/**
 * Helpers for the debug-only `Messaging.Debug.*` commands.
 *
 * The game add-on compiles these commands only with `__A3_DEBUG__`. Every helper
 * first calls `Messaging.Debug.Status` and fails with an actionable message when
 * the running mission was built without debug support.
 *
 * Most debug commands are relayed to the mission server. The page request then
 * answers `{ ok: true, pending: true }`, so the real result is observed through
 * the next game push (usually `PlayerList.State`, `Room.Upsert` or `Message.New`).
 */

import { collectChatState } from './ws-client.mjs';

/** Debug command names, mirroring `MessagingApp/src/debug.ts`. */
export const DEBUG_COMMANDS = {
    addFakePlayers: 'Messaging.Debug.AddFakePlayers',
    reset: 'Messaging.Debug.Reset',
    injectMessage: 'Messaging.Debug.InjectMessage',
    setAllowEnemyChat: 'Messaging.Debug.SetAllowEnemyChat',
    setPresence: 'Messaging.Debug.SetPresence',
    saveState: 'Messaging.Debug.SaveState',
    loadState: 'Messaging.Debug.LoadState',
    status: 'Messaging.Debug.Status',
};

/** Fake UIDs created by `Messaging.Debug.AddFakePlayers`. */
export const FAKE_UIDS = Object.freeze([
    'fake_1',
    'fake_2',
    'fake_3',
    'fake_4',
    'fake_5',
    'fake_6',
    'fake_7',
    'fake_8',
]);

/** Fake groups and their sides, as defined in `fnc_debugAddFakePlayers.sqf`. */
export const FAKE_GROUPS = Object.freeze({
    fake_grp_1: Object.freeze({ id: 'fake_grp_1', name: 'Fake Alpha', side: 'WEST', color: '#4aa3df' }),
    fake_grp_2: Object.freeze({ id: 'fake_grp_2', name: 'Fake Bravo', side: 'WEST', color: '#7ed321' }),
    fake_grp_3: Object.freeze({ id: 'fake_grp_3', name: 'Fake Charlie', side: 'EAST', color: '#d0021b' }),
});

const FAKE_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
const FAKE_PRESENCES = ['available', 'minimized', 'offline'];
const GROUP_DEFS = [
    FAKE_GROUPS.fake_grp_1,
    FAKE_GROUPS.fake_grp_2,
    FAKE_GROUPS.fake_grp_3,
];

/** Deterministic description of every fake player, matching the SQF generator. */
export const FAKE_PLAYERS = Object.freeze(
    Array.from({ length: 8 }, (_, index) => {
        const number = index + 1;
        const group = GROUP_DEFS[index % GROUP_DEFS.length];

        return Object.freeze({
            uid: `fake_${number}`,
            name: `Fake ${FAKE_NAMES[index % FAKE_NAMES.length]} ${number}`,
            side: group.side,
            groupId: group.id,
            groupName: group.name,
            groupColor: group.color,
            presence: FAKE_PRESENCES[index % FAKE_PRESENCES.length],
        });
    }),
);

/** True when a UID belongs to a debug fake player. */
export function isFakeUid(uid) {
    return FAKE_UIDS.includes(uid);
}

/** Fake players on one side, in UID order. */
export function fakePlayersForSide(side) {
    return FAKE_PLAYERS.filter(player => player.side === side);
}

/** A room name that is unique enough to select its `Room.Upsert` push. */
export function uniqueRoomName(prefix = 'T7') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 23);
    const random = Math.floor(Math.random() * 10_000);

    return `${prefix} ${stamp} ${random}`;
}

/** Promise-based delay used only for polling game state. */
export function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Thin wrapper around a connected {@link import('./ws-client.mjs').WsClient}. */
export class FakePlayers {
    constructor(client, options = {}) {
        this.client = client;
        this.timeout = options.timeout ?? 8000;
        this._status = null;
    }

    /**
     * Confirms that the game was built with `__A3_DEBUG__`.
     *
     * `Messaging.Debug.Status` is answered by the local client (not relayed), so
     * its reply is a real response. Release builds do not compile the handler;
     * the command then becomes an unknown relayed command and this check fails.
     */
    async status() {
        if (this._status) {
            return this._status;
        }

        let result;

        try {
            result = await this.client.request(
                DEBUG_COMMANDS.status,
                {},
                { timeout: this.timeout },
            );
        } catch (error) {
            throw new Error(
                'Could not query Messaging.Debug.Status.\n' +
                    `  ${error.message}\n\n` +
                    'The Messenger test suite needs an Arma build compiled with __A3_DEBUG__ and a ' +
                    'running mission with the TacPhone messaging add-on.',
                { cause: error },
            );
        }

        if (!result || result.debug !== true) {
            throw new Error(
                'Messaging.Debug.Status did not report a debug build.\n' +
                    '  The suite needs Arma built with __A3_DEBUG__ (HEMTT/ACE debug build).\n' +
                    `  Response: ${JSON.stringify(result)}\n\n` +
                    'Rebuild the game add-on with __A3_DEBUG__ and restart the mission.',
            );
        }

        this._status = result;
        return result;
    }

    async _debugRequest(command, payload, waitCommand, predicate, timeout = this.timeout) {
        await this.status();

        this.client.clearPushes([waitCommand, 'Error']);

        await this.client.request(command, payload, { timeout });

        const push = await this.client.waitForPush(
            null,
            data => {
                if (data?.c === 'Error' && data.request === command) {
                    return true;
                }

                return data?.c === waitCommand && (!predicate || predicate(data));
            },
            timeout,
        );

        if (push.c === 'Error') {
            throw new Error(`${command} failed: ${push.message || 'unknown game error'}`);
        }

        return push;
    }

    /**
     * Creates the deterministic fake players/groups (`fake_1..fake_8`).
     *
     * The result is observed through the `PlayerList.State` push the command
     * sends. With enemy chat off only fake players on the local player's side
     * appear in that list; scenarios assert their own side-specific subset.
     */
    async addFakePlayers(count = 8) {
        const expectedCount = Math.min(Math.max(count, 1), FAKE_UIDS.length);

        const push = await this._debugRequest(
            DEBUG_COMMANDS.addFakePlayers,
            { count: expectedCount },
            'PlayerList.State',
            data => Array.isArray(data.players),
        );

        return push;
    }

    /** Clears debug players, rooms and messages. */
    async reset() {
        await this.status();

        this.client.clearPushes(['PlayerList.State', 'Error']);
        await this.client.request(DEBUG_COMMANDS.reset, {}, { timeout: this.timeout });

        const push = await this.client.waitForPush(
            null,
            data => {
                if (data?.c === 'Error' && data.request === DEBUG_COMMANDS.reset) {
                    return true;
                }

                return (
                    data?.c === 'PlayerList.State' &&
                    !(data.players || []).some(player => isFakeUid(player.uid))
                );
            },
            this.timeout,
        );

        if (push.c === 'Error') {
            throw new Error(`${DEBUG_COMMANDS.reset} failed: ${push.message}`);
        }

        return push;
    }

    /** Appends a message as a fake sender and returns the stored message. */
    async injectMessage(roomId, content, senderUid) {
        const push = await this._debugRequest(
            DEBUG_COMMANDS.injectMessage,
            { roomId, content, senderUid },
            'Message.New',
            data =>
                data.message?.content === content &&
                (!senderUid || data.message?.senderUid === senderUid),
        );

        return push.message;
    }

    /** Overrides the enemy-chat setting for tests. */
    async setAllowEnemyChat(enabled) {
        const push = await this._debugRequest(
            DEBUG_COMMANDS.setAllowEnemyChat,
            { enabled },
            'PlayerList.State',
            data => data.allowEnemyChat === enabled,
        );

        return push;
    }

    /** Forces a presence value for a fake or real player. */
    async setPresence(uid, presence) {
        await this.status();

        this.client.clearPushes(['PlayerList.State', 'Presence.Changed', 'Error']);
        await this.client.request(
            DEBUG_COMMANDS.setPresence,
            { uid, presence },
            { timeout: this.timeout },
        );

        const push = await this.client.waitForPush(
            null,
            data => {
                if (data?.c === 'Error' && data.request === DEBUG_COMMANDS.setPresence) {
                    return true;
                }

                if (data?.c === 'Presence.Changed') {
                    return data.uid === uid && data.presence === presence;
                }

                return (
                    data?.c === 'PlayerList.State' &&
                    (data.players || []).some(
                        player => player.uid === uid && player.presence === presence,
                    )
                );
            },
            this.timeout,
        );

        if (push.c === 'Error') {
            throw new Error(`${DEBUG_COMMANDS.setPresence} failed: ${push.message}`);
        }

        return push;
    }

    /** Simulates HUD/DIALOG/CLOSED/HIDDEN through the Main debug command. */
    async setLocalDisplayMode(mode) {
        await this.status();

        const command = 'Debug.SetLocalDisplayMode';
        const result = await this.client.request(
            command,
            { mode },
            { timeout: this.timeout, app: 'main' },
        );

        if (!result?.ok) {
            throw new Error(
                `${command} failed for "${mode}": ` +
                    `${result?.error || 'unknown error'}`,
            );
        }

        return result;
    }

    /**
     * Saves the server database to missionProfileNamespace.
     *
     * The page only gets the local relay ack; the server result is not returned
     * by the wire protocol. Subsequent commands are ordered after this one.
     */
    async saveState() {
        await this.status();

        return this.client.request(DEBUG_COMMANDS.saveState, {}, { timeout: this.timeout });
    }

    /**
     * Loads and imports a previously saved state.
     *
     * `Debug.LoadState` pushes `PlayerList.State` after a successful import and
     * an `Error` push when nothing was stored.
     */
    async loadState() {
        await this.status();

        this.client.clearPushes(['PlayerList.State', 'Error']);
        await this.client.request(DEBUG_COMMANDS.loadState, {}, { timeout: this.timeout });

        const push = await this.client.waitForPush(
            null,
            data => {
                if (data?.c === 'Error' && data.request === DEBUG_COMMANDS.loadState) {
                    return true;
                }

                return data?.c === 'PlayerList.State';
            },
            this.timeout,
        );

        if (push.c === 'Error') {
            throw new Error(`${DEBUG_COMMANDS.loadState} failed: ${push.message}`);
        }

        return push;
    }

    /** Requests the roster and returns the `PlayerList.State` push. */
    async getPlayerList() {
        const push = await this._debugRequest(
            'GetPlayerList',
            {},
            'PlayerList.State',
            () => true,
        );

        return push;
    }

    /** Creates a group room with a unique name and returns its room payload. */
    async createGroupRoom(name, playerUids = [], groupIds = []) {
        const push = await this._debugRequest(
            'CreateRoom',
            {
                room: {
                    kind: 'group',
                    name,
                    playerUids,
                    groupIds,
                },
            },
            'Room.Upsert',
            data => data.room?.kind === 'group' && data.room?.name === name,
        );

        return push.room;
    }

    /** Creates (or re-opens) the deterministic direct room with one player. */
    async createDirectRoom(otherUid) {
        const push = await this._debugRequest(
            'CreateRoom',
            {
                room: {
                    kind: 'direct',
                    name: '',
                    playerUids: [otherUid],
                    groupIds: [],
                },
            },
            'Room.Upsert',
            data =>
                data.room?.kind === 'direct' &&
                data.room?.id?.startsWith('dm:') &&
                (data.room.participants || []).some(
                    participant => participant.uid === otherUid,
                ),
        );

        return push.room;
    }

    /** Waits for the next `Room.Upsert` matching a predicate on the room. */
    waitForRoom(predicate, timeout = this.timeout) {
        return this.client.waitForPush(
            'Room.Upsert',
            data => predicate(data.room, data),
            timeout,
        );
    }

    /** Sends a text/object message and returns the server echo (`Message.New`). */
    async sendMessage(roomId, content, objects) {
        const clientMessageId = `t7-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

        const push = await this._debugRequest(
            'SendMessage',
            {
                roomId,
                clientMessageId,
                content,
                ...(objects ? { objects } : {}),
            },
            'Message.New',
            data => data.message?.clientMessageId === clientMessageId,
        );

        return push.message;
    }

    /**
     * Forwards a message to an existing room or a new-room spec.
     *
     * @param {string} sourceRoomId
     * @param {string} messageId
     * @param {{roomId?: string, newRoom?: object, expectedContent?: string}} target
     */
    async forwardMessage(sourceRoomId, messageId, target) {
        if (!target.roomId && !target.newRoom) {
            throw new Error('forwardMessage needs target.roomId or target.newRoom');
        }

        const push = await this._debugRequest(
            'ForwardMessage',
            {
                sourceRoomId,
                messageId,
                ...(target.roomId ? { targetRoomId: target.roomId } : {}),
                ...(target.newRoom ? { newRoom: target.newRoom } : {}),
            },
            'Message.New',
            data => {
                const message = data.message;

                if (!message?.forwarded) {
                    return false;
                }

                if (target.roomId && message.roomId !== target.roomId) {
                    return false;
                }

                if (target.expectedContent !== undefined && message.content !== target.expectedContent) {
                    return false;
                }

                return true;
            },
        );

        return push.message;
    }

    /** Requests a full sync and collects `ChatState.Room` chunks until Done. */
    async sync() {
        this.client.clearPushes(['ChatState.Room', 'ChatState.Done']);
        await this.client.request('RequestChatState', {}, { timeout: this.timeout });

        return collectChatState(this.client, { clearBefore: false, timeout: this.timeout });
    }
}
