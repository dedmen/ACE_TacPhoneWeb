/**
 * Inline SVG icons.
 *
 * The app bundle must stay self-contained (no icon fonts, no URL imports), so
 * every glyph is a small stroked path drawn in `currentColor`.
 */

import type { JSX } from 'react';

interface IconProps {
    className?: string;
}

function Svg({ className, children }: IconProps & { children: JSX.Element | JSX.Element[] }): JSX.Element {
    return (
        <svg
            className={className}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {children}
        </svg>
    );
}

export function PlusIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <path d="M8 3v10M3 8h10" />
        </Svg>
    );
}

export function BackIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <path d="M9.5 3.5 5 8l4.5 4.5" />
        </Svg>
    );
}

export function SendIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <path d="M2.5 8 13.5 3l-4 10-2-4z" />
        </Svg>
    );
}

export function ForwardIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <path d="M6 4.5 10.5 8 6 11.5" />
            <path d="M2.5 8h8" />
        </Svg>
    );
}

export function UsersIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <circle cx="6" cy="5.5" r="2.3" />
            <path d="M2 13c0-2.2 1.8-3.6 4-3.6s4 1.4 4 3.6" />
            <path d="M11 4a2 2 0 0 1 0 3.6M12 13c0-1.5-.5-2.5-1.4-3.1" />
        </Svg>
    );
}

export function UserPlusIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <circle cx="6" cy="5.5" r="2.3" />
            <path d="M2 13c0-2.2 1.8-3.6 4-3.6 1 0 1.9.3 2.6.8" />
            <path d="M12 9.5v4M10 11.5h4" />
        </Svg>
    );
}

export function InviteIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <rect x="2.5" y="4" width="11" height="8.5" rx="1.6" />
            <path d="M3 5.2 8 8.8l5-3.6" />
        </Svg>
    );
}

export function CloseIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <path d="M4 4l8 8M12 4l-8 8" />
        </Svg>
    );
}

export function ChatIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <path d="M2.5 4.5A2 2 0 0 1 4.5 2.5h7a2 2 0 0 1 2 2v4.6a2 2 0 0 1-2 2H7l-3 2.4v-2.4h-.5a1 1 0 0 1-1-1z" />
        </Svg>
    );
}

export function CheckIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
        </Svg>
    );
}

export function MinusIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <path d="M3.5 8h9" />
        </Svg>
    );
}

export function BugIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <rect x="5" y="5" width="6" height="7" rx="3" />
            <path d="M5 8H2.5M13.5 8H11M5.5 5.5 3.5 3.5M10.5 5.5l2-2M5 11l-2 2M11 11l2 2" />
        </Svg>
    );
}

export function WarningIcon({ className }: IconProps): JSX.Element {
    return (
        <Svg className={className}>
            <path d="M8 2.8 14 13H2z" />
            <path d="M8 6.6v3.1M8 11.4v.2" />
        </Svg>
    );
}
