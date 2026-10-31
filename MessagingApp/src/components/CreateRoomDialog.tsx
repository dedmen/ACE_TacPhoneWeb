import type { JSX } from 'react';
import { useState } from 'react';

import type { NewRoomSpec } from '../protocol';
import type { GroupListEntry, PlayerListEntry } from '../protocol';
import { chatStore } from '../state/ChatStore';
import { DialogActions, FloatingDialog } from './FloatingDialog';
import type { ParticipantSelection } from './ParticipantPicker';
import { ParticipantPicker } from './ParticipantPicker';
import styles from './Dialogs.module.css';

interface CreateRoomDialogProps {
    players: readonly PlayerListEntry[];
    groups: readonly GroupListEntry[];
    selfUid: string | undefined;
    onClose(): void;
    /** Called with the new room id after a successful create. */
    onCreated(roomId: string): void;
}

const EMPTY_SELECTION: ParticipantSelection = { playerUids: [], groupIds: [] };

/**
 * Creates a direct chat or a group room.
 *
 * One player and no room name makes a direct room; anything else (more players,
 * a group, or an explicit name) creates a group room, matching the game-side
 * `CreateRoom` rules.
 */
export function CreateRoomDialog({
    players,
    groups,
    selfUid,
    onClose,
    onCreated,
}: CreateRoomDialogProps): JSX.Element {
    const [name, setName] = useState('');
    const [selection, setSelection] = useState<ParticipantSelection>(EMPTY_SELECTION);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    const candidates = selfUid === undefined
        ? players
        : players.filter(player => player.uid !== selfUid);

    const isDirect = selection.playerUids.length === 1
        && selection.groupIds.length === 0
        && name.trim() === '';
    const canCreate = selection.playerUids.length + selection.groupIds.length > 0 && !busy;

    const create = async (): Promise<void> => {
        if (!canCreate) return;

        setBusy(true);
        setError(undefined);

        const spec: NewRoomSpec = {
            kind: isDirect ? 'direct' : 'group',
            name: name.trim() === '' ? undefined : name.trim(),
            playerUids: selection.playerUids,
            groupIds: selection.groupIds,
        };

        try {
            const result = await chatStore.createRoom(spec);

            if (result.ok && typeof result.roomId === 'string' && result.roomId !== '') {
                onCreated(result.roomId);

                return;
            }

            setError(result.error ?? 'Could not create the room.');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <FloatingDialog
            title="New chat"
            subtitle={isDirect ? 'Direct message' : 'Group room'}
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
                            void create();
                        }}
                        disabled={!canCreate}
                    >
                        {busy ? 'Creating...' : isDirect ? 'Start chat' : 'Create room'}
                    </button>
                </DialogActions>
            )}
        >
            <div className={styles.field}>
                <label className={styles.label} htmlFor="messenger-room-name">
                    Room name (optional)
                </label>
                <input
                    id="messenger-room-name"
                    className={styles.input}
                    value={name}
                    placeholder="Leave empty for a direct message"
                    maxLength={64}
                    onChange={event => {
                        setName(event.currentTarget.value);
                    }}
                />
            </div>

            <div className={styles.sectionTitle}>Participants</div>
            <ParticipantPicker
                players={candidates}
                groups={groups}
                selected={selection}
                onChange={setSelection}
                placeholder="Search players and groups"
            />

            {error && <div className={styles.error}>{error}</div>}
        </FloatingDialog>
    );
}
