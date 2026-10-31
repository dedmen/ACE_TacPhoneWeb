/**
 * Public contract of the TacPhone Messenger app.
 *
 * This module is the app's inter-app contract: it is the entry point for
 * `tacphone-build bundle-api-types`, which emits
 * `dist/ace_tacphone_messaging.d.ts` (declared as the package `types`). Keep it
 * free of imports so the generated declaration stays self-contained.
 *
 * Other apps reach the implementation through the host registry:
 *
 * ```ts
 * const messenger = await window.TacPhone.interApp.resolveAsync({
 *     service: MESSENGER_SERVICE,
 *     panelId: MESSAGING_PANEL_ID,
 *     openIfMissing: true,
 * });
 * const api = messenger?.api as MessengerApi | undefined;
 * await api?.shareObject(object);
 * ```
 */

/** Visible name of the app and its default tab title. */
export const MESSENGER_DISPLAY_NAME = 'Messenger';

/** Routing key: `ace_tacphone_apps` class and the `a` field of every request. */
export const MESSAGING_APP_NAME = 'Messaging';

/** Panel id, persisted in saved layouts. Must stay stable after release. */
export const MESSAGING_PANEL_ID = 'Messaging';

/** Service name registered by the Messenger panel. */
export const MESSENGER_SERVICE = 'messenger';

/** Major version of {@link MessengerApi}. */
export const MESSENGER_SERVICE_VERSION = 1;

/** Whether a player can currently see their phone. */
export type ChatPresence = 'available' | 'minimized' | 'offline';

/** Direct rooms are one-to-one; group rooms support participants and invites. */
export type ChatRoomKind = 'direct' | 'group';

/** One participant of a room, as known by the server at sync time. */
export interface ChatParticipant {
    /** Player UID. */
    uid: string;
    /** Player name. */
    name: string;
    groupId?: string;
    groupName?: string;
    /** Group colour, when the game can report one. */
    groupColor?: string;
    /** Player side name, used for side filtering. */
    side?: string;
    presence: ChatPresence;
    /** True for the player who created the room. */
    creator?: boolean;
    /** True when this player's whole in-game group was invited to the room. */
    groupInvited?: boolean;
}

/** Persisted display snapshot of a chat object, rendered without the sender app. */
export interface ChatObjectPreview {
    title: string;
    subtitle?: string;
    /** Game texture path or data URL. */
    icon?: string;
    color?: string;
}

/** Generic click action of a chat object, routed through the host. */
export interface ChatObjectAction {
    /** Inter-app service name, for example `map`. */
    service: string;
    /** Panel id to route to, for example `ACE_TacPhone_Map`. */
    panelId?: string;
    /** Method name on the target service, for example `focusMarker`. */
    method: string;
    /** Arguments passed to the method. */
    args?: unknown[];
    /** Optional target policy; `ask` lets the host pick between several panels. */
    policy?: 'auto' | 'focused' | 'largest' | 'first' | 'ask';
}

/**
 * Serializable object carried by a message, produced by another app.
 *
 * `data` is app-defined JSON; `preview` and `action` make it renderable and
 * clickable after a reconnect without the sending app being mounted.
 */
export interface ChatObject {
    /** Object kind, for example `map.marker`, `document.page`, `camera.photo`. */
    kind: string;
    /** Payload schema version for {@link kind}. */
    version: number;
    data: unknown;
    preview?: ChatObjectPreview;
    action?: ChatObjectAction;
}

/** Origin of a forwarded message, shown above the forwarded content. */
export interface ChatForwardedInfo {
    roomId: string;
    roomName: string;
    senderUid: string;
    senderName: string;
    senderGroupName?: string;
    timestamp: number;
}

