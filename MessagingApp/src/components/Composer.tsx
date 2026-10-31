import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { SendIcon } from './icons';
import styles from './Composer.module.css';

interface SendOutcome {
    ok: boolean;
    error?: string;
}

interface ComposerProps {
    /** True while disconnected, not a participant, or no room is selected. */
    disabled: boolean;
    /** Shown instead of the placeholder while {@link disabled}. */
    disabledReason?: string;
    onSend(text: string): Promise<SendOutcome>;
}

/** Text input of the chat: Enter sends, Shift+Enter adds a line. */
export function Composer({ disabled, disabledReason, onSend }: ComposerProps): JSX.Element {
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // Grow with the content up to a few lines, then scroll inside the box.
    useEffect(() => {
        const element = inputRef.current;
        if (!element) return;

        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight + 2, 108)}px`;
    }, [text]);

    const send = async (): Promise<void> => {
        const value = text.trim();
        if (disabled || sending || value === '') return;

        setSending(true);
        setError(undefined);

        try {
            const result = await onSend(value);

            if (result.ok) setText('');
            else setError(result.error ?? 'The message could not be sent.');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setSending(false);
        }
    };

    const canSend = !disabled && !sending && text.trim() !== '';

    return (
        <div className={styles.composer}>
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.row}>
                <textarea
                    ref={inputRef}
                    className={styles.input}
                    rows={1}
                    value={text}
                    disabled={disabled}
                    placeholder={disabled ? (disabledReason ?? 'Messaging is unavailable') : 'Message'}
                    aria-label="Message"
                    onChange={event => {
                        setText(event.currentTarget.value);
                    }}
                    onKeyDown={event => {
                        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;

                        event.preventDefault();
                        void send();
                    }}
                />
                <button
                    type="button"
                    className={styles.send}
                    disabled={!canSend}
                    aria-label="Send message"
                    title="Send (Enter)"
                    onClick={() => {
                        void send();
                    }}
                >
                    <SendIcon className={styles.sendIcon} />
                </button>
            </div>
        </div>
    );
}
