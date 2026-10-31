import type { JSX } from 'react';
import { useState } from 'react';

import type { ChatPresence } from '../api';
import { messagingDebug } from '../debug';
import { chatStore } from '../state/ChatStore';
import { useChatStore } from '../useChatStore';
import { BugIcon } from './icons';
import styles from './DebugToolbar.module.css';

/**
 * Debug-only fake-player toolbar.
 *
 * Only mounted when `DEBUG_FAKE_PLAYERS_ENABLED` is true (see
 * `MessengerApp.tsx`); release builds render the literal `false` branch and the
 * bundler drops this module, so no `Messaging.Debug.*` string reaches the
 * release bundle.
 */
export function DebugToolbar(): JSX.Element {
    const state = useChatStore();
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState<string | undefined>(undefined);
    const [message, setMessage] = useState('Debug message');
    const [uid, setUid] = useState('');
    const [presence, setPresence] = useState<ChatPresence>('available');
    const [busy, setBusy] = useState(false);

    const refresh = async (): Promise<void> => {
        try {
            await chatStore.requestPlayerList();
        } catch (error) {
            console.warn('Messaging: debug roster refresh failed:', error);
        }
    };

    const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
        setBusy(true);
        setStatus(`${label}...`);

        try {
            const result = await action();
            const text = result === undefined ? 'no response' : JSON.stringify(result);
            setStatus(`${label}: ${text}`);
            await refresh();
        } catch (error) {
            setStatus(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    if (!open) {
        return (
            <button
                type="button"
                className={styles.launcher}
                title="Messenger debug tools"
                aria-label="Messenger debug tools"
                onClick={() => {
                    setOpen(true);
                }}
            >
                <BugIcon className={styles.launcherIcon} />
            </button>
        );
    }

    return (
        <div className={styles.panel}>
            <header className={styles.header}>
                <BugIcon className={styles.headerIcon} />
                <span className={styles.headerTitle}>Messenger debug</span>
                <button
                    type="button"
                    className={styles.collapse}
                    aria-label="Collapse debug tools"
                    onClick={() => {
                        setOpen(false);
                    }}
                >
                    x
                </button>
            </header>

            <div className={styles.body}>
                <div className={styles.group}>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={busy}
                        onClick={() => {
                            void run('fake players', () => messagingDebug.addFakePlayers(8));
                        }}
                    >
                        Add fake players
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={busy}
                        onClick={() => {
                            void run('reset', () => messagingDebug.reset());
                        }}
                    >
                        Reset
                    </button>
                </div>

                <div className={styles.group}>
                    <input
                        className={styles.input}
                        value={message}
                        aria-label="Message to inject"
                        onChange={event => {
                            setMessage(event.currentTarget.value);
                        }}
                    />
                    <button
                        type="button"
                        className={styles.button}
                        disabled={busy}
                        onClick={() => {
                            void run('inject', () => messagingDebug.injectMessage(state.activeRoomId, message));
                        }}
                    >
                        Inject
                    </button>
                </div>

                <div className={styles.group}>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={busy}
                        onClick={() => {
                            void run(
                                'enemy chat',
                                () => messagingDebug.setAllowEnemyChat(!state.allowEnemyChat),
                            );
                        }}
                    >
                        Enemy chat: {state.allowEnemyChat ? 'on' : 'off'}
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={busy}
                        onClick={() => {
                            void run('save state', () => messagingDebug.saveState());
                        }}
                    >
                        Save
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={busy}
                        onClick={() => {
                            void run('load state', () => messagingDebug.loadState());
                        }}
                    >
                        Load
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={busy}
                        onClick={() => {
                            void run('status', () => messagingDebug.status());
                        }}
                    >
                        Status
                    </button>
                </div>

                <div className={styles.group}>
                    <select
                        className={styles.select}
                        value={uid}
                        aria-label="Player uid"
                        onChange={event => {
                            setUid(event.currentTarget.value);
                        }}
                    >
                        <option value="">-- uid --</option>
                        {state.players.map(player => (
                            <option key={player.uid} value={player.uid}>
                                {player.name}
                            </option>
                        ))}
                    </select>
                    <select
                        className={styles.select}
                        value={presence}
                        aria-label="Presence"
                        onChange={event => {
                            setPresence(event.currentTarget.value as ChatPresence);
                        }}
                    >
                        {messagingDebug.presenceValues.map(value => (
                            <option key={value} value={value}>
                                {value}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={busy || uid === ''}
                        onClick={() => {
                            void run('presence', () => messagingDebug.setPresence(uid, presence));
                        }}
                    >
                        Set
                    </button>
                </div>

                <div className={styles.group}>
                    {messagingDebug.displayModes.map(mode => (
                        <button
                            key={mode}
                            type="button"
                            className={styles.button}
                            disabled={busy}
                            onClick={() => {
                                void run(`display ${mode}`, () => messagingDebug.setLocalDisplayMode(mode));
                            }}
                        >
                            {mode}
                        </button>
                    ))}
                </div>

                {status && <div className={styles.status}>{status}</div>}
            </div>
        </div>
    );
}
