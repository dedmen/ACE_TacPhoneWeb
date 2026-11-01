/**
 * Display helpers for the Messenger UI.
 *
 * Timestamps in the protocol are server *mission* seconds, not wall-clock
 * values, so absolute clock times are meaningless. Everything here formats
 * relative to the extrapolated server time kept by the store.
 */

import { useEffect, useReducer } from 'react';

import type { ChatMessage, ChatParticipant, ChatPresence } from './api';
import type { ChatStoreState } from './state/ChatStore';
import type { GroupListEntry, PlayerListEntry } from './protocol';
import { t } from './i18n';

/** What we need from the store snapshot to extrapolate the server clock. */
type ServerClock = Pick<ChatStoreState, 'serverTime' | 'serverTimeReceivedAt'>;

/** Current server mission time in seconds, extrapolated from the last push. */
export function serverNow(clock: ServerClock): number {
    if (clock.serverTime > 0 && clock.serverTimeReceivedAt > 0) {
        return clock.serverTime + Math.max(0, Date.now() - clock.serverTimeReceivedAt) / 1000;
    }

    return Date.now() / 1000;
}

/**
 * Extrapolated server time that re-renders every 30 s.
 *
 * Relative labels ("5m") would otherwise freeze until the next store change,
 * which is noticeable in a quiet room.
 */
export function useServerNow(clock: ServerClock): number {
    const [, bump] = useReducer((tick: number) => tick + 1, 0);

    useEffect(() => {
        const timer = window.setInterval(bump, 30000);

        return () => {
            window.clearInterval(timer);
        };
    }, []);

    return serverNow(clock);
}

/** Short relative label: `now`, `5m`, `3h`, `2d`. */
export function formatRelativeTime(timestamp: number, now: number): string {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';

    const delta = Math.max(0, now - timestamp);
    if (delta < 45) return t('str_a3_orange_hub_post_timelinelabel');
    if (delta < 3600) return `${Math.floor(delta / 60)}m`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h`;

    return `${Math.floor(delta / 86400)}d`;
}

/** Mission clock of a timestamp, used as a tooltip. */
export function formatMissionClock(timestamp: number): string {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';

    const total = Math.floor(timestamp);
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    const pad = (value: number): string => String(value).padStart(2, '0');

    return `T+${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export const PRESENCE_LABEL = {
    available: 'str_a3_vr_available',
    minimized: 'STR_ACE_Tacphone_Messenger_Presence_Minimized',
    offline: 'str_disp_xbox_friends_offline',
} as const satisfies Record<ChatPresence, string>;

export const PRESENCE_HINT = {
    available: 'STR_ACE_Tacphone_Messenger_PresenceHint_Available',
    minimized: 'STR_ACE_Tacphone_Messenger_PresenceHint_Minimized',
    offline: 'STR_ACE_Tacphone_Messenger_PresenceHint_Offline',
} as const satisfies Record<ChatPresence, string>;

/** Localized text helper. */
export function presenceText(presence: ChatPresence): string {
    return t(PRESENCE_LABEL[presence]);
}

/** Localized presence explanation. */
export function presenceHintText(presence: ChatPresence): string {
    return t(PRESENCE_HINT[presence]);
}

/** Coerces a game-supplied colour into something `CSS.supports` accepts. */
export function safeColor(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;

    const color = value.trim();
    if (color === '' || color.length > 64) return undefined;

    // Only allow colour literals; a payload must not smuggle `url(...)` in.
    if (!/^[#a-zA-Z0-9(),.%\s-]+$/.test(color)) return undefined;

    if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return undefined;

    return CSS.supports('color', color) ? color : undefined;
}

/** Up to two initials for an avatar circle. */
export function initialsOf(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/** Distinct non-empty group ids among the participants of a room. */
export function distinctGroupIds(participants: readonly ChatParticipant[]): string[] {
    const ids = new Set<string>();

    for (const participant of participants) {
        const id = participant.groupId;
        if (typeof id === 'string' && id.trim() !== '') ids.add(id);
    }

    return [...ids];
}

/** True when sender group names are worth showing on every message. */
export function showsSenderGroups(participants: readonly ChatParticipant[]): boolean {
    return distinctGroupIds(participants).length > 1;
}

/** Accent colour of a message, from its captured group colour or the roster. */
export function messageAccent(
    message: ChatMessage,
    participants: readonly ChatParticipant[],
): string | undefined {
    const captured = safeColor(message.senderGroupColor);
    if (captured) return captured;

    const participant = participants.find(entry => entry.uid === message.senderUid);

    return safeColor(participant?.groupColor);
}

/** Case-insensitive substring test that treats an empty query as "match all". */
export function matchesSearch(query: string, ...values: Array<string | undefined>): boolean {
    const needle = query.trim().toLowerCase();
    if (needle === '') return true;

    return values.some(value => typeof value === 'string' && value.toLowerCase().includes(needle));
}

/** Players whose name matches the query. */
export function filterPlayers(
    players: readonly PlayerListEntry[],
    query: string,
): PlayerListEntry[] {
    return players.filter(player => matchesSearch(query, player.name));
}

/** Groups matched by group name or by one of their current member names. */
export function filterGroups(
    groups: readonly GroupListEntry[],
    players: readonly PlayerListEntry[],
    query: string,
): GroupListEntry[] {
    const nameByUid = new Map(players.map(player => [player.uid, player.name]));

    return groups.filter(group => {
        const memberNames = group.memberUids.map(uid => nameByUid.get(uid));
        return matchesSearch(query, group.name, ...memberNames);
    });
}

/** Short label of a message body for the room list. */
export function ownPreviewPrefix(message: ChatMessage, selfUid: string | undefined): boolean {
    return selfUid !== undefined && message.senderUid === selfUid;
}
