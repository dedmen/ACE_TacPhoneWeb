import type { JSX } from 'react';
import { useState } from 'react';

import type { ChatRoomSummary } from '../api';
import type { GroupListEntry, PlayerListEntry } from '../protocol';
import { roomDisplayName } from '../state/roomUtils';
import { chatStore } from '../state/ChatStore';
import { DialogActions, FloatingDialog } from './FloatingDialog';
import type { ParticipantSelection } from './ParticipantPicker';
import { ParticipantPicker } from './ParticipantPicker';
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

            setError(result.error ?? 'Could not add the participants.');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <FloatingDialog
            title="Add participants"
            subtitle={roomDisplayName(room, selfUid)}
            onClose={onClose}
            footer={(
                <DialogActions>
                    <button type="button" className={styles.button} onClick={onClose} disabled={busy}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className={`${styles.button} ${styles.buttonPrimary}`}
                        onClick={() => {
                            void add();
                        }}
                        disabled={!canAdd}
                    >
                        {busy ? 'Adding...' : 'Add'}
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
                placeholder="Search players and groups"
            />

            {error && <div className={styles.error}>{error}</div>}
        </FloatingDialog>
    );
}
