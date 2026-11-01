import type { JSX } from 'react';
import type { CSSProperties } from 'react';

import type { ChatMessage, ChatRoomSummary } from '../api';
import { formatMissionClock, formatRelativeTime, messageAccent, safeColor } from '../format';
import { useMessengerUi } from '../ui';
import { ChatObjectCard } from './ChatObjectCard';
import { ForwardIcon, WarningIcon } from './icons';
import { Avatar } from './Ui';
import { t } from '../i18n';
import styles from './MessageItem.module.css';

interface MessageItemProps {
    message: ChatMessage;
    room: ChatRoomSummary;
    selfUid: string | undefined;
    /** Extrapolated server time, for the relative timestamp. */
    now: number;
    /** True when the room spans more than one group. */
    showGroupNames: boolean;
    /** False when this message continues the previous sender/time group. */
    showHeader: boolean;
    joinedRoomIds: ReadonlySet<string>;
}

/**
 * One message bubble.
 *
 * Sender name, group and colour come from the message (captured at send time),
 * falling back to the current participant record for the colour only, so an old
 * message keeps rendering after a player changed group.
 */
export function MessageItem({
    message,
    room,
    selfUid,
    now,
    showGroupNames,
    showHeader,
    joinedRoomIds,
}: MessageItemProps): JSX.Element {
    const ui = useMessengerUi();
    const own = selfUid !== undefined && message.senderUid === selfUid;
    const accent = messageAccent(message, room.participants);
    const participant = room.participants.find(entry => entry.uid === message.senderUid);
    const groupColor = safeColor(participant?.groupColor);
    const groupName = showGroupNames ? message.senderGroupName : undefined;
    const canForward = message.id !== '' && message.pending !== true && message.failed !== true;

    const nameStyle: CSSProperties | undefined = accent ? { color: accent } : undefined;

    if (message.system === true) {
        return <div className={styles.system}>{message.content}</div>;
    }

    return (
        <div
            className={`${styles.row} ${own ? styles.own : ''} ${showHeader ? styles.rowStart : ''}`}
            data-pending={message.pending === true}
        >
            {showHeader && !own && (
                <Avatar name={message.senderName} color={accent ?? groupColor} size={26} className={styles.avatar} />
            )}

            <div className={styles.body}>
                {showHeader && (
                    <div className={styles.header}>
                        <span className={styles.sender} style={nameStyle}>
                            {own ? t('str_a3_rscdisplaydynamicgroups_you') : message.senderName}
                        </span>
                        {groupName && (
                            <span className={styles.group} style={nameStyle}>
                                {groupName}
                            </span>
                        )}
                        <span className={styles.time} title={formatMissionClock(message.timestamp)}>
                            {formatRelativeTime(message.timestamp, now)}
                        </span>
                    </div>
                )}

                <div className={`${styles.bubble} ${own ? styles.bubbleOwn : ''}`}>
                    {message.forwarded && (
                        <div className={styles.forwarded}>
                            <ForwardIcon className={styles.forwardedIcon} />
                            <span>
                                {message.forwarded.senderGroupName
                                    ? t(
                                        'STR_ACE_Tacphone_Messenger_Message_ForwardedWithGroup',
                                        message.forwarded.roomName || t('STR_ACE_Tacphone_Messenger_Message_AnotherRoom'),
                                        message.forwarded.senderName,
                                        message.forwarded.senderGroupName,
                                    )
                                    : t(
                                        'STR_ACE_Tacphone_Messenger_Message_Forwarded',
                                        message.forwarded.roomName || t('STR_ACE_Tacphone_Messenger_Message_AnotherRoom'),
                                        message.forwarded.senderName,
                                    )}
                            </span>
                        </div>
                    )}

                    {message.content.trim() !== '' && (
                        <div className={styles.content}>{message.content}</div>
                    )}

                    {(message.objects?.length ?? 0) > 0 && (
                        <div className={styles.objects}>
                            {message.objects?.map((object, index) => (
                                <ChatObjectCard
                                    // Objects are immutable per message; the index is stable.
                                    key={`${object.kind}:${index}`}
                                    object={object}
                                    joinedRoomIds={joinedRoomIds}
                                />
                            ))}
                        </div>
                    )}

                    {message.failed === true && (
                        <div className={styles.failed}>
                            <WarningIcon className={styles.failedIcon} />
                            {t('STR_ACE_Tacphone_Messenger_Message_SendFailed')}
                        </div>
                    )}
                </div>

                <div className={styles.footer}>
                    {message.pending === true && <span className={styles.pending}>{t('STR_ACE_Tacphone_Messenger_Message_Sending')}</span>}
                    {canForward && (
                        <button
                            type="button"
                            className={styles.action}
                            title={t('STR_ACE_Tacphone_Messenger_Target_ForwardTitle')}
                            aria-label={t('STR_ACE_Tacphone_Messenger_Target_ForwardTitle')}
                            onClick={() => {
                                ui.openForward(room.id, message.id);
                            }}
                        >
                            <ForwardIcon className={styles.actionIcon} />
                            {t('str_a3_forward')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
