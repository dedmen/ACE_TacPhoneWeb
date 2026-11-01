/**
 * Pure helpers over room and message records.
 *
 * They live outside the store so the panel, the notification code and the debug
 * helpers render the same titles, previews and presence without duplicating
 * rules. Everything here is side-effect free and works on immutable snapshots.
 */

import type {
    ChatMessage,
    ChatParticipant,
    ChatPresence,
    ChatRoomSummary,
} from '../api';
import type { RoomInviteObjectData } from '../protocol';
import { CHAT_OBJECT_KIND_ROOM_INVITE } from '../protocol';
import { t } from '../i18n';

/** One message list per room, oldest first. */
export type ChatMessagesByRoom = Record<string, ChatMessage[]>;

/** Sort key of a room: last message time, otherwise creation time. */
function roomActivity(room: ChatRoomSummary): number {
    return room.lastMessage?.timestamp ?? room.createdAt;
}

/**
 * Returns a new array sorted by activity, newest first.
 *
 * The input array is never mutated: store snapshots are immutable, and
 * `useSyncExternalStore` compares references.
 */
export function sortRoomSummaries(rooms: readonly ChatRoomSummary[]): ChatRoomSummary[] {
    return [...rooms].sort((left, right) => {
        const delta = roomActivity(right) - roomActivity(left);
        if (delta !== 0) return delta;

        return left.id.localeCompare(right.id);
    });
}

/** Presence of everybody but the local player. */
export function effectiveRoomPresence(
    participants: readonly ChatParticipant[],
    selfUid: string | undefined,
): ChatPresence | undefined {
    const others = selfUid === undefined
        ? participants
        : participants.filter(participant => participant.uid !== selfUid);

    if (others.length === 0) return undefined;
    if (others.some(participant => participant.presence === 'available')) return 'available';
    if (others.some(participant => participant.presence === 'minimized')) return 'minimized';

    return 'offline';
}

/** Title shown in the room list and the chat header. */
export function roomDisplayName(room: ChatRoomSummary | undefined, selfUid: string | undefined): string {
    if (!room) return '';

    const name = room.name.trim();
    if (name) return name;

    const others = selfUid === undefined
        ? room.participants
        : room.participants.filter(participant => participant.uid !== selfUid);

    if (others.length > 0) return others.map(participant => participant.name).join(', ');

    return room.kind === 'direct'
        ? t('STR_ACE_Tacphone_Messenger_Room_Direct')
        : t('STR_ACE_Tacphone_Messenger_Room_Group');
}

/** Short body used by notifications and the room list. */
export function messagePreview(message: ChatMessage): string {
    const content = message.content.trim();
    if (content) return content;

    const preview = message.objects?.find(object => object.preview !== undefined)?.preview;
    if (preview) return preview.subtitle ? `${preview.title} - ${preview.subtitle}` : preview.title;

    const count = message.objects?.length ?? 0;
    if (count === 1) return t('STR_ACE_Tacphone_Messenger_Room_SharedItem_One');
    if (count > 1) return t('STR_ACE_Tacphone_Messenger_Room_SharedItem_Other', count);

    return t('STR_ACE_Tacphone_Messenger_Room_EmptyMessage');
}

/** Finds the room invite carried by a message, if any. */
export function findRoomInvite(message: ChatMessage): RoomInviteObjectData | undefined {
    for (const object of message.objects ?? []) {
        if (object.kind !== CHAT_OBJECT_KIND_ROOM_INVITE) continue;

        const data = object.data;
        if (typeof data !== 'object' || data === null) continue;

        const invite = data as Partial<RoomInviteObjectData>;
        if (typeof invite.roomId !== 'string' || invite.roomId.length === 0) continue;

        return {
            roomId: invite.roomId,
            roomName: typeof invite.roomName === 'string' ? invite.roomName : '',
            inviteKey: typeof invite.inviteKey === 'string' ? invite.inviteKey : undefined,
            kind: invite.kind,
            inviterName: typeof invite.inviterName === 'string' ? invite.inviterName : undefined,
        };
    }

    return undefined;
}
