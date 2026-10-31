/**
 * Internal wire protocol of the Messenger app.
 *
 * These types describe the `{ a: 'Messaging', c: '...', ... }` requests sent to
 * the game and the `{ a: 'Messaging', c: '...', ... }` pushes the game sends
 * back. They are not part of the public inter-app contract; that lives in
 * `api.ts`.
 */

import type {
    ChatMessage,
    ChatObject,
    ChatParticipant,
    ChatPresence,
    ChatRoom,
    ChatRoomKind,
} from './api';

// ---------------------------------------------------------------------------
// Web -> game command names
// ---------------------------------------------------------------------------

export const CMD_HELLO = 'Hello';
export const CMD_REQUEST_CHAT_STATE = 'RequestChatState';
export const CMD_GET_PLAYER_LIST = 'GetPlayerList';
export const CMD_SET_CLIENT_PRESENCE = 'SetClientPresence';
export const CMD_CREATE_ROOM = 'CreateRoom';
export const CMD_ADD_PARTICIPANTS = 'AddParticipants';
export const CMD_REMOVE_PARTICIPANTS = 'RemoveParticipants';
export const CMD_SEND_MESSAGE = 'SendMessage';
export const CMD_FORWARD_MESSAGE = 'ForwardMessage';
export const CMD_INVITE_TO_ROOM = 'InviteToRoom';
export const CMD_JOIN_ROOM = 'JoinRoom';

/** Every command the page may send to the game. */
export const CLIENT_COMMANDS = {
    hello: CMD_HELLO,
    requestChatState: CMD_REQUEST_CHAT_STATE,
    getPlayerList: CMD_GET_PLAYER_LIST,
    setClientPresence: CMD_SET_CLIENT_PRESENCE,
    createRoom: CMD_CREATE_ROOM,
    addParticipants: CMD_ADD_PARTICIPANTS,
    removeParticipants: CMD_REMOVE_PARTICIPANTS,
    sendMessage: CMD_SEND_MESSAGE,
    forwardMessage: CMD_FORWARD_MESSAGE,
    inviteToRoom: CMD_INVITE_TO_ROOM,
    joinRoom: CMD_JOIN_ROOM,
} as const;

export type ClientCommand = (typeof CLIENT_COMMANDS)[keyof typeof CLIENT_COMMANDS];

// ---------------------------------------------------------------------------
// Game -> web push names
// ---------------------------------------------------------------------------

export const CMD_CHAT_STATE_ROOM = 'ChatState.Room';
export const CMD_CHAT_STATE_DONE = 'ChatState.Done';
export const CMD_ROOM_UPSERT = 'Room.Upsert';
export const CMD_MESSAGE_NEW = 'Message.New';
export const CMD_PRESENCE_CHANGED = 'Presence.Changed';
export const CMD_PLAYER_LIST_STATE = 'PlayerList.State';
export const CMD_ERROR = 'Error';
/** Debug-only room snapshot used by the stored test suite. */
export const CMD_DEBUG_ROOM_INFO = 'Debug.RoomInfo';
/** Debug-only RemoteAccess bridge result used by the stored test suite. */
export const CMD_DEBUG_REMOTE_ACCESS = 'Debug.RemoteAccess';

/** Every push the game may send to the page. */
export const PUSH_COMMANDS = {
    chatStateRoom: CMD_CHAT_STATE_ROOM,
    chatStateDone: CMD_CHAT_STATE_DONE,
    roomUpsert: CMD_ROOM_UPSERT,
    messageNew: CMD_MESSAGE_NEW,
    presenceChanged: CMD_PRESENCE_CHANGED,
    playerListState: CMD_PLAYER_LIST_STATE,
    error: CMD_ERROR,
    debugRoomInfo: CMD_DEBUG_ROOM_INFO,
    debugRemoteAccess: CMD_DEBUG_REMOTE_ACCESS,
} as const;

export type PushCommand = (typeof PUSH_COMMANDS)[keyof typeof PUSH_COMMANDS];

// ---------------------------------------------------------------------------
// Chat object kinds owned by the messenger itself
// ---------------------------------------------------------------------------

/**
 * `ChatObject.kind` of a room invite. The message carries the room identity and
 * the join key in `ChatObject.data`; clicking the card sends `JoinRoom`.
 */
export const CHAT_OBJECT_KIND_ROOM_INVITE = 'messaging.room_invite';

/** Payload of a {@link CHAT_OBJECT_KIND_ROOM_INVITE} chat object. */
export interface RoomInviteObjectData {
    roomId: string;
    roomName: string;
    /** Key required by `JoinRoom`. */
    inviteKey?: string;
    /** Kind of the room the invite points at. */
    kind?: ChatRoomKind;
    /** Display name of the player who sent the invite. */
    inviterName?: string;
}

/** Common shape of every message between the page and the game. */
export interface GameMessage {
    /** Target app; always `Messaging` for this app. */
    a?: string;
    /** Command or push name. */
    c: string;
    [field: string]: unknown;
}

// ---------------------------------------------------------------------------
// Web -> game payloads
// ---------------------------------------------------------------------------

/** A room specification used when a request may create a room. */
export interface NewRoomSpec {
    kind: ChatRoomKind;
    name?: string;
    playerUids: string[];
    groupIds: string[];
}

export interface HelloRequest {
    c: typeof CMD_HELLO;
    /** Page-local client id: `local` in-game, a WebSocket id remotely. */
    clientId?: string;
    /** External page visibility. Ignored for the in-game `local` client. */
    visible: boolean;
}

export interface HelloResponse {
    ok: boolean;
    /** Identity of the local player, including current presence. */
    self: ChatParticipant;
    /** Server mission time in seconds. */
    serverTime: number;
    allowEnemyChat: boolean;
}

