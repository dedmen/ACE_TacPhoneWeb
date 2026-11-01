/**
 * Module-level messenger state.
 *
 * The store deliberately lives outside React so messages, unread counts and
 * notifications keep working while no Messenger panel is mounted. The panel
 * subscribes through `useSyncExternalStore`; every change replaces the state
 * object so React can compare snapshot references.
 *
 * Responsibilities:
 * - merge the chunked `ChatState.*` sync into immutable room/message snapshots;
 * - reconcile optimistic sends through `clientMessageId` (`Message.New` echo);
 * - track player/room presence, unread counts and the active room;
 * - announce page visibility (`SetClientPresence`) on lifecycle changes;
 * - re-`Hello` and re-sync whenever the transport reconnects.
 *
 * `initialize()` is idempotent: StrictMode may call it repeatedly, but only one
 * `Hello`/`RequestChatState` handshake is started here (a reconnect starts a new
 * one on purpose).
 */

import type {
    ChatMessage,
    ChatObject,
    ChatObjectPreview,
    ChatParticipant,
    ChatPresence,
    ChatRoom,
    ChatRoomSummary,
    JoinResult,
    MessengerObjectRenderer,
    SendResult,
} from '../api';
import { MESSAGING_APP_NAME } from '../api';
import type {
    ChatStateDonePush,
    ChatStateRoomPush,
    CommandResult,
    ErrorPush,
    GameMessage,
    GetPlayerListResponse,
    GroupListEntry,
    HelloResponse,
    MessageNewPush,
    NewRoomSpec,
    PlayerListEntry,
    PlayerListStatePush,
    PresenceChangedPush,
    RoomCommandResult,
    RoomUpsertPush,
    SendMessageResult,
} from '../protocol';
import {
    CMD_ADD_PARTICIPANTS,
    CMD_CHAT_STATE_DONE,
    CMD_CHAT_STATE_ROOM,
    CMD_CREATE_ROOM,
    CMD_ERROR,
    CMD_FORWARD_MESSAGE,
    CMD_GET_PLAYER_LIST,
    CMD_HELLO,
    CMD_INVITE_TO_ROOM,
    CMD_JOIN_ROOM,
    CMD_MESSAGE_NEW,
    CMD_PLAYER_LIST_STATE,
    CMD_PRESENCE_CHANGED,
    CMD_REMOVE_PARTICIPANTS,
    CMD_REQUEST_CHAT_STATE,
    CMD_ROOM_UPSERT,
    CMD_SEND_MESSAGE,
    CMD_SET_CLIENT_PRESENCE,
} from '../protocol';
import type { ChatMessagesByRoom } from './roomUtils';
import {
    effectiveRoomPresence,
    sortRoomSummaries,
} from './roomUtils';
import { t } from '../i18n';

export type { ChatMessagesByRoom } from './roomUtils';

/** Whether the Messenger panel is currently mounted, visible and focused. */
export interface ChatPanelState {
    /** At least one Messenger panel is rendered (its tab is selected). */
    visible: boolean;
    /** The Messenger panel or its tabset has focus. */
    active: boolean;
}

/** Everything the panel renders. Treated as immutable by subscribers. */
export interface ChatStoreState {
    /** Room summaries, most recently active first. */
    rooms: ChatRoomSummary[];
    /** Messages per room id, oldest first. */
    messages: ChatMessagesByRoom;
    /** Room selected in the panel, if any. */
    activeRoomId: string | undefined;
    /** Current roster from the game. */
    players: PlayerListEntry[];
    /** Current group list from the game. */
    groups: GroupListEntry[];
    /** Whether the last roster allowed chatting with enemies. */
    allowEnemyChat: boolean;
    /** Identity and presence of the local player, once `Hello` answered. */
    self: ChatParticipant | undefined;
    /** Effective presence of the local player. */
    selfPresence: ChatPresence;
    /** Panel visibility/focus, reported by the UI and used for notifications. */
    panel: ChatPanelState;
    /** True between `Hello` and `ChatState.Done`. */
    syncing: boolean;
    /** True while the page believes the game transport is usable. */
    connected: boolean;
    /** Last error reported by the game or a failed transport request. */
    lastError: string | undefined;
    /** Last server mission time received, in seconds. */
    serverTime: number;
    /** Wall-clock time (`Date.now()`) when {@link serverTime} was received. */
    serverTimeReceivedAt: number;
}

/** Callback invoked with the new state after every change. */
export type ChatStoreListener = (state: ChatStoreState) => void;

/** Side-channel events for code that must not re-render on every state change. */
export type ChatStoreEvent =
    | {
        type: 'message';
        message: ChatMessage;
        room: ChatRoomSummary | undefined;
        /** True when the local player sent the message (from any client). */
        own: boolean;
        /** False for the server echo of an optimistic message. */
        isNew: boolean;
    }
    | { type: 'error'; error: string; request?: string }
    | { type: 'connection'; connected: boolean }
    | { type: 'sync-complete'; rooms: number };

export type ChatStoreEventListener = (event: ChatStoreEvent) => void;

/** Target of `forwardMessage`: an existing room or a new room spec. */
export interface ForwardTarget {
    roomId?: string;
    newRoom?: NewRoomSpec;
}

