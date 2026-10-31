import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import { filterGroups, filterPlayers } from '../format';
import type { GroupListEntry, PlayerListEntry } from '../protocol';
import { SearchInput } from './Ui';
import styles from './Dialogs.module.css';

export interface ParticipantSelection {
    playerUids: string[];
    groupIds: string[];
}

interface ParticipantPickerProps {
    players: readonly PlayerListEntry[];
    groups: readonly GroupListEntry[];
    selected: ParticipantSelection;
    onChange(next: ParticipantSelection): void;
    /** Rows that cannot be selected because they are already in the room. */
    disabledPlayerUids?: ReadonlySet<string>;
    disabledGroupIds?: ReadonlySet<string>;
    /** Hide the Groups tab when the caller only needs players. */
    allowGroups?: boolean;
    placeholder?: string;
}

function toggle(list: readonly string[], value: string): string[] {
    return list.includes(value) ? list.filter(item => item !== value) : [...list, value];
}

/**
 * Combined player/group selector with search.
 *
 * Players are matched by name; groups by group name and by their current member
 * names, so searching "Bob" finds Bob's group too. Selecting a group selects all
 * of its human members on the game side.
 */
export function ParticipantPicker({
    players,
    groups,
    selected,
    onChange,
    disabledPlayerUids,
    disabledGroupIds,
    allowGroups = true,
    placeholder = 'Search players and groups',
}: ParticipantPickerProps): JSX.Element {
    const [tab, setTab] = useState<'players' | 'groups'>('players');
    const [query, setQuery] = useState('');

    const visiblePlayers = useMemo(
        () => filterPlayers(players, query).sort((left, right) => left.name.localeCompare(right.name)),
        [players, query],
    );
    const visibleGroups = useMemo(
        () => filterGroups(groups, players, query).sort((left, right) => left.name.localeCompare(right.name)),
        [groups, players, query],
    );

    const nameByUid = useMemo(
        () => new Map(players.map(player => [player.uid, player.name])),
        [players],
    );

    const showGroups = allowGroups && groups.length > 0;

    return (
        <div className={styles.picker}>
            <SearchInput value={query} onChange={setQuery} placeholder={placeholder} />

            {showGroups && (
                <div className={styles.tabs} role="tablist" aria-label="Participant type">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'players'}
                        className={styles.tab}
                        data-active={tab === 'players'}
                        onClick={() => {
                            setTab('players');
                        }}
                    >
                        Players
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'groups'}
                        className={styles.tab}
                        data-active={tab === 'groups'}
                        onClick={() => {
                            setTab('groups');
                        }}
                    >
                        Groups
                    </button>
                </div>
            )}

            <div className={styles.optionList} role="listbox" aria-multiselectable="true">
                {tab === 'players' || !showGroups
                    ? visiblePlayers.map(player => {
                        const disabled = disabledPlayerUids?.has(player.uid) === true;
                        const isSelected = selected.playerUids.includes(player.uid);

                        return (
                            <button
                                key={player.uid}
                                type="button"
                                role="option"
                                aria-selected={isSelected}
                                disabled={disabled}
                                className={styles.option}
                                data-selected={isSelected}
                                onClick={() => {
                                    onChange({
                                        ...selected,
                                        playerUids: toggle(selected.playerUids, player.uid),
                                    });
                                }}
                            >
                                <span className={styles.checkbox} data-checked={isSelected} aria-hidden="true" />
                                <span className={styles.optionText}>
                                    <span className={styles.optionName}>{player.name}</span>
                                    <span className={styles.optionMeta}>
                                        {disabled ? 'Already in the room' : player.groupName ?? 'No group'}
                                    </span>
                                </span>
                                {!disabled && player.presence !== 'available' && (
                                    <span className={styles.optionHint}>{player.presence}</span>
                                )}
                            </button>
                        );
                    })
                    : visibleGroups.map(group => {
                        const disabled = disabledGroupIds?.has(group.id) === true;
                        const isSelected = selected.groupIds.includes(group.id);
                        const memberNames = group.memberUids
                            .map(uid => nameByUid.get(uid))
                            .filter((name): name is string => typeof name === 'string');

                        return (
                            <button
                                key={group.id}
                                type="button"
                                role="option"
                                aria-selected={isSelected}
                                disabled={disabled}
                                className={styles.option}
                                data-selected={isSelected}
                                onClick={() => {
                                    onChange({
                                        ...selected,
                                        groupIds: toggle(selected.groupIds, group.id),
                                    });
                                }}
                            >
                                <span className={styles.checkbox} data-checked={isSelected} aria-hidden="true" />
                                <span className={styles.optionText}>
                                    <span className={styles.optionName}>
                                        {group.name || 'Unnamed group'}
                                        <span className={styles.countBadge}>{memberNames.length}</span>
                                    </span>
                                    <span className={styles.optionMeta}>
                                        {memberNames.length > 0 ? memberNames.join(', ') : 'No players'}
                                    </span>
                                </span>
                            </button>
                        );
                    })}

                {(tab === 'players' || !showGroups) && visiblePlayers.length === 0 && (
                    <div className={styles.optionEmpty}>No players match the search.</div>
                )}
                {tab === 'groups' && showGroups && visibleGroups.length === 0 && (
                    <div className={styles.optionEmpty}>No groups match the search.</div>
                )}
            </div>

            <div className={styles.selectionSummary}>
                {selected.playerUids.length} player{selected.playerUids.length === 1 ? '' : 's'}
                {showGroups ? `, ${selected.groupIds.length} group${selected.groupIds.length === 1 ? '' : 's'}` : ''} selected
            </div>
        </div>
    );
}
