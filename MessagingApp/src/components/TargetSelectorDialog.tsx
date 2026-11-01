import type { JSX } from 'react';
import { useState } from 'react';

import type { ChatMessage, ChatObject, ChatRoomSummary, ShareResult } from '../api';
import type { GroupListEntry, NewRoomSpec, PlayerListEntry } from '../protocol';
import { roomDisplayName } from '../state/roomUtils';
import { chatStore } from '../state/ChatStore';
import { sendObjectMessage } from '../service';
import { DialogActions, FloatingDialog } from './FloatingDialog';
import type { ParticipantSelection } from './ParticipantPicker';
import { ParticipantPicker } from './ParticipantPicker';
import { t } from '../i18n';
import styles from './Dialogs.module.css';

/** What the selector is used for. */
export type TargetSelectorMode = 'forward' | 'invite' | 'share';

interface TargetSelectorDialogProps {
    mode: TargetSelectorMode;
    rooms: readonly ChatRoomSummary[];
    players: readonly PlayerListEntry[];
    groups: readonly GroupListEntry[];
    selfUid: string | undefined;
    /**
     * Source of a forward, or the room an invite is for. Empty for `share`,
     * which starts outside any room.
     */
    sourceRoomId: string;
    /** Message being forwarded; `forward` mode only. */
    message?: ChatMessage;
    /** Objects being shared; `share` mode only. */
    objects?: ChatObject[];
    onClose(): void;
    /** `share` mode: receives the final result; defaults to `onClose`. */
    onShareResult?(result: ShareResult): void;
}

const EMPTY_SELECTION: ParticipantSelection = { playerUids: [], groupIds: [] };

const TITLES: Record<TargetSelectorMode, string> = {
    forward: 'STR_ACE_Tacphone_Messenger_Target_ForwardTitle',
    invite: 'STR_ACE_Tacphone_Messenger_Target_InviteTitle',
    share: 'STR_ACE_Tacphone_Messenger_Target_ShareTitle',
};

const CONFIRM_LABELS: Record<TargetSelectorMode, string> = {
    forward: 'str_a3_forward',
    invite: 'STR_ACE_Tacphone_Messenger_Target_SendInvite',
    share: 'STR_ACE_Tacphone_Messenger_Target_Share',
};

function initialRoomId(
    mode: TargetSelectorMode,
    rooms: readonly ChatRoomSummary[],
    sourceRoomId: string,
): string | null {
    if (mode === 'invite') {
        return rooms.some(room => room.id === sourceRoomId) ? sourceRoomId : null;
    }

    // Forwarding into the room the message came from is pointless.
    return rooms.find(room => room.id !== sourceRoomId)?.id ?? null;
}

/**
 * Shared target selector for forwarding, inviting and sharing.
 *
 * Lists the existing rooms plus a "New room" entry with the player/group
 * picker, so a share from another app can reach somebody who is not in any chat
 * yet. In `invite` mode the current room is preselected and the picker chooses
 * the recipients of the invite card.
 */