/** A create request waiting for the room to arrive as a `Room.Upsert` push. */
interface PendingRoomCreate {
    spec: NewRoomSpec;
    /** Rooms that already existed when the request was sent. */
    baseline: ReadonlySet<string>;
    settled: boolean;
    timer: number;
    resolve(result: RoomCommandResult): void;
}

/** Participants of `inviteToRoom` plus the destination room or new room spec. */
export interface InviteOptions {
    roomId?: string;
    newRoom?: NewRoomSpec;
    playerUids?: string[];
    groupIds?: string[];
}

/** Read-only surface other modules (services, notifications, debug) may use. */
export interface ChatStoreApi {
    getSnapshot(): ChatStoreState;
    subscribe(listener: ChatStoreListener): () => void;
    /** Subscribes to message/connection events; returns the unsubscribe function. */
    onEvent(listener: ChatStoreEventListener): () => void;
    /** Starts the transport handshake once; safe to call repeatedly (StrictMode). */
    initialize(): Promise<void>;
    /** Detaches every listener; used by tests and page teardown. */
    dispose(): void;
    /** Drops all state and renderers, keeping listeners attached. */
    reset(): void;

    setActiveRoom(roomId: string | undefined): void;
    markRoomRead(roomId: string): void;
    setPanelState(panel: Partial<ChatPanelState>): void;
    /** Reports page visibility to the game (external WebSocket clients). */
    setClientPresence(visible: boolean): void;

    getRooms(): ChatRoomSummary[];
    getRoom(roomId: string): ChatRoomSummary | undefined;
    getMessages(roomId: string): ChatMessage[];
    getSelf(): ChatParticipant | undefined;
    /** Current server mission time in seconds, extrapolated between pushes. */
    getServerTime(): number;

    requestPlayerList(): Promise<GetPlayerListResponse | undefined>;
    sendMessage(roomId: string, content: string, objects?: ChatObject[]): Promise<SendResult>;
    createRoom(room: NewRoomSpec): Promise<RoomCommandResult>;
    addParticipants(roomId: string, playerUids: string[], groupIds?: string[]): Promise<CommandResult>;
    removeParticipants(roomId: string, playerUids: string[]): Promise<CommandResult>;
    forwardMessage(sourceRoomId: string, messageId: string, target?: ForwardTarget): Promise<RoomCommandResult>;
    inviteToRoom(options: InviteOptions): Promise<RoomCommandResult>;
    joinRoom(roomId: string, inviteKey?: string): Promise<JoinResult>;

    handleGameMessage(message: GameMessage): void;

    registerObjectRenderer(renderer: MessengerObjectRenderer): () => void;
    getObjectRenderer(kind: string): MessengerObjectRenderer | undefined;
    /** Synchronous preview: a renderer returning a promise falls back to `stored`. */
    getObjectPreview(kind: string, data: unknown, stored: ChatObjectPreview | undefined): ChatObjectPreview | undefined;
    /** Awaits asynchronous renderers before falling back to `stored`. */
    resolveObjectPreview(
        kind: string,
        data: unknown,
        stored: ChatObjectPreview | undefined,
    ): Promise<ChatObjectPreview | undefined>;
}