export interface RequestChatStateRequest {
    c: typeof CMD_REQUEST_CHAT_STATE;
}

export interface PlayerListEntry {
    uid: string;
    name: string;
    groupId?: string;
    groupName?: string;
    groupColor?: string;
    side?: string;
    presence: ChatPresence;
}

export interface GroupListEntry {
    id: string;
    name: string;
    color?: string;
    side?: string;
    /** Current human members of the group. */
    memberUids: string[];
}

export interface GetPlayerListResponse {
    ok: boolean;
    players: PlayerListEntry[];
    groups: GroupListEntry[];
    allowEnemyChat: boolean;
}

export interface SetClientPresenceRequest {
    c: typeof CMD_SET_CLIENT_PRESENCE;
    /** External page visibility; the game derives the local client's presence. */
    visible: boolean;
    clientId?: string;
}

export interface CreateRoomRequest {
    c: typeof CMD_CREATE_ROOM;
    room: NewRoomSpec;
}

export interface AddParticipantsRequest {
    c: typeof CMD_ADD_PARTICIPANTS;
    roomId: string;
    playerUids: string[];
    groupIds: string[];
}

export interface RemoveParticipantsRequest {
    c: typeof CMD_REMOVE_PARTICIPANTS;
    roomId: string;
    playerUids: string[];
}

export interface SendMessageRequest {
    c: typeof CMD_SEND_MESSAGE;
    roomId: string;
    /** Client-generated id used to reconcile the optimistic message. */
    clientMessageId: string;
    content: string;
    objects?: ChatObject[];
}

export interface ForwardMessageRequest {
    c: typeof CMD_FORWARD_MESSAGE;
    sourceRoomId: string;
    messageId: string;
    /** Target room, or a new room specification when null/undefined. */
    targetRoomId?: string;
    newRoom?: NewRoomSpec;
}

export interface InviteToRoomRequest {
    c: typeof CMD_INVITE_TO_ROOM;
    /** Existing room to invite to, or a new room specification. */
    roomId?: string;
    newRoom?: NewRoomSpec;
    playerUids: string[];
    groupIds: string[];
}

export interface JoinRoomRequest {
    c: typeof CMD_JOIN_ROOM;
    roomId: string;
    inviteKey?: string;
}

/** Generic result of a command that has no extra payload. */
export interface CommandResult {
    ok: boolean;
    /** Human-readable reason of a failed command. */
    error?: string;
}

/** Result of a command that may create or resolve a room. */
export interface RoomCommandResult extends CommandResult {
    /** Room the command acted on, or the newly created room. */
    roomId?: string;
    /** Invite key of a room the command created, so it can be shared. */
    inviteKey?: string;
}

/** Result of `SendMessage`; the server echo also arrives as `Message.New`. */
export interface SendMessageResult extends CommandResult {
    roomId?: string;
    /** Echoed client message id used to reconcile the optimistic message. */
    clientMessageId?: string;
    /** Server-assigned message id. */
    messageId?: string;
}

/** Any request the page sends to the game. */
export type MessengerRequest =
    | HelloRequest
    | RequestChatStateRequest
    | SetClientPresenceRequest
    | CreateRoomRequest
    | AddParticipantsRequest
    | RemoveParticipantsRequest
    | SendMessageRequest
    | ForwardMessageRequest
    | InviteToRoomRequest
    | JoinRoomRequest;

// ---------------------------------------------------------------------------
// Game -> web payloads
// ---------------------------------------------------------------------------

/** One room of a chunked chat-state sync. */
export interface ChatStateRoomPush {
    c: typeof CMD_CHAT_STATE_ROOM;
    /** Room record without its messages; see {@link messages}. */
    room: Omit<ChatRoom, 'messages'>;
    /** Messages of this chunk, oldest first. */
    messages: ChatMessage[];
    /** Zero-based chunk index. */
    chunk: number;
    /** Total chunk count for this room. */
    chunks: number;
    /** Server mission time when the push was built. */
    now: number;
}

/** End of a chat-state sync; no more room pushes follow. */
export interface ChatStateDonePush {
    c: typeof CMD_CHAT_STATE_DONE;
    /** Number of rooms that were synced. */
    rooms: number;
    now: number;
}

/** Room metadata or participants changed. */
export interface RoomUpsertPush {
    c: typeof CMD_ROOM_UPSERT;
    room: Omit<ChatRoom, 'messages'>;
    now: number;
    /** True when the local player was removed from the room. */
    removed?: boolean;
}

/** A new message, or the server echo of an optimistic message. */
export interface MessageNewPush {
    c: typeof CMD_MESSAGE_NEW;
    message: ChatMessage;
    now: number;
}

/** Presence of one player changed. */
export interface PresenceChangedPush {
    c: typeof CMD_PRESENCE_CHANGED;
    uid: string;
    presence: ChatPresence;
    now: number;
}

/** Response to `GetPlayerList` and presence/roster refreshes. */
export interface PlayerListStatePush {
    c: typeof CMD_PLAYER_LIST_STATE;
    players: PlayerListEntry[];
    groups: GroupListEntry[];
    allowEnemyChat: boolean;
    now: number;
}

/** A request failed. */
export interface ErrorPush {
    c: typeof CMD_ERROR;
    /** Command that failed, if known. */
    request?: string;
    message: string;
    /** Echoed for `SendMessage`, so the optimistic message can be marked failed. */
    clientMessageId?: string;
    /** Server mission time when the push was built, when the game reports one. */
    now?: number;
}

/** Any push the game sends to the page. */
export type MessengerPush =
    | ChatStateRoomPush
    | ChatStateDonePush
    | RoomUpsertPush
    | MessageNewPush
    | PresenceChangedPush
    | PlayerListStatePush
    | ErrorPush;
