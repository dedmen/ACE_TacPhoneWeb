import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ChatRoomSummary, SendResult } from '../api';
import { PRESENCE_LABEL, showsSenderGroups } from '../format';
import type { ChatStoreState } from '../state/ChatStore';
import { chatStore } from '../state/ChatStore';
import { roomDisplayName } from '../state/roomUtils';
import { useMessengerUi } from '../ui';
import { Composer } from './Composer';
import { BackIcon, InviteIcon, UserPlusIcon, UsersIcon } from './icons';
import { MessageItem } from './MessageItem';
import { EmptyState, PresenceDot, StatusStrip } from './Ui';
import styles from './ChatView.module.css';

interface ChatViewProps {
    room: ChatRoomSummary;
    state: ChatStoreState;
    /** Extrapolated server time. */
    now: number;
    /** True in the single-pane layout; shows the back button. */
    narrow: boolean;
    onBack(): void;
}

/** Time gap after which a new sender group starts even for the same author. */
const GROUP_GAP_SECONDS = 5 * 60;

/** Selected room: header, message list and composer. */
export function ChatView({ room, state, now, narrow, onBack }: ChatViewProps): JSX.Element {
    const ui = useMessengerUi();
    const listRef = useRef<HTMLDivElement>(null);
    const [dismissedError, setDismissedError] = useState<string | undefined>(undefined);

    const messages = state.messages[room.id] ?? [];
    const selfUid = state.self?.uid;
    const displayName = roomDisplayName(room, selfUid);
    const isParticipant = selfUid !== undefined
        && room.participants.some(participant => participant.uid === selfUid);
    const showGroupNames = showsSenderGroups(room.participants);
    const presence = room.presence;

    const joinedRoomIds = useMemo(() => {
        const ids = new Set<string>();
        for (const known of state.rooms) {
            if (selfUid === undefined) break;
            if (known.participants.some(participant => participant.uid === selfUid)) ids.add(known.id);
        }

        return ids;
    }, [state.rooms, selfUid]);

    // Jump to the newest message when the room changes.
    useEffect(() => {
        const element = listRef.current;
        if (!element) return;

        element.scrollTop = element.scrollHeight;
    }, [room.id]);

    // Follow new messages only when the user is already near the bottom.
    useEffect(() => {
        const element = listRef.current;
        if (!element) return;

        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        if (distance < 140) element.scrollTop = element.scrollHeight;
    }, [messages.length]);

    const send = async (text: string): Promise<{ ok: boolean; error?: string }> => {
        const result: SendResult = await chatStore.sendMessage(room.id, text);

        return { ok: result.ok, error: result.error };
    };

    const error = state.lastError !== undefined && state.lastError !== dismissedError
        ? state.lastError
        : undefined;

    const participantCount = room.participants.length;

    return (
        <section className={styles.view} aria-label="Conversation">
            <header className={styles.header}>
                {narrow && (
                    <button
                        type="button"
                        className={`${styles.iconButton} ${styles.back}`}
                        aria-label="Back to rooms"
                        onClick={onBack}
                    >
                        <BackIcon className={styles.icon} />
                    </button>
                )}

                <div className={styles.heading}>
                    <div className={styles.title} title={displayName}>
                        {displayName}
                    </div>
                    <div className={styles.meta}>
                        {presence && <PresenceDot presence={presence} />}
                        <span>
                            {participantCount} participant{participantCount === 1 ? '' : 's'}
                            {presence ? ` - ${PRESENCE_LABEL[presence]}` : ''}
                        </span>
                    </div>
                </div>

                <div className={styles.actions}>
                    <button
                        type="button"
                        className={styles.iconButton}
                        title="Members"
                        data-tooltip="Show room members"
                        aria-label="Members"
                        onClick={() => {
                            ui.openMembers(room.id);
                        }}
                    >
                        <UsersIcon className={styles.icon} />
                    </button>
                    {(room.kind === 'group' || room.participants.length < 2) && (
                        <button
                            type="button"
                            className={styles.iconButton}
                            title="Invite people"
                            data-tooltip="Invite someone to this room"
                            aria-label="Invite people"
                            onClick={() => {
                                ui.openInvite(room.id);
                            }}
                        >
                            <InviteIcon className={styles.icon} />
                        </button>
                    )}
                    {(room.kind === 'group' || room.participants.length < 2) && (
                        <button
                            type="button"
                            className={styles.iconButton}
                            title="Add participants"
                            data-tooltip="Add players or groups"
                            aria-label="Add participants"
                            onClick={() => {
                                ui.openAddParticipants(room.id);
                            }}
                        >
                            <UserPlusIcon className={styles.icon} />
                        </button>
                    )}
                </div>
            </header>

            {!state.connected && (
                <StatusStrip tone="error">Not connected to the game. Messages are unavailable.</StatusStrip>
            )}
            {state.connected && state.syncing && messages.length === 0 && (
                <StatusStrip>Syncing messages...</StatusStrip>
            )}
            {error && (
                <StatusStrip
                    tone="error"
                    action={(
                        <button
                            type="button"
                            className={styles.dismiss}
                            aria-label="Dismiss"
                            onClick={() => {
                                setDismissedError(state.lastError);
                            }}
                        >
                            x
                        </button>
                    )}
                >
                    {error}
                </StatusStrip>
            )}

            <div className={styles.messages} ref={listRef}>
                {messages.length === 0 ? (
                    <EmptyState
                        title="No messages yet"
                        hint={`Say hello to ${displayName || 'the room'}.`}
                    />
                ) : (
                    messages.map((message, index) => {
                        const previous = index > 0 ? messages[index - 1] : undefined;
                        const showHeader = previous === undefined
                            || previous.senderUid !== message.senderUid
                            || message.timestamp - previous.timestamp > GROUP_GAP_SECONDS;

                        return (
                            <MessageItem
                                key={message.id !== '' ? message.id : message.clientMessageId ?? `local-${index}`}
                                message={message}
                                room={room}
                                selfUid={selfUid}
                                now={now}
                                showGroupNames={showGroupNames}
                                showHeader={showHeader}
                                joinedRoomIds={joinedRoomIds}
                            />
                        );
                    })
                )}
            </div>

            <Composer
                disabled={!state.connected || !isParticipant}
                disabledReason={
                    !state.connected
                        ? 'Not connected to the game'
                        : 'You are not a participant of this room'
                }
                onSend={send}
            />
        </section>
    );
}
