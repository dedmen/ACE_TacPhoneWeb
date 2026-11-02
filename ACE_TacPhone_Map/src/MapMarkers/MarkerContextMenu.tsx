import React, { useEffect, useRef } from 'react';
import MenuStyle from './MarkerContextMenu.module.scss';
import { t } from '../i18n';

// A tap that opens the menu ends with a pointerup; browsers then derive a click
// for the same tap, which could land on a menu item that appeared under the
// finger. Everything in that window is ignored.
const OPEN_GUARD_MS = 150;

interface MarkerContextMenuProps {
    /** X position in pixels, relative to the map container. */
    x: number;
    /** Y position in pixels, relative to the map container. */
    y: number;
    onEdit: () => void;
    onDelete: () => void;
    /**
     * Share the marker through the Messenger app. Only rendered when
     * {@link MarkerContextMenuProps.canShare} is true.
     */
    onShare?: () => void;
    /** True for a shareable marker while the Messenger app is installed. */
    canShare?: boolean;
    /** Target kind; polylines get their own heading and edit label. */
    kind?: 'marker' | 'polyline';
    /** Point markers and polylines can be edited; read-only ones cannot. */
    canEdit?: boolean;
    canDelete?: boolean;
    onClose: () => void;
}

/**
 * Small context menu for a player-created marker.
 *
 * Activation uses pointerdown+pointerup on the item instead of click: the tap
 * that opened the menu fires pointerup (not pointerdown) before the menu
 * exists, so a fresh press is required to activate anything. Keyboard
 * activation still works through click, which reports detail === 0.
 */
export function MarkerContextMenu({
    x,
    y,
    onEdit,
    onDelete,
    onShare,
    canShare = false,
    kind = 'marker',
    canEdit = true,
    canDelete = true,
    onClose,
}: MarkerContextMenuProps): React.JSX.Element {
    const menuRef = useRef<HTMLDivElement>(null);
    const openedAtRef = useRef(0);
    const pressedRef = useRef<string | null>(null);
    const isPolyline = kind === 'polyline';
    const heading = isPolyline
        ? t('STR_ACE_Tacphone_Map_ContextMenu_Polyline')
        : t('STR_3DEN_Marker_textSingular');
    const editLabel = isPolyline
        ? t('STR_ACE_Tacphone_Map_ContextMenu_EditPolyline')
        : t('str_arcmark_title2');

    useEffect(() => {
        openedAtRef.current = Date.now();
    }, []);

    const isOpenGuardActive = (): boolean => Date.now() - openedAtRef.current < OPEN_GUARD_MS;

    useEffect(() => {
        const handleDocumentPointerDown = (event: PointerEvent): void => {
            const menu = menuRef.current;
            if (menu && !menu.contains(event.target as Node)) {
                onClose();
            }
        };

        const handleDocumentKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                onClose();
            }
        };

        document.addEventListener('pointerdown', handleDocumentPointerDown, true);
        document.addEventListener('keydown', handleDocumentKeyDown);
        return () => {
            document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
            document.removeEventListener('keydown', handleDocumentKeyDown);
        };
    }, [onClose]);

    /** Runs the menu action named by a button's `data-action`. */
    const runAction = (action: string): void => {
        if (action === 'share') {
            onShare?.();
        } else if (action === 'edit') {
            onEdit();
        } else {
            onDelete();
        }
    };

    const handleItemPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        if (isOpenGuardActive()) {
            return;
        }

        pressedRef.current = event.currentTarget.dataset.action ?? null;
    };

    const handleItemPointerUp = (event: React.PointerEvent<HTMLButtonElement>): void => {
        event.stopPropagation();

        const action = pressedRef.current;
        pressedRef.current = null;

        if (!action || action !== event.currentTarget.dataset.action || isOpenGuardActive()) {
            return;
        }

        event.preventDefault();
        runAction(action);
    };

    const handleItemClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
        // Pointer clicks are handled by pointerdown+pointerup above. Only
        // keyboard activation (detail === 0) reaches this path.
        if (event.detail !== 0 || isOpenGuardActive()) {
            return;
        }

        runAction(event.currentTarget.dataset.action ?? '');
    };

    return (
        <div
            ref={menuRef}
            className={MenuStyle.menu}
            style={{ left: x, top: y }}
            role="menu"
            aria-label={heading}
        >
            <div className={MenuStyle.heading}>{heading}</div>
            {canShare && onShare !== undefined && (
                <button
                    type="button"
                    role="menuitem"
                    data-action="share"
                    className={MenuStyle.item}
                    onPointerDown={handleItemPointerDown}
                    onPointerUp={handleItemPointerUp}
                    onPointerCancel={() => { pressedRef.current = null; }}
                    onPointerLeave={() => { pressedRef.current = null; }}
                    onClick={handleItemClick}
                >
                    {t('STR_ACE_Tacphone_Map_Marker_Menu_Share')}
                </button>
            )}
            <button
                type="button"
                role="menuitem"
                data-action="edit"
                className={MenuStyle.item}
                style={canEdit ? undefined : { display: 'none' }}
                onPointerDown={handleItemPointerDown}
                onPointerUp={handleItemPointerUp}
                onPointerCancel={() => { pressedRef.current = null; }}
                onPointerLeave={() => { pressedRef.current = null; }}
                onClick={handleItemClick}
            >
                {editLabel}
            </button>
            <button
                type="button"
                role="menuitem"
                data-action="delete"
                className={`${MenuStyle.item} ${MenuStyle.item_danger}`}
                style={canDelete ? undefined : { display: 'none' }}
                onPointerDown={handleItemPointerDown}
                onPointerUp={handleItemPointerUp}
                onPointerCancel={() => { pressedRef.current = null; }}
                onPointerLeave={() => { pressedRef.current = null; }}
                onClick={handleItemClick}
            >
                {t('STR_ACE_Tacphone_Map_Marker_Menu_Delete')}
            </button>
        </div>
    );
}
