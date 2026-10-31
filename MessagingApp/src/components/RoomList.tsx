import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import type { ChatPresence, ChatRoomSummary } from '../api';
import { formatRelativeTime, matchesSearch, ownPreviewPrefix, PRESENCE_LABEL, safeColor } from '../format';
import { messagePreview, roomDisplayName } from '../state/roomUtils';
import { ChatIcon, PlusIcon } from './icons';
import { Avatar, EmptyState, PresenceDot, SearchInput } from './Ui';
import styles from './RoomList.module.css';

interface RoomListProps {
    rooms: readonly ChatRoomSummary[];
    activeRoomId: string | undefined;
    selfUid: string | undefined;
    selfPresence: ChatPresence;
    connected: boolean;
    syncing: boolean;
    /** Extrapolated server time. */
    now: number;
    onSelect(roomId: string): void;
    onCreate(): void;
}

/** Accent colour of a room, taken from the other participants' groups. */
function roomAccent(room: ChatRoomSummary, selfUid: string | undefined): string | undefined {
    const other = room.participants.find(participant => participant.uid !== selfUid);

    return safeColor(other?.groupColor);
}

/** Sidebar: header, search, room rows with unread counts and presence. */
export function RoomList({
    rooms,
    activeRoomId,
    selfUid,
    selfPresence,
    connected,
    syncing,
    now,
    onSelect,
    onCreate,
}: RoomListProps): JSX.Element {
    const [query, setQuery] = useState('');

    const visibleRooms = useMemo(() => rooms.filter(room => {
        const name = roomDisplayName(room, selfUid);
        const participantNames = room.participants.map(participant => participant.name);

        return matchesSearch(query, name, ...participantNames);
    }), [rooms, selfUid, query]);

    const totalUnread = rooms.reduce((sum, room) => sum + room.unreadCount, 0);

    return (
        <div className={styles.list}>
            <header className={styles.header}>
                <div className={styles.heading}>
                    <div className={styles.titleRow}>
                        <span className={styles.title}>Messenger</span>
                        {totalUnread > 0 && <span className={styles.totalUnread}>{totalUnread}</span>}
                    </div>
                    <div className={styles.selfStatus}>
                        <PresenceDot presence={selfPresence} />
                        <span>You: {PRESENCE_LABEL[selfPresence]}</span>
                    </div>
                </div>
                <button
                    type="button"
                    className={styles.newButton}
                    title="New chat"
                    aria-label="New chat"
                    onClick={onCreate}
                >
                    <PlusIcon className={styles.newIcon} />
                </button>
            </header>

            <div className={styles.search}>
                <SearchInput value={query} onChange={setQuery} placeholder="Search rooms" />
            </div>

            <div className={styles.rooms}>
                {visibleRooms.map(room => {
                    const displayName = roomDisplayName(room, selfUid);
                    const accent = roomAccent(room, selfUid);
                    const lastMessage = room.lastMessage;
                    const preview = lastMessage === undefined
                        ? 'No messages yet'
                        : `${ownPreviewPrefix(lastMessage, selfUid) ? 'You: ' : ''}${messagePreview(lastMessage)}`;
                    const unread = room.unreadCount > 0;

                    return (
                        <button
                            key={room.id}
                            type="button"
                            className={styles.row}
                            data-active={room.id === activeRoomId}
                            data-unread={unread}
                            onClick={() => {
                                onSelect(room.id);
                            }}
                        >
                            <Avatar name={displayName || 'Chat'} color={accent} size={34} />
                            <span className={styles.rowBody}>
                                <span className={styles.rowTop}>
                                    <span className={styles.rowName}>{displayName || 'Conversation'}</span>
                                    {lastMessage && (
                                        <span className={styles.rowTime}>
                                            {formatRelativeTime(lastMessage.timestamp, now)}
                                        </span>
                                    )}
                                </span>
                                <span className={styles.rowBottom}>
                                    <span className={styles.rowPreview}>{preview}</span>
                                    {unread && <span className={styles.unread}>{room.unreadCount}</span>}
                                </span>
                            </span>
                            <PresenceDot presence={room.presence} className={styles.rowPresence} />
                        </button>
                    );
                })}

                {visibleRooms.length === 0 && rooms.length > 0 && (
                    <div className={styles.noResults}>No rooms match the search.</div>
                )}

                {rooms.length === 0 && (
                    <div className={styles.empty}>
                        <EmptyState
                            title={connected ? 'No conversations' : syncing ? 'Loading chats' : 'Messenger'}
                            hint={
                                connected
                                    ? 'Start a direct chat or a group room.'
                                    : syncing
                                        ? 'Waiting for the game to send your rooms.'
                                        : 'Not connected to the game yet.'
                            }
                            icon={<ChatIcon />}
                        >
                            {connected ? (
                                <button type="button" className={styles.emptyButton} onClick={onCreate}>
                                    <PlusIcon className={styles.emptyButtonIcon} />
                                    New chat
                                </button>
                            ) : (
                                <span />
                            )}
                        </EmptyState>
                    </div>
                )}
            </div>
        </div>
    );
}
