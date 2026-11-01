import type { JSX } from 'react';
import { useState } from 'react';

import type { ChatRoomSummary } from '../api';
import { safeColor } from '../format';
import { roomDisplayName } from '../state/roomUtils';
import { chatStore } from '../state/ChatStore';
import { DialogActions, FloatingDialog } from './FloatingDialog';
import { Avatar, PresenceDot } from './Ui';
import { t } from '../i18n';
import styles from './Dialogs.module.css';

interface MemberListDialogProps {
    room: ChatRoomSummary;
    selfUid: string | undefined;
    onClose(): void;
}

/**
 * Every participant of a room with presence, group and creator.
 *
 * Group rooms allow removing other players; direct rooms never do, because the
 * room is defined by the two participants.
 */
export function MemberListDialog({ room, selfUid, onClose }: MemberListDialogProps): JSX.Element {
    const [removing, setRemoving] = useState<string | undefined>(undefined);
    const [leaving, setLeaving] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    const canRemove = room.kind === 'group';
    const participants = [...room.participants].sort((left, right) => {
        if (left.creator && !right.creator) return -1;
        if (right.creator && !left.creator) return 1;

        return left.name.localeCompare(right.name);
    });

    const grouped = new Map<string, { name: string; color?: string; members: typeof participants }>();
    const ungrouped: typeof participants = [];

    for (const participant of participants) {
        const groupId = participant.groupId;

        if (typeof groupId !== 'string' || groupId === '') {
            ungrouped.push(participant);
            continue;
        }

        const entry = grouped.get(groupId) ?? {
            name: participant.groupName ?? groupId,
            color: participant.groupColor,
            members: [],
        };

        entry.members.push(participant);
        grouped.set(groupId, entry);
    }

    const selfParticipant = participants.find(participant => participant.uid === selfUid);
    const groupLocked = selfParticipant?.groupInvited === true;

    const leave = async (): Promise<void> => {
        if (selfUid === undefined || leaving || groupLocked) return;

        setLeaving(true);
        setError(undefined);

        try {
            const result = await chatStore.removeParticipants(room.id, [selfUid]);

            if (!result.ok) {
                setError(result.error ?? t('STR_ACE_Tacphone_Messenger_Members_LeaveFailed'));

                return;
            }

            onClose();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLeaving(false);
        }
    };

    const remove = async (uid: string): Promise<void> => {
        setRemoving(uid);
        setError(undefined);

        try {
            const result = await chatStore.removeParticipants(room.id, [uid]);

            if (!result.ok) setError(result.error ?? t('STR_ACE_Tacphone_Messenger_Members_RemoveFailed'));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setRemoving(undefined);
        }
    };

    const renderParticipant = (participant: (typeof participants)[number]): JSX.Element => {
        const color = safeColor(participant.groupColor);
        const isSelf = participant.uid === selfUid;
        const isRemoving = removing === participant.uid;

        return (
            <div key={participant.uid} className={styles.memberRow}>
                <Avatar name={participant.name} color={participant.groupColor} size={26} />
                <div className={styles.memberInfo}>
                    <div className={styles.memberName}>
                        <span>{participant.name}</span>
                        {isSelf && <span className={styles.creatorBadge}>{t('str_a3_rscdisplaydynamicgroups_you')}</span>}
                        {participant.creator && !isSelf && (
                            <span className={styles.creatorBadge}>{t('STR_ACE_Tacphone_Messenger_Members_Creator')}</span>
                        )}
                    </div>
                    <div className={styles.memberMeta}>
                        {color && (
                            <span
                                className={styles.groupColorSwatch}
                                style={{ background: color }}
                                aria-hidden="true"
                            />
                        )}
                        <span>{participant.groupName ?? t('STR_ACE_Tacphone_Messenger_Picker_NoGroup')}</span>
                        <PresenceDot presence={participant.presence} withLabel />
                    </div>
                </div>
                {canRemove && !isSelf && participant.groupInvited !== true && (
                    <button
                        type="button"
                        className={styles.removeButton}
                        disabled={removing !== undefined}
                        onClick={() => {
                            void remove(participant.uid);
                        }}
                    >
                        {isRemoving ? t('STR_ACE_Tacphone_Messenger_Members_Removing') : t('str_a3_cfgvehicles_modulecuratoraddaddons_f_arguments_mode_values_remove')}
                    </button>
                )}
            </div>
        );
    };

    return (
        <FloatingDialog
            title={roomDisplayName(room, selfUid)}
            subtitle={participants.length === 1
                ? t('STR_ACE_Tacphone_Messenger_ChatView_Participant_One')
                : t('STR_ACE_Tacphone_Messenger_ChatView_Participant_Other', participants.length)}
            onClose={onClose}
            footer={(
                <DialogActions>
                    {groupLocked && (
                        <span className={styles.leaveNote}>
                            {t('STR_ACE_Tacphone_Messenger_Members_GroupLockedNote')}
                        </span>
                    )}
                    <button
                        type="button"
                        className={`${styles.button} ${styles.buttonDanger}`}
                        disabled={selfUid === undefined || leaving || groupLocked || removing !== undefined}
                        title={groupLocked
                            ? t('STR_ACE_Tacphone_Messenger_Members_GroupLockedTitle')
                            : t('STR_ACE_Tacphone_Messenger_Members_LeaveTitle')}
                        onClick={() => {
                            void leave();
                        }}
                    >
                        {leaving ? t('STR_ACE_Tacphone_Messenger_Members_Leaving') : t('STR_ACE_Tacphone_Messenger_Members_Leave')}
                    </button>
                    <button type="button" className={styles.button} onClick={onClose}>
                        {t('str_disp_close')}
                    </button>
                </DialogActions>
            )}
        >
            <div className={styles.memberList}>
                {[...grouped.entries()].map(([groupId, group]) => (
                    <div key={groupId} className={styles.memberGroup}>
                        <div className={styles.memberGroupHeader}>
                            {safeColor(group.color) && (
                                <span
                                    className={styles.groupColorSwatch}
                                    style={{ background: safeColor(group.color) }}
                                    aria-hidden="true"
                                />
                            )}
                            <span>{group.name}</span>
                            {group.members.some(member => member.groupInvited === true) && (
                                <span className={styles.creatorBadge}>{t('STR_ACE_Tacphone_Messenger_Members_GroupInvited')}</span>
                            )}
                            <span className={styles.memberGroupCount}>{group.members.length}</span>
                        </div>
                        {group.members.map(renderParticipant)}
                    </div>
                ))}

                {ungrouped.length > 0 && (
                    <div className={styles.memberGroup}>
                        {grouped.size > 0 && (
                            <div className={styles.memberGroupHeader}>{t('STR_ACE_Tacphone_Messenger_Picker_NoGroup')}</div>
                        )}
                        {ungrouped.map(renderParticipant)}
                    </div>
                )}
            </div>

            {error && <div className={styles.error}>{error}</div>}
        </FloatingDialog>
    );
}
