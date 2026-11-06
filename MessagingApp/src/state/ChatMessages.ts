/**
 * Pure transformations over the per-room message lists of the messenger
 * state: sync-chunk merging, optimistic-send reconciliation, failure marking
 * and list pruning.
 *
 * They live outside the store so the message bookkeeping is reviewable on its
 * own. Everything here is side-effect free, keeps lists oldest first and works
 * on immutable snapshots.
 */

import type { ChatMessage, ChatObject, ChatParticipant } from '../api';
import type { ChatMessagesByRoom } from './roomUtils';

/**
 * Merges one `ChatState.Room` chunk into the room's sync buffer.
 * `chunk <= 0` starts the room's list; later chunks append to it.
 */
export function mergeSyncChunk(
    buffered: ChatMessage[] | undefined,
    chunk: number,
    chunkMessages: ChatMessage[],
): ChatMessage[] {
    return chunk <= 0
        ? [...chunkMessages]
        : [...(buffered ?? []), ...chunkMessages];
}

/** Optimistic messages the server has not echoed yet survive the sync. */
export function mergePendingOptimistic(
    synced: ChatMessage[],
    current: ChatMessage[] | undefined,
): ChatMessage[] {
    const pending = (current ?? []).filter(message =>
        message.pending === true &&
        !synced.some(syncedMessage =>
            syncedMessage.clientMessageId !== undefined && syncedMessage.clientMessageId === message.clientMessageId,
        ),
    );

    return pending.length > 0 ? [...synced, ...pending] : synced;
}

/** Keeps the message lists of the rooms that survived the sync. */
export function keepMessagesForRooms(
    messages: ChatMessagesByRoom,
    rooms: readonly { id: string }[],
): ChatMessagesByRoom {
    const kept: ChatMessagesByRoom = {};
    for (const room of rooms) {
        const roomMessages = messages[room.id];
        if (roomMessages) kept[room.id] = roomMessages;
    }
    return kept;
}

/**
 * Applies a `Message.New` payload to one room's list.
 *
 * Returns `null` when the message was already applied (duplicate server id);
 * otherwise the updated list and how the message was reconciled.
 */
export function applyNewMessage(
    current: ChatMessage[] | undefined,
    message: ChatMessage,
    selfUid: string | undefined,
): { messages: ChatMessage[]; echoIndex: number; isNew: boolean; own: boolean } | null {
    const list = current ?? [];
    const own = selfUid !== undefined && message.senderUid === selfUid;

    const echoIndex = message.clientMessageId === undefined
        ? -1
        : list.findIndex(existing =>
            existing.clientMessageId === message.clientMessageId && existing.pending === true,
        );

    let nextMessages: ChatMessage[];
    let isNew = false;

    if (echoIndex !== -1) {
        nextMessages = list.slice();
        nextMessages[echoIndex] = { ...message, pending: false, failed: false };
    } else if (message.id !== '' && list.some(existing => existing.id === message.id && existing.pending !== true)) {
        return null;
    } else {
        nextMessages = [...list, message];
        isNew = true;
    }

    return { messages: nextMessages, echoIndex, isNew, own };
}

/**
 * Marks every optimistic message with this client id as failed.
 * Returns the updated map, or `undefined` when nothing changed.
 */
export function markMessageFailedInRoom(
    messages: ChatMessagesByRoom,
    clientMessageId: string,
): ChatMessagesByRoom | undefined {
    const next: ChatMessagesByRoom = { ...messages };
    let changed = false;

    for (const roomId of Object.keys(next)) {
        const list = next[roomId];
        const index = list.findIndex(message => message.clientMessageId === clientMessageId);
        if (index === -1) continue;

        const updated = list.slice();
        updated[index] = { ...updated[index], pending: false, failed: true };
        next[roomId] = updated;
        changed = true;
    }

    return changed ? next : undefined;
}

/** Builds the optimistic message the panel renders until the server echoes it. */
export function createOptimisticMessage(
    roomId: string,
    clientMessageId: string,
    content: string,
    objects: ChatObject[] | undefined,
    self: ChatParticipant | undefined,
    timestamp: number,
): ChatMessage {
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
        timestamp,
        clientMessageId,
        pending: true,
    };
}
