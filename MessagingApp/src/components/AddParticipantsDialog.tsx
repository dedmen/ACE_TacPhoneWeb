import type { JSX } from 'react';
import { useState } from 'react';

import type { ChatRoomSummary } from '../api';
import type { GroupListEntry, PlayerListEntry } from '../protocol';
import { roomDisplayName } from '../state/roomUtils';
import { chatStore } from '../state/ChatStore';
import { DialogActions, FloatingDialog } from './FloatingDialog';
import type { ParticipantSelection } from './ParticipantPicker';
import { ParticipantPicker } from './ParticipantPicker';
import { t } from '../i18n';
import styles from './Dialogs.module.css';

interface AddParticipantsDialogProps {
    room: ChatRoomSummary;
    players: readonly PlayerListEntry[];
    groups: readonly GroupListEntry[];
    selfUid: string | undefined;
    onClose(): void;
}

const EMPTY_SELECTION: ParticipantSelection = { playerUids: [], groupIds: [] };

/** Adds players and groups to an existing group room. */
export function AddParticipantsDialog({
    room,
    players,
    groups,
    selfUid,
    onClose,
}: AddParticipantsDialogProps): JSX.Element {
    const [selection, setSelection] = useState<ParticipantSelection>(EMPTY_SELECTION);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    const presentUids = new Set(room.participants.map(participant => participant.uid));
    if (selfUid !== undefined) presentUids.add(selfUid);

    const canAdd = selection.playerUids.length + selection.groupIds.length > 0 && !busy;

    const add = async (): Promise<void> => {
        if (!canAdd) return;

        setBusy(true);
        setError(undefined);

        try {
            const result = await chatStore.addParticipants(
                room.id,
                selection.playerUids,
                selection.groupIds,
            );

            if (result.ok) {
                onClose();

                return;
            }

            setError(result.error ?? t('STR_ACE_Tacphone_Messenger_AddParticipants_Failed'));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <FloatingDialog
            title={t('STR_ACE_Tacphone_Messenger_AddParticipants_Title')}
            subtitle={roomDisplayName(room, selfUid)}
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
                            void add();
                        }}
                        disabled={!canAdd}
                    >
                        {busy ? t('STR_ACE_Tacphone_Messenger_AddParticipants_Adding') : t('str_a3_cfgvehicles_modulecuratoraddeditableobjects_arguments_addcrew_values_yes')}
                    </button>
                </DialogActions>
            )}
        >
            <ParticipantPicker
                players={players}
                groups={groups}
                selected={selection}
                onChange={setSelection}
                disabledPlayerUids={presentUids}
                placeholder={t('STR_ACE_Tacphone_Messenger_Picker_SearchPlaceholder')}
            />

            {error && <div className={styles.error}>{error}</div>}
        </FloatingDialog>
    );
}