export function TargetSelectorDialog({
    mode,
    rooms,
    players,
    groups,
    selfUid,
    sourceRoomId,
    message,
    objects,
    onClose,
    onShareResult,
}: TargetSelectorDialogProps): JSX.Element {
    const [selectedRoomId, setSelectedRoomId] = useState<string | null>(
        () => initialRoomId(mode, rooms, sourceRoomId),
    );
    const [newRoom, setNewRoom] = useState(false);
    const [roomName, setRoomName] = useState('');
    const [selection, setSelection] = useState<ParticipantSelection>(EMPTY_SELECTION);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    const visibleRooms = mode === 'forward'
        ? rooms.filter(room => room.id !== sourceRoomId)
        : rooms;

    // The room list can arrive after the dialog opened (a share request may
    // land during the first sync), so the selection falls back to the default
    // until the user picks something explicitly.
    const fallbackRoomId = initialRoomId(mode, rooms, sourceRoomId);
    const effectiveRoomId = selectedRoomId !== null
        && visibleRooms.some(room => room.id === selectedRoomId)
        ? selectedRoomId
        : fallbackRoomId;

    const targetRoom = visibleRooms.find(room => room.id === effectiveRoomId);
    const targetParticipantUids = new Set(targetRoom?.participants.map(participant => participant.uid) ?? []);

    const selectionCount = selection.playerUids.length + selection.groupIds.length;
    const isDirect = selection.playerUids.length === 1
        && selection.groupIds.length === 0
        && roomName.trim() === '';

    const spec: NewRoomSpec = {
        kind: isDirect ? 'direct' : 'group',
        name: roomName.trim() === '' ? undefined : roomName.trim(),
        playerUids: selection.playerUids,
        groupIds: selection.groupIds,
    };

    const canConfirm = !busy && (
        newRoom
            ? selectionCount > 0
            : mode === 'invite'
                ? effectiveRoomId !== null && selectionCount > 0
                : effectiveRoomId !== null
    );

    const disabledPlayerUids = new Set<string>();
    if (newRoom) {
        if (selfUid !== undefined) disabledPlayerUids.add(selfUid);
    } else if (targetRoom) {
        for (const participant of targetRoom.participants) disabledPlayerUids.add(participant.uid);
    }

    // Invites are for people who are not in the room yet. Hide existing
    // participants entirely instead of showing disabled "already in the room"
    // rows, which adds noise to a long roster.
    const invitePlayerList = mode === 'invite' && !newRoom && targetRoom
        ? players.filter(player => !targetParticipantUids.has(player.uid))
        : players;
    const inviteGroupList = mode === 'invite' && !newRoom && targetRoom
        ? groups.filter(group => !group.memberUids.every(uid => targetParticipantUids.has(uid)))
        : groups;

    const submit = async (): Promise<void> => {
        if (!canConfirm) return;

        setBusy(true);
        setError(undefined);

        try {
            if (mode === 'forward') {
                const target = newRoom
                    ? { newRoom: spec }
                    : { roomId: effectiveRoomId ?? undefined };
                const result = await chatStore.forwardMessage(
                    sourceRoomId,
                    message?.id ?? '',
                    target,
                );

                if (!result.ok) {
                    setError(result.error ?? t('STR_ACE_Tacphone_Messenger_Target_ForwardFailed'));

                    return;
                }

                onClose();

                return;
            }

            if (mode === 'share') {
                let roomId = effectiveRoomId ?? undefined;

                if (newRoom) {
                    const created = await chatStore.createRoom(spec);
                    if (!created.ok || created.roomId === undefined || created.roomId === '') {
                        setError(created.error ?? t('STR_ACE_Tacphone_Messenger_CreateRoom_Failed'));

                        return;
                    }

                    roomId = created.roomId;
                }

                if (roomId === undefined) {
                    setError(t('STR_ACE_Tacphone_Messenger_Target_ChooseRoom'));

                    return;
                }

                const result = await sendObjectMessage(roomId, objects ?? []);
                if (!result.ok) {
                    setError(result.error ?? t('STR_ACE_Tacphone_Messenger_Target_ShareFailed'));

                    return;
                }

                if (onShareResult) onShareResult(result);
                else onClose();

                return;
            }

            // invite
            const result = newRoom
                ? await chatStore.inviteToRoom({ newRoom: spec })
                : await chatStore.inviteToRoom({
                    roomId: effectiveRoomId ?? undefined,
                    playerUids: selection.playerUids,
                    groupIds: selection.groupIds,
                });

            if (!result.ok) {
                setError(result.error ?? t('STR_ACE_Tacphone_Messenger_Target_InviteFailed'));

                return;
            }

            onClose();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const subtitle = newRoom
        ? mode === 'invite'
            ? t('STR_ACE_Tacphone_Messenger_Target_NewRoomInviteHint')
            : mode === 'forward'
                ? t('STR_ACE_Tacphone_Messenger_Target_NewRoomForwardHint')
                : t('STR_ACE_Tacphone_Messenger_Target_NewRoomShareHint')
        : mode === 'forward'
            ? t('STR_ACE_Tacphone_Messenger_Target_ForwardHint')
            : mode === 'invite'
                ? t('STR_ACE_Tacphone_Messenger_Target_InviteHint')
                : t('STR_ACE_Tacphone_Messenger_Target_ShareHint');

    return (
        <FloatingDialog
            title={t(TITLES[mode])}
            subtitle={subtitle}
            onClose={onClose}
            footer={(
                <DialogActions>
                    <button type="button" className={styles.button} onClick={onClose} disabled={busy}>
                        {t('STR_3DEN_Display3DEN_ControlsHint_Cancel')}
                    </button>
                    <button
                        type="button"
                        className={`${styles.button} ${styles.buttonPrimary}`}
                        onClick={() => {
                            void submit();
                        }}
                        disabled={!canConfirm}
                    >
                        {busy ? t('STR_ACE_Tacphone_Messenger_Target_Sending') : t(CONFIRM_LABELS[mode])}
                    </button>
                </DialogActions>
            )}
        >
            {!newRoom && (
                <>
                    <div className={styles.sectionTitle}>{t('STR_ACE_Tacphone_Messenger_Target_Rooms')}</div>
                    <div className={styles.roomList} role="listbox" aria-label={t('STR_ACE_Tacphone_Messenger_Target_Rooms')}>
                        {visibleRooms.map(room => {
                            const isSelected = effectiveRoomId === room.id;

                            return (
                                <button
                                    key={room.id}
                                    type="button"
                                    role="option"
                                    aria-selected={isSelected}
                                    className={styles.roomOption}
                                    data-selected={isSelected}
                                    onClick={() => {
                                        setSelectedRoomId(room.id);
                                    }}
                                >
                                    <span className={styles.radio} aria-hidden="true" />
                                    <span className={styles.roomText}>
                                        <span className={styles.roomName}>
                                            {roomDisplayName(room, selfUid)}
                                        </span>
                                        <span className={styles.roomMeta}>
                                            {room.kind === 'direct' ? t('STR_A3_TargetBootcampTable_direct') : t('STR_ACE_Tacphone_Messenger_Target_Group')}
                                            {' - '}
                                            {room.participants.length === 1
                                                ? t('STR_ACE_Tacphone_Messenger_ChatView_Participant_One')
                                                : t('STR_ACE_Tacphone_Messenger_ChatView_Participant_Other', room.participants.length)}
                                        </span>
                                    </span>
                                </button>
                            );
                        })}
                        {visibleRooms.length === 0 && (
                            <div className={styles.optionEmpty}>{t('STR_ACE_Tacphone_Messenger_Target_NoRooms')}</div>
                        )}
                    </div>

                    <button
                        type="button"
                        className={styles.newRoomRow}
                        onClick={() => {
                            setNewRoom(true);
                        }}
                    >
                        {t('STR_ACE_Tacphone_Messenger_Target_NewRoom')}
                    </button>
                </>
            )}

            {newRoom && (
                <>
                    <div className={styles.field}>
                        <label className={styles.label} htmlFor="messenger-target-room-name">
                            {t('STR_ACE_Tacphone_Messenger_CreateRoom_NameLabel')}
                        </label>
                        <input
                            id="messenger-target-room-name"
                            className={styles.input}
                            value={roomName}
                            placeholder={t('STR_ACE_Tacphone_Messenger_CreateRoom_NamePlaceholder')}
                            maxLength={64}
                            onChange={event => {
                                setRoomName(event.currentTarget.value);
                            }}
                        />
                    </div>

                    <div className={styles.sectionTitle}>
                        {mode === 'invite' ? t('STR_ACE_Tacphone_Messenger_Target_RoomParticipants') : t('STR_ACE_Tacphone_Messenger_CreateRoom_Participants')}
                    </div>
                    <ParticipantPicker
                        players={players}
                        groups={groups}
                        selected={selection}
                        onChange={setSelection}
                        disabledPlayerUids={disabledPlayerUids}
                        placeholder={t('STR_ACE_Tacphone_Messenger_Picker_SearchPlaceholder')}
                    />

                    <button
                        type="button"
                        className={styles.newRoomRow}
                        onClick={() => {
                            setNewRoom(false);
                        }}
                    >
                        {t('STR_ACE_Tacphone_Messenger_Target_BackToRooms')}
                    </button>
                </>
            )}

            {mode === 'invite' && !newRoom && (
                <>
                    <div className={styles.sectionTitle}>{t('STR_ACE_Tacphone_Messenger_Target_PeopleToInvite')}</div>
                    <ParticipantPicker
                        players={invitePlayerList}
                        groups={inviteGroupList}
                        selected={selection}
                        onChange={setSelection}
                        disabledPlayerUids={disabledPlayerUids}
                        placeholder={t('STR_ACE_Tacphone_Messenger_Picker_SearchPlaceholder')}
                    />
                </>
            )}

            {error && <div className={styles.error}>{error}</div>}
        </FloatingDialog>
    );
}