const INITIAL_STATE: ChatStoreState = {
    rooms: [],
    messages: {},
    activeRoomId: undefined,
    players: [],
    groups: [],
    allowEnemyChat: false,
    self: undefined,
    selfPresence: 'offline',
    panel: { visible: false, active: false },
    syncing: false,
    connected: false,
    lastError: undefined,
    serverTime: 0,
    serverTimeReceivedAt: 0,
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createClientMessageId(): string {
    const cryptoApi = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();

    return `cm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function documentVisible(): boolean {
    if (typeof document === 'undefined') return true;

    return document.visibilityState === 'visible';
}

/** The one messenger store of this page. */
class ChatStoreImpl implements ChatStoreApi {
    private state: ChatStoreState = INITIAL_STATE;
    private readonly listeners = new Set<ChatStoreListener>();
    private readonly eventListeners = new Set<ChatStoreEventListener>();
    private readonly renderers = new Map<string, MessengerObjectRenderer>();

    /** Rooms seen by the sync in progress; anything else is dropped on done. */
    private readonly syncedRoomIds = new Set<string>();
    /** Messages accumulated per room while the sync is chunked. */
    private readonly syncBuffers = new Map<string, ChatMessage[]>();
    /** Create requests waiting for their new room to be pushed. */
    private readonly pendingRoomCreates: PendingRoomCreate[] = [];

    private ready: Promise<void> | undefined;
    private disposed = false;
    private handshakeChain: Promise<void> = Promise.resolve();
    private handshakeQueued = false;
    private startCompleted = false;

    private connectionUnsubscribe: (() => void) | undefined;
    private connectionKnown = false;
    private connected = false;

    private lifecycleInstalled = false;
    private clientVisible = documentVisible();
    private presenceAnnounced = false;

    // -- subscriptions ------------------------------------------------------

    getSnapshot(): ChatStoreState {
        return this.state;
    }

    subscribe(listener: ChatStoreListener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    onEvent(listener: ChatStoreEventListener): () => void {
        this.eventListeners.add(listener);

        return () => {
            this.eventListeners.delete(listener);
        };
    }

    // -- lifecycle ----------------------------------------------------------

    initialize(): Promise<void> {
        if (this.disposed) this.disposed = false;
        if (this.ready) return this.ready;

        this.ready = this.start().catch(error => {
            console.error('Messaging: store initialization failed:', error);
        });

        return this.ready;
    }

    dispose(): void {
        if (this.disposed) return;

        this.disposed = true;
        this.connectionUnsubscribe?.();
        this.connectionUnsubscribe = undefined;
        this.removeLifecycleListeners();
        this.ready = undefined;
        this.startCompleted = false;
        this.connectionKnown = false;
        this.connected = false;
        this.cancelPendingRoomCreates();
    }

    private async start(): Promise<void> {
        this.installLifecycleListeners();

        const networking = this.getNetworking();
        if (!networking) {
            this.setState({ connected: false, lastError: t('STR_ACE_Tacphone_Messenger_Error_NetworkingUnavailable') });
            return;
        }

        if (this.connectionUnsubscribe === undefined) {
            this.connectionUnsubscribe = networking.OnConnectionChange(this.handleConnectionChange);
        }

        try {
            await networking.WhenReady();
        } catch (error) {
            this.reportError(errorMessage(error));
            this.setState({ connected: false, syncing: false });
            return;
        }

        if (this.disposed) return;

        this.setConnected(true);
        this.startCompleted = true;
        await this.queueHandshake('initial');
    }

    private readonly handleConnectionChange = (connected: boolean): void => {
        if (this.disposed) return;

        this.setConnected(connected);

        if (!connected) {
            this.setState({ syncing: false });
            return;
        }

        // The first connection is followed by `start()`'s own handshake; later
        // transitions are reconnects and need a full re-`Hello` plus re-sync.
        if (this.startCompleted) void this.queueHandshake('reconnect');
    };

    /** Serializes handshakes so a reconnect during a sync cannot interleave. */
    private queueHandshake(reason: string): Promise<void> {
        if (this.handshakeQueued) return this.handshakeChain;

        this.handshakeQueued = true;
        this.handshakeChain = this.handshakeChain.then(async () => {
            this.handshakeQueued = false;
            await this.performHandshake(reason);
        }).catch(error => {
            this.handshakeQueued = false;
            console.error('Messaging: handshake failed:', error);
            this.setState({ syncing: false });
        });

        return this.handshakeChain;
    }

    private async performHandshake(reason: string): Promise<void> {
        if (this.disposed) return;

        console.debug(`Messaging: handshake (${reason}).`);
        this.setState({ syncing: true, lastError: undefined });

        const hello = await this.request<HelloResponse>({
            c: CMD_HELLO,
            clientId: undefined,
            visible: this.clientVisible,
        });

        if (!hello) {
            this.setState({ syncing: false });
            return;
        }

        const self = hello.self;
        if (self && typeof self.uid === 'string') {
            this.setState({ self, selfPresence: self.presence ?? 'offline' });
        }

        this.touchServerTime(hello.serverTime);
        this.setState({ connected: true, allowEnemyChat: hello.allowEnemyChat === true });

        this.presenceAnnounced = true;
        await this.request({ c: CMD_SET_CLIENT_PRESENCE, visible: this.clientVisible });
        await this.request({ c: CMD_REQUEST_CHAT_STATE });

        // `syncing` stays true until `ChatState.Done`; a game that never answers
        // keeps the panel in its loading state instead of showing half state.
    }

    // -- panel, active room and presence ------------------------------------

    setPanelState(panel: Partial<ChatPanelState>): void {
        const next: ChatPanelState = {
            visible: panel.visible ?? this.state.panel.visible,
            active: panel.active ?? this.state.panel.active,
        };

        if (next.visible === this.state.panel.visible && next.active === this.state.panel.active) return;

        this.setState({ panel: next });
    }

    setActiveRoom(roomId: string | undefined): void {
        // Errors are action-scoped, not room-scoped; a leftover join/send error
        // must not follow the user into another conversation.
        const clearError = this.state.lastError !== undefined ? { lastError: undefined } : undefined;

        if (roomId !== undefined && !this.state.rooms.some(room => room.id === roomId)) {
            // Still select it: the room may arrive with the next sync push.
            this.setState({ activeRoomId: roomId, ...clearError });

            return;
        }

        if (this.state.activeRoomId === roomId) {
            if (roomId !== undefined) this.markRoomRead(roomId);
            if (clearError) this.setState(clearError);

            return;
        }

        this.setState({ activeRoomId: roomId, ...clearError });
        if (roomId !== undefined) this.markRoomRead(roomId);
    }

    markRoomRead(roomId: string): void {
        const room = this.getRoom(roomId);
        if (!room || room.unreadCount === 0) return;

        const rooms = this.state.rooms.map(existing =>
            existing.id === roomId ? { ...existing, unreadCount: 0 } : existing,
        );
        this.setState({ rooms });
    }

    setClientPresence(visible: boolean): void {
        const changed = this.clientVisible !== visible;
        this.clientVisible = visible;

        if (!changed && this.presenceAnnounced) return;

        // Before the handshake the visibility is only recorded; `Hello` and the
        // explicit update in `performHandshake` announce it once connected.
        if (!this.connected) {
            this.presenceAnnounced = false;

            return;
        }

        this.presenceAnnounced = true;
        void this.request({ c: CMD_SET_CLIENT_PRESENCE, visible });
    }

    private installLifecycleListeners(): void {
        if (this.lifecycleInstalled || typeof window === 'undefined') return;

        this.lifecycleInstalled = true;
        window.addEventListener('visibilitychange', this.handleVisibilityChange);
        window.addEventListener('pagehide', this.handlePageHide);
        window.addEventListener('pageshow', this.handlePageShow);
    }

    private removeLifecycleListeners(): void {
        if (!this.lifecycleInstalled || typeof window === 'undefined') return;

        this.lifecycleInstalled = false;
        window.removeEventListener('visibilitychange', this.handleVisibilityChange);
        window.removeEventListener('pagehide', this.handlePageHide);
        window.removeEventListener('pageshow', this.handlePageShow);
    }

    private readonly handleVisibilityChange = (): void => {
        this.setClientPresence(documentVisible());
    };

    private readonly handlePageHide = (): void => {
        this.setClientPresence(false);
    };

    private readonly handlePageShow = (): void => {
        this.setClientPresence(documentVisible());
    };

    // -- selectors ----------------------------------------------------------

    getRooms(): ChatRoomSummary[] {
        return this.state.rooms;
    }

    getRoom(roomId: string): ChatRoomSummary | undefined {
        return this.state.rooms.find(room => room.id === roomId);
    }

    getMessages(roomId: string): ChatMessage[] {
        return this.state.messages[roomId] ?? [];
    }

    getSelf(): ChatParticipant | undefined {
        return this.state.self;
    }

    getServerTime(): number {
        if (!(this.state.serverTime > 0)) return Date.now() / 1000;

        return this.state.serverTime + Math.max(0, Date.now() - this.state.serverTimeReceivedAt) / 1000;
    }

    // -- game pushes --------------------------------------------------------

    handleGameMessage(message: GameMessage): void {
        if (!message || typeof message.c !== 'string') return;

        switch (message.c) {
            case CMD_CHAT_STATE_ROOM:
                this.applyChatStateRoom(message as unknown as ChatStateRoomPush);
                break;
            case CMD_CHAT_STATE_DONE:
                this.applyChatStateDone(message as unknown as ChatStateDonePush);
                break;
            case CMD_ROOM_UPSERT:
                this.applyRoomUpsert(message as unknown as RoomUpsertPush);
                break;
            case CMD_MESSAGE_NEW:
                this.applyMessageNew(message as unknown as MessageNewPush);
                break;
            case CMD_PRESENCE_CHANGED:
                this.applyPresenceChanged(message as unknown as PresenceChangedPush);
                break;
            case CMD_PLAYER_LIST_STATE:
                this.applyPlayerList(message as unknown as PlayerListStatePush);
                break;
            case CMD_ERROR:
                this.applyError(message as unknown as ErrorPush);
                break;
            default:
                console.debug(`Messaging: ignoring push "${message.c}".`);
                break;
        }
    }

    private applyChatStateRoom(push: ChatStateRoomPush): void {
        this.touchServerTime(push.now);

        const roomId = push.room.id;
        const messages = push.chunk <= 0
            ? [...push.messages]
            : [...(this.syncBuffers.get(roomId) ?? []), ...push.messages];

        this.syncBuffers.set(roomId, messages);
        this.syncedRoomIds.add(roomId);

        // Optimistic messages the server has not echoed yet survive the sync.
        const pending = (this.state.messages[roomId] ?? []).filter(message =>
            message.pending === true &&
            !messages.some(synced =>
                synced.clientMessageId !== undefined && synced.clientMessageId === message.clientMessageId,
            ),
        );

        const merged = pending.length > 0 ? [...messages, ...pending] : messages;
        const existing = this.getRoom(roomId);
        const summary = this.buildSummary(push.room, merged, existing?.unreadCount ?? 0);

        this.setState({
            syncing: true,
            messages: { ...this.state.messages, [roomId]: merged },
            rooms: this.upsertRoom(summary),
        });
    }

    private applyChatStateDone(push: ChatStateDonePush): void {
        this.touchServerTime(push.now);

        // The server is authoritative: rooms missing from the sync are gone.
        const rooms = this.state.rooms.filter(room => this.syncedRoomIds.has(room.id));
        const messages: ChatMessagesByRoom = {};
        for (const room of rooms) {
            const roomMessages = this.state.messages[room.id];
            if (roomMessages) messages[room.id] = roomMessages;
        }

        const activeRoomId = this.state.activeRoomId !== undefined && rooms.some(room => room.id === this.state.activeRoomId)
            ? this.state.activeRoomId
            : undefined;

        this.syncedRoomIds.clear();
        this.syncBuffers.clear();

        this.setState({
            syncing: false,
            connected: true,
            rooms: sortRoomSummaries(rooms),
            messages,
            activeRoomId,
            // A successful full sync supersedes any error from an earlier action.
            lastError: undefined,
        });
        this.emit({ type: 'sync-complete', rooms: rooms.length });
    }

    private applyRoomUpsert(push: RoomUpsertPush): void {
        this.touchServerTime(push.now);

        if (push.removed === true) {
            const messages = { ...this.state.messages };
            delete messages[push.room.id];

            this.setState({
                rooms: this.state.rooms.filter(room => room.id !== push.room.id),
                messages,
                activeRoomId: this.state.activeRoomId === push.room.id
                    ? undefined
                    : this.state.activeRoomId,
            });

            return;
        }

        this.resolvePendingRoomCreate(push.room);

        const existing = this.getRoom(push.room.id);
        const messages = this.state.messages[push.room.id] ?? [];
        const summary = this.buildSummary(push.room, messages, existing?.unreadCount ?? 0);

        this.setState({ rooms: this.upsertRoom(summary) });
    }

    private applyMessageNew(push: MessageNewPush): void {
        this.touchServerTime(push.now);

        const message = push.message;
        if (!message || typeof message.roomId !== 'string') return;

        const roomId = message.roomId;
        const current = this.state.messages[roomId] ?? [];
        const selfUid = this.state.self?.uid;
        const own = selfUid !== undefined && message.senderUid === selfUid;

        const echoIndex = message.clientMessageId === undefined
            ? -1
            : current.findIndex(existing =>
                existing.clientMessageId === message.clientMessageId && existing.pending === true,
            );

        let nextMessages: ChatMessage[];
        let isNew = false;

        if (echoIndex !== -1) {
            nextMessages = current.slice();
            nextMessages[echoIndex] = { ...message, pending: false, failed: false };
        } else if (message.id !== '' && current.some(existing => existing.id === message.id && existing.pending !== true)) {
            return;
        } else {
            nextMessages = [...current, message];
            isNew = true;
        }

        const existingRoom = this.getRoom(roomId);
        const previousUnread = existingRoom?.unreadCount ?? 0;
        const unreadCount = isNew && !own && roomId !== this.state.activeRoomId
            ? previousUnread + 1
            : previousUnread;

        const summary = existingRoom
            ? { ...existingRoom, lastMessage: nextMessages[nextMessages.length - 1], unreadCount }
            : { ...this.placeholderSummary(message), unreadCount };

        this.setState({
            messages: { ...this.state.messages, [roomId]: nextMessages },
            rooms: this.upsertRoom(summary),
        });

        this.emit({
            type: 'message',
            message: echoIndex !== -1 ? nextMessages[echoIndex] : message,
            room: this.getRoom(roomId),
            own,
            isNew,
        });
    }

    private applyPresenceChanged(push: PresenceChangedPush): void {
        this.touchServerTime(push.now);

        const { presence } = push;
        const players = this.state.players.map(player =>
            player.uid === push.uid ? { ...player, presence } : player,
        );
        const rooms = this.state.rooms.map(room => {
            if (!room.participants.some(participant => participant.uid === push.uid)) return room;

            const participants = room.participants.map(participant =>
                participant.uid === push.uid ? { ...participant, presence } : participant,
            );

            return {
                ...room,
                participants,
                presence: effectiveRoomPresence(participants, this.state.self?.uid),
            };
        });

        this.setState({
            players,
            rooms,
            selfPresence: this.state.self?.uid === push.uid ? presence : this.state.selfPresence,
        });
    }

    private applyPlayerList(push: PlayerListStatePush): void {
        this.touchServerTime(push.now);

        const presenceByUid = new Map<string, ChatPresence>(
            push.players.map(player => [player.uid, player.presence]),
        );
        const selfUid = this.state.self?.uid;
        const selfEntry = selfUid === undefined
            ? undefined
            : push.players.find(player => player.uid === selfUid);

        const rooms = this.state.rooms.map(room => {
            let changed = false;
            const participants = room.participants.map(participant => {
                const presence = presenceByUid.get(participant.uid);
                if (presence === undefined || presence === participant.presence) return participant;

                changed = true;

                return { ...participant, presence };
            });

            if (!changed) return room;

            return {
                ...room,
                participants,
                presence: effectiveRoomPresence(participants, selfUid),
            };
        });

        this.setState({
            players: push.players,
            groups: push.groups,
            allowEnemyChat: push.allowEnemyChat === true,
            rooms,
            self: selfEntry && this.state.self ? { ...this.state.self, ...selfEntry } : this.state.self,
            selfPresence: selfUid === undefined
                ? this.state.selfPresence
                : presenceByUid.get(selfUid) ?? this.state.selfPresence,
        });
    }

    private applyError(push: ErrorPush): void {
        this.touchServerTime(push.now);

        if (push.clientMessageId !== undefined) this.markMessageFailed(push.clientMessageId);
        if (push.request === CMD_CREATE_ROOM) this.failPendingRoomCreates(push.message);

        const patch: Partial<ChatStoreState> = { lastError: push.message };
        if (push.request === CMD_HELLO || push.request === CMD_REQUEST_CHAT_STATE) patch.syncing = false;

        this.setState(patch);
        this.emit({ type: 'error', error: push.message, request: push.request });
    }

    private markMessageFailed(clientMessageId: string): void {
        const messages: ChatMessagesByRoom = { ...this.state.messages };
        let changed = false;

        for (const roomId of Object.keys(messages)) {
            const list = messages[roomId];
            const index = list.findIndex(message => message.clientMessageId === clientMessageId);
            if (index === -1) continue;

            const next = list.slice();
            next[index] = { ...next[index], pending: false, failed: true };
            messages[roomId] = next;
            changed = true;
        }

        if (changed) this.setState({ messages });
    }

    // -- commands -----------------------------------------------------------

    async requestPlayerList(): Promise<GetPlayerListResponse | undefined> {
        const result = await this.request<GetPlayerListResponse>({ c: CMD_GET_PLAYER_LIST });
        if (!result || result.ok === false) return result;

        // Relayed commands answer `{ ok: true, pending: true }`; the list itself
        // arrives as a `PlayerList.State` push. Applying an empty list here would
        // wipe the push that may already have been handled.
        if (!Array.isArray(result.players) && !Array.isArray(result.groups)) return result;

        this.applyPlayerList({
            c: CMD_PLAYER_LIST_STATE,
            players: result.players ?? [],
            groups: result.groups ?? [],
            allowEnemyChat: result.allowEnemyChat === true,
            now: this.getServerTime(),
        });

        return result;
    }

    async sendMessage(roomId: string, content: string, objects?: ChatObject[]): Promise<SendResult> {
        const text = content ?? '';
        const objectList = objects && objects.length > 0 ? objects : undefined;

        if (text.trim().length === 0 && objectList === undefined) {
            return {
                ok: false,
                roomId,
                clientMessageId: '',
                error: t('STR_ACE_Tacphone_Messenger_Error_EmptyMessage'),
            };
        }

        const clientMessageId = createClientMessageId();
        this.insertOptimistic(this.createOptimisticMessage(roomId, clientMessageId, text, objectList));

        const result = await this.request<SendMessageResult>({
            c: CMD_SEND_MESSAGE,
            roomId,
            clientMessageId,
            content: text,
            objects: objectList,
        });

        if (!result) {
            this.markMessageFailed(clientMessageId);

            return {
                ok: false,
                roomId,
                clientMessageId,
                error: this.state.lastError ?? t('STR_ACE_Tacphone_Messenger_Composer_SendFailed'),
            };
        }

        if (result.ok === false) {
            this.markMessageFailed(clientMessageId);

            return {
                ok: false,
                roomId,
                clientMessageId,
                error: result.error ?? t('STR_ACE_Tacphone_Messenger_Error_MessageRejected'),
            };
        }

        return {
            ok: true,
            roomId,
            clientMessageId,
            message: this.findByClientMessageId(roomId, clientMessageId),
        };
    }

    async createRoom(room: NewRoomSpec): Promise<RoomCommandResult> {
        let settlePromise: (result: RoomCommandResult) => void = () => undefined;
        const promise = new Promise<RoomCommandResult>(resolve => {
            settlePromise = resolve;
        });
        const pending = this.beginPendingRoomCreate(room, settlePromise);

        const result = await this.roomCommand(
            { c: CMD_CREATE_ROOM, room },
            t('STR_ACE_Tacphone_Messenger_CreateRoom_Failed'),
        );

        if (!result.ok) {
            this.settlePendingRoomCreate(pending, result);

            return promise;
        }

        // A game build that answers with the room id directly needs no wait.
        if (typeof result.roomId === 'string' && result.roomId !== '') {
            this.settlePendingRoomCreate(pending, result);

            return promise;
        }

        // Relayed commands answer `{ ok: true, pending: true }`; the room itself
        // arrives as a `Room.Upsert` push. Resolve when that push matches.
        this.matchPendingRoomCreates();

        return promise;
    }

    /** Registers a create request before it is sent, so a synchronous push can match. */
    private beginPendingRoomCreate(
        spec: NewRoomSpec,
        resolvePromise: (result: RoomCommandResult) => void,
    ): PendingRoomCreate {
        const pending: PendingRoomCreate = {
            spec,
            baseline: new Set(this.state.rooms.map(room => room.id)),
            settled: false,
            timer: window.setTimeout(() => {
                this.settlePendingRoomCreate(pending, {
                    ok: false,
                    error: t('STR_ACE_Tacphone_Messenger_Error_RoomNotAnnounced'),
                });
            }, 5000),
            resolve: resolvePromise,
        };

        this.pendingRoomCreates.push(pending);

        return pending;
    }

    /** Completes a pending create, exactly once. */
    private settlePendingRoomCreate(pending: PendingRoomCreate, result: RoomCommandResult): void {
        if (pending.settled) return;

        pending.settled = true;
        window.clearTimeout(pending.timer);

        const index = this.pendingRoomCreates.indexOf(pending);
        if (index !== -1) this.pendingRoomCreates.splice(index, 1);

        pending.resolve(result);
    }

    /** Resolves every pending create that a room push satisfies. */
    private matchPendingRoomCreates(): void {
        for (const pending of [...this.pendingRoomCreates]) {
            const room = this.state.rooms.find(candidate =>
                !pending.baseline.has(candidate.id) && this.roomMatchesCreate(candidate, pending.spec),
            );

            if (room) this.settlePendingRoomCreate(pending, { ok: true, roomId: room.id });
        }
    }

    /** Called from `applyRoomUpsert` while the new room is not yet in the snapshot. */
    private resolvePendingRoomCreate(room: Omit<ChatRoom, 'messages'>): void {
        for (const pending of [...this.pendingRoomCreates]) {
            if (pending.baseline.has(room.id)) continue;
            if (!this.roomMatchesCreate(room, pending.spec)) continue;

            this.settlePendingRoomCreate(pending, { ok: true, roomId: room.id });
        }
    }

    private roomMatchesCreate(
        room: Pick<ChatRoom, 'id' | 'kind' | 'name' | 'participants'>,
        spec: NewRoomSpec,
    ): boolean {
        if (room.kind !== spec.kind) return false;

        const selfUid = this.state.self?.uid;
        const uids = new Set(room.participants.map(participant => participant.uid));

        if (selfUid !== undefined && !uids.has(selfUid)) return false;
        if (spec.kind === 'direct') {
            const other = spec.playerUids.find(uid => uid !== selfUid);
            return other === undefined || uids.has(other);
        }

        // A named room is a strong match; otherwise the baseline already excludes
        // every older room and the first new group room is the right one.
        if (spec.name !== undefined && spec.name !== '' && room.name !== spec.name) return false;

        return true;
    }

    addParticipants(roomId: string, playerUids: string[], groupIds: string[] = []): Promise<CommandResult> {
        return this.command(
            { c: CMD_ADD_PARTICIPANTS, roomId, playerUids, groupIds },
            t('STR_ACE_Tacphone_Messenger_AddParticipants_Failed'),
        );
    }

    removeParticipants(roomId: string, playerUids: string[]): Promise<CommandResult> {
        return this.command(
            { c: CMD_REMOVE_PARTICIPANTS, roomId, playerUids },
            t('STR_ACE_Tacphone_Messenger_Error_RemoveParticipantsFailed'),
        );
    }

    forwardMessage(sourceRoomId: string, messageId: string, target: ForwardTarget = {}): Promise<RoomCommandResult> {
        return this.roomCommand(
            {
                c: CMD_FORWARD_MESSAGE,
                sourceRoomId,
                messageId,
                targetRoomId: target.roomId,
                newRoom: target.newRoom,
            },
            t('STR_ACE_Tacphone_Messenger_Target_ForwardFailed'),
        );
    }

    inviteToRoom(options: InviteOptions): Promise<RoomCommandResult> {
        return this.roomCommand(
            {
                c: CMD_INVITE_TO_ROOM,
                roomId: options.roomId,
                newRoom: options.newRoom,
                playerUids: options.playerUids ?? [],
                groupIds: options.groupIds ?? [],
            },
            t('STR_ACE_Tacphone_Messenger_Target_InviteFailed'),
        );
    }

    async joinRoom(roomId: string, inviteKey?: string): Promise<JoinResult> {
        const result = await this.request<RoomCommandResult>({
            c: CMD_JOIN_ROOM,
            roomId,
            inviteKey,
        });

        if (!result) {
            return { ok: false, roomId, error: this.state.lastError ?? t('STR_ACE_Tacphone_Messenger_Invite_JoinFailed') };
        }

        if (result.ok === false) {
            return { ok: false, roomId, error: result.error ?? t('STR_ACE_Tacphone_Messenger_Invite_JoinFailed') };
        }

        return { ok: true, roomId: result.roomId ?? roomId };
    }

    private async command(payload: object, fallback: string): Promise<CommandResult> {
        const result = await this.request<CommandResult>(payload);
        if (!result) return { ok: false, error: this.state.lastError ?? fallback };
        if (result.ok === false) return { ok: false, error: result.error ?? fallback };

        return { ok: true };
    }

    private async roomCommand(payload: object, fallback: string): Promise<RoomCommandResult> {
        const result = await this.request<RoomCommandResult>(payload);
        if (!result) return { ok: false, error: this.state.lastError ?? fallback };
        if (result.ok === false) return { ok: false, error: result.error ?? fallback };

        return { ok: true, roomId: result.roomId, inviteKey: result.inviteKey };
    }

    // -- chat objects -------------------------------------------------------

    registerObjectRenderer(renderer: MessengerObjectRenderer): () => void {
        this.renderers.set(renderer.kind, renderer);

        return () => {
            if (this.renderers.get(renderer.kind) === renderer) this.renderers.delete(renderer.kind);
        };
    }

    getObjectRenderer(kind: string): MessengerObjectRenderer | undefined {
        return this.renderers.get(kind);
    }

    getObjectPreview(
        kind: string,
        data: unknown,
        stored: ChatObjectPreview | undefined,
    ): ChatObjectPreview | undefined {
        const renderer = this.renderers.get(kind);
        if (!renderer) return stored;

        try {
            const preview = renderer.describe(data, stored);
            if (preview instanceof Promise) return stored;

            return preview ?? stored;
        } catch (error) {
            console.warn(`Messaging: object renderer "${kind}" failed:`, error);

            return stored;
        }
    }

    async resolveObjectPreview(
        kind: string,
        data: unknown,
        stored: ChatObjectPreview | undefined,
    ): Promise<ChatObjectPreview | undefined> {
        const renderer = this.renderers.get(kind);
        if (!renderer) return stored;

        try {
            const preview = await renderer.describe(data, stored);

            return preview ?? stored;
        } catch (error) {
            console.warn(`Messaging: object renderer "${kind}" failed:`, error);

            return stored;
        }
    }

    // -- reset --------------------------------------------------------------

    reset(): void {
        this.cancelPendingRoomCreates();
        this.syncedRoomIds.clear();
        this.syncBuffers.clear();
        this.presenceAnnounced = false;
        this.state = INITIAL_STATE;
        this.notifyState();
    }

    private cancelPendingRoomCreates(): void {
        for (const pending of [...this.pendingRoomCreates]) {
            this.settlePendingRoomCreate(pending, {
                ok: false,
                error: t('STR_ACE_Tacphone_Messenger_Error_RoomRequestCancelled'),
            });
        }
    }

    private failPendingRoomCreates(error: string): void {
        for (const pending of [...this.pendingRoomCreates]) {
            this.settlePendingRoomCreate(pending, { ok: false, error });
        }
    }

    // -- internals ----------------------------------------------------------

    private getNetworking(): Window['TacPhone']['networking'] | undefined {
        if (typeof window === 'undefined') return undefined;

        return window.TacPhone?.networking;
    }

    private async request<T = CommandResult>(payload: object): Promise<T | undefined> {
        const networking = this.getNetworking();
        if (!networking) {
            this.reportError(t('STR_ACE_Tacphone_Messenger_Error_NetworkingUnavailable'));

            return undefined;
        }

        try {
            const result = await networking.Request({ a: MESSAGING_APP_NAME, ...payload });

            return result as unknown as T;
        } catch (error) {
            this.reportError(errorMessage(error));

            return undefined;
        }
    }

    private createOptimisticMessage(
        roomId: string,
        clientMessageId: string,
        content: string,
        objects: ChatObject[] | undefined,
    ): ChatMessage {
        const self = this.state.self;

        return {
            id: '',
            roomId,
            senderUid: self?.uid ?? '',
            senderName: self?.name ?? '',
            senderGroupId: self?.groupId,
            senderGroupName: self?.groupName,
            senderGroupColor: self?.groupColor,
            content,
            objects,
            timestamp: this.getServerTime(),
            clientMessageId,
            pending: true,
        };
    }

    private insertOptimistic(message: ChatMessage): void {
        const roomId = message.roomId;
        const messages = [...(this.state.messages[roomId] ?? []), message];
        const existing = this.getRoom(roomId);
        const summary = existing
            ? { ...existing, lastMessage: message }
            : this.placeholderSummary(message);

        this.setState({
            messages: { ...this.state.messages, [roomId]: messages },
            rooms: this.upsertRoom(summary),
        });
    }

    private findByClientMessageId(roomId: string, clientMessageId: string): ChatMessage | undefined {
        return this.getMessages(roomId).find(message => message.clientMessageId === clientMessageId);
    }

    private buildSummary(
        room: Omit<ChatRoom, 'messages'>,
        messages: ChatMessage[],
        unreadCount: number,
    ): ChatRoomSummary {
        const participants = room.participants ?? [];

        return {
            id: room.id,
            kind: room.kind,
            name: room.name ?? '',
            participants,
            createdAt: room.createdAt,
            createdBy: room.createdBy,
            lastMessage: messages.length > 0 ? messages[messages.length - 1] : undefined,
            unreadCount,
            presence: effectiveRoomPresence(participants, this.state.self?.uid),
        };
    }

    /** Fallback summary for a message that arrives before its `Room.Upsert`. */
    private placeholderSummary(message: ChatMessage): ChatRoomSummary {
        const participants: ChatParticipant[] = [];
        const self = this.state.self;

        if (self) participants.push(self);
        if (message.senderUid !== '' && message.senderUid !== self?.uid) {
            participants.push({
                uid: message.senderUid,
                name: message.senderName,
                groupId: message.senderGroupId,
                groupName: message.senderGroupName,
                groupColor: message.senderGroupColor,
                presence: 'offline',
            });
        }

        return {
            id: message.roomId,
            kind: 'group',
            name: '',
            participants,
            createdAt: message.timestamp,
            createdBy: message.senderUid,
            lastMessage: message,
            unreadCount: 0,
            presence: effectiveRoomPresence(participants, self?.uid),
        };
    }

    private upsertRoom(room: ChatRoomSummary): ChatRoomSummary[] {
        const exists = this.state.rooms.some(existing => existing.id === room.id);
        const rooms = exists
            ? this.state.rooms.map(existing => (existing.id === room.id ? room : existing))
            : [...this.state.rooms, room];

        return sortRoomSummaries(rooms);
    }

    private touchServerTime(now: number | undefined): void {
        if (typeof now !== 'number' || !Number.isFinite(now) || now <= 0) return;

        this.setState({ serverTime: now, serverTimeReceivedAt: Date.now() });
    }

    private setConnected(connected: boolean): void {
        if (this.connectionKnown && this.connected === connected) return;

        this.connectionKnown = true;
        this.connected = connected;
        this.setState({ connected });
        this.emit({ type: 'connection', connected });
    }

    private reportError(error: string): void {
        this.setState({ lastError: error });
        this.emit({ type: 'error', error });
    }

    private setState(patch: Partial<ChatStoreState>): void {
        this.state = { ...this.state, ...patch };
        this.notifyState();
    }

    private notifyState(): void {
        for (const listener of this.listeners) {
            try {
                listener(this.state);
            } catch (error) {
                console.error('Messaging: store listener failed:', error);
            }
        }
    }

    private emit(event: ChatStoreEvent): void {
        for (const listener of this.eventListeners) {
            try {
                listener(event);
            } catch (error) {
                console.error('Messaging: store event listener failed:', error);
            }
        }
    }
}

/** The one messenger store of this page. */
export const chatStore: ChatStoreApi = new ChatStoreImpl();