/** One chat message. */
export interface ChatMessage {
    /** Server-assigned message id. Empty or provisional while pending. */
    id: string;
    roomId: string;
    senderUid: string;
    senderName: string;
    /** Sender group captured at send time. */
    senderGroupId?: string;
    senderGroupName?: string;
    senderGroupColor?: string;
    content: string;
    objects?: ChatObject[];
    /** Server mission time in seconds, comparable with the `now` field of pushes. */
    timestamp: number;
    /** Client id used to reconcile an optimistic message with the server echo. */
    clientMessageId?: string;
    /** True while the optimistic message has not been acknowledged. */
    pending?: boolean;
    /** True when the server rejected the optimistic message. */
    failed?: boolean;
    /** System notice, for example a group membership change. */
    system?: boolean;
    forwarded?: ChatForwardedInfo;
}

/** Full room record, including its messages. */
export interface ChatRoom {
    id: string;
    kind: ChatRoomKind;
    /** May be empty for direct rooms; the UI derives a title from participants. */
    name: string;
    participants: ChatParticipant[];
    createdAt: number;
    createdBy: string;
    messages: ChatMessage[];
}

/** Lightweight room view used by the room list and by other apps. */
export interface ChatRoomSummary {
    id: string;
    kind: ChatRoomKind;
    name: string;
    participants: ChatParticipant[];
    createdAt: number;
    createdBy: string;
    lastMessage?: ChatMessage;
    /** Unread message count for the local player. */
    unreadCount: number;
    /** Effective presence of the other participants, if meaningful. */
    presence?: ChatPresence;
}

/** Result of {@link MessengerApi.sendMessage}. */
export interface SendResult {
    ok: boolean;
    roomId: string;
    /** Local id of the optimistic message, for matching the server echo. */
    clientMessageId: string;
    message?: ChatMessage;
    error?: string;
}

/** Options of {@link MessengerApi.shareObject}. */
export interface ShareOptions {
    /** Send directly to this room instead of opening the target selector. */
    roomId?: string;
    /** Objects sent together with {@link ChatObject}; normally just the shared one. */
    objects?: ChatObject[];
}

/** Result of {@link MessengerApi.shareObject}. */
export interface ShareResult {
    /** False when the user cancelled or nothing was sent. */
    ok: boolean;
    cancelled?: boolean;
    roomId?: string;
    message?: ChatMessage;
    error?: string;
}

/** Result of {@link MessengerApi.joinRoom}. */
export interface JoinResult {
    ok: boolean;
    roomId: string;
    error?: string;
}

/**
 * Renderer registered by another app for one chat object kind.
 *
 * If a renderer is registered, Messenger prefers its `describe()` result over
 * the stored `preview` of the object.
 */
export interface MessengerObjectRenderer {
    /** Object kind this renderer handles, for example `map.marker`. */
    kind: string;
    /** Preview for the card; the stored preview is used when this returns undefined. */
    describe(
        data: unknown,
        storedPreview: ChatObjectPreview | undefined,
    ): ChatObjectPreview | Promise<ChatObjectPreview> | undefined;
    /** Optional click action; when absent the serialized `action` is used. */
    activate?(data: unknown): void | Promise<void>;
}

/** What other apps receive from the Messenger panel. */
export interface MessengerApi {
    /** Every known room, newest message first. */
    getRooms(): ChatRoomSummary[];
    /** One room summary, if it exists. */
    getRoom(roomId: string): ChatRoomSummary | undefined;
    /** Select a room in the panel, opening the app when needed. */
    openRoom(roomId: string): boolean;
    /** Send a text message with optional chat objects. */
    sendMessage(roomId: string, content: string, objects?: ChatObject[]): Promise<SendResult>;
    /**
     * Share an object: opens the target selector and resolves when the user
     * sends or cancels. Pass {@link ShareOptions.roomId} to send directly.
     */
    shareObject(object: ChatObject, options?: ShareOptions): Promise<ShareResult>;
    /** Join a room through an invite message. */
    joinRoom(roomId: string, inviteKey?: string): Promise<JoinResult>;
    /** Register a renderer for one object kind; returns its unregister function. */
    registerObjectRenderer(renderer: MessengerObjectRenderer): () => void;
}
