/**
 * Pure transformations over the room and presence half of the messenger
 * state: room summaries, participant presence and create-request matching.
 *
 * They live outside the store so the room bookkeeping is reviewable on its
 * own. Everything here is side-effect free and works on immutable snapshots.
 */

import type {
    ChatMessage,
    ChatParticipant,
    ChatPresence,
    ChatRoom,
    ChatRoomSummary,
} from '../api';
import type { NewRoomSpec } from '../protocol';
import { effectiveRoomPresence, sortRoomSummaries } from './roomUtils';

/** Builds a room summary for a room (possibly new) with its current message list. */
export function buildRoomSummary(
    room: Omit<ChatRoom, 'messages'>,
    messages: ChatMessage[],
    unreadCount: number,
    selfUid: string | undefined,
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
        presence: effectiveRoomPresence(participants, selfUid),
    };
}

/** Fallback summary for a message that arrives before its `Room.Upsert`. */
export function placeholderRoomSummary(
    message: ChatMessage,
    self: ChatParticipant | undefined,
): ChatRoomSummary {
    const participants: ChatParticipant[] = [];

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

/** Replaces or appends one room summary and re-sorts the list by activity. */
export function upsertRoomSummary(
    rooms: readonly ChatRoomSummary[],
    room: ChatRoomSummary,
): ChatRoomSummary[] {
    const exists = rooms.some(existing => existing.id === room.id);
    const next = exists
        ? rooms.map(existing => (existing.id === room.id ? room : existing))
        : [...rooms, room];

    return sortRoomSummaries(next);
}

/** Applies one presence change to the participants of every room. */
export function applyPresenceToRooms(
    rooms: readonly ChatRoomSummary[],
    uid: string,
    presence: ChatPresence,
    selfUid: string | undefined,
): ChatRoomSummary[] {
    return rooms.map(room => {
        if (!room.participants.some(participant => participant.uid === uid)) return room;

        const participants = room.participants.map(participant =>
            participant.uid === uid ? { ...participant, presence } : participant,
        );

        return {
            ...room,
            participants,
            presence: effectiveRoomPresence(participants, selfUid),
        };
    });
}

/** Applies a fresh roster to the participants of every room (presence only). */
export function applyPlayerListToRooms(
    rooms: readonly ChatRoomSummary[],
    presenceByUid: ReadonlyMap<string, ChatPresence>,
    selfUid: string | undefined,
): ChatRoomSummary[] {
    return rooms.map(room => {
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
}

/** Whether an announced room can be the one a create request asked for. */
export function roomMatchesCreate(
    room: Pick<ChatRoom, 'id' | 'kind' | 'name' | 'participants'>,
    spec: NewRoomSpec,
    selfUid: string | undefined,
): boolean {
    if (room.kind !== spec.kind) return false;

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
