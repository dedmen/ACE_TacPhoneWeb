import type { CSSProperties, JSX } from 'react';

import type { ChatPresence } from '../api';
import { initialsOf, safeColor } from '../format';
import styles from './Ui.module.css';

interface PresenceDotProps {
    presence: ChatPresence | undefined;
    /** Add a label next to the dot ("Available"). */
    withLabel?: boolean;
    className?: string;
}

/** Coloured presence dot: green available, amber minimized, grey offline. */
export function PresenceDot({ presence, withLabel = false, className }: PresenceDotProps): JSX.Element {
    const value = presence ?? 'offline';

    return (
        <span
            className={[styles.presence, className].filter(Boolean).join(' ')}
            title={value}
            data-presence={value}
        >
            <span className={styles.presenceDot} data-presence={value} aria-hidden="true" />
            {withLabel && <span className={styles.presenceLabel}>{value}</span>}
        </span>
    );
}

interface AvatarProps {
    name: string;
    color?: string;
    /** Diameter in pixels. */
    size?: number;
    className?: string;
}

/** Initial-based avatar tinted with the participant's group colour. */
export function Avatar({ name, color, size = 28, className }: AvatarProps): JSX.Element {
    const accent = safeColor(color);
    const style: CSSProperties = {
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.4)),
        ...(accent ? { borderColor: accent, color: accent } : {}),
    };

    return (
        <span className={[styles.avatar, className].filter(Boolean).join(' ')} style={style} aria-hidden="true">
            {initialsOf(name)}
        </span>
    );
}

interface SearchInputProps {
    value: string;
    onChange(value: string): void;
    placeholder?: string;
    autoFocus?: boolean;
    ariaLabel?: string;
}

/** Compact search field used by the room list and every picker. */
export function SearchInput({
    value,
    onChange,
    placeholder = 'Search',
    autoFocus = false,
    ariaLabel,
}: SearchInputProps): JSX.Element {
    return (
        <label className={styles.search}>
            <svg className={styles.searchIcon} viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M10.5 10.5 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
                type="search"
                className={styles.searchField}
                value={value}
                placeholder={placeholder}
                aria-label={ariaLabel ?? placeholder}
                autoFocus={autoFocus}
                onChange={event => {
                    onChange(event.currentTarget.value);
                }}
            />
            {value !== '' && (
                <button
                    type="button"
                    className={styles.searchClear}
                    aria-label="Clear search"
                    onClick={() => {
                        onChange('');
                    }}
                >
                    x
                </button>
            )}
        </label>
    );
}

interface EmptyStateProps {
    title: string;
    hint?: string;
    icon?: JSX.Element;
    children?: JSX.Element;
}

/** Centered placeholder for an empty list or an unselected room. */
export function EmptyState({ title, hint, icon, children }: EmptyStateProps): JSX.Element {
    return (
        <div className={styles.empty}>
            {icon && <div className={styles.emptyIcon}>{icon}</div>}
            <div className={styles.emptyTitle}>{title}</div>
            {hint && <div className={styles.emptyHint}>{hint}</div>}
            {children}
        </div>
    );
}

interface StatusStripProps {
    tone?: 'info' | 'error';
    children: JSX.Element | string;
    action?: JSX.Element;
}

/** Thin banner above the chat for connection and error states. */
export function StatusStrip({ tone = 'info', children, action }: StatusStripProps): JSX.Element {
    return (
        <div className={styles.strip} data-tone={tone}>
            <span className={styles.stripText}>{children}</span>
            {action}
        </div>
    );
}
