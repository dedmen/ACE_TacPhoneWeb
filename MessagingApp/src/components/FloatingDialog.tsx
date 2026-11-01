import type { JSX, ReactNode } from 'react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

import theme from '../styles/theme.module.css';
import { CloseIcon } from './icons';
import { t } from '../i18n';
import styles from './FloatingDialog.module.css';

interface FloatingDialogProps {
    title: string;
    subtitle?: string;
    /** Called on Escape, the close button and a backdrop click. */
    onClose(): void;
    /** Body; the only scrollable region of the dialog. */
    children: ReactNode;
    /** Pinned footer, normally the Cancel/Confirm buttons. */
    footer?: ReactNode;
    /** Wider layout for the participant list of a room. */
    wide?: boolean;
    /** Optional leading element of the header (an icon or avatar). */
    leading?: ReactNode;
}

/**
 * Modal dialog rendered into `document.body`.
 *
 * Portalling keeps it outside the flexlayout tree, so it is never clipped by a
 * panel and works when the Messenger panel is only a few hundred pixels wide.
 * The z-index sits above notifications (900) and below the host target chooser
 * (1000), so a card that routes to another app can close its dialogs and let the
 * host chooser win.
 */
export function FloatingDialog({
    title,
    subtitle,
    onClose,
    children,
    footer,
    wide = false,
    leading,
}: FloatingDialogProps): JSX.Element {
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return;

            // Capture phase: the dialog is the innermost modal, so it consumes
            // Escape before the layout does anything with it.
            event.stopPropagation();
            event.preventDefault();
            onClose();
        };

        document.addEventListener('keydown', handleKeyDown, true);

        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [onClose]);

    return createPortal(
        <div
            className={`${theme.theme} ${styles.backdrop}`}
            onPointerDown={event => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                className={`${styles.dialog} ${wide ? styles.dialogWide : ''}`}
                role="dialog"
                aria-modal="true"
                aria-label={title}
            >
                <header className={styles.header}>
                    {leading && <div className={styles.leading}>{leading}</div>}
                    <div className={styles.heading}>
                        <h2 className={styles.title}>{title}</h2>
                        {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
                    </div>
                    <button type="button" className={styles.close} aria-label={t('str_disp_close')} onClick={onClose}>
                        <CloseIcon className={styles.closeIcon} />
                    </button>
                </header>
                <div className={styles.body}>{children}</div>
                {footer && <footer className={styles.footer}>{footer}</footer>}
            </div>
        </div>,
        document.body,
    );
}

interface DialogActionsProps {
    children: ReactNode;
}

/** Right-aligned footer button row. */
export function DialogActions({ children }: DialogActionsProps): JSX.Element {
    return <div className={styles.actions}>{children}</div>;
}
