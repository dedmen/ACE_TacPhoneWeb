// Reusable listbox select for the host UI and for apps.
//
// The opened menu is portaled to `document.body` and positioned with
// `position: fixed`, so it never changes the layout of the panel or dialog that
// owns the trigger and never adds a scrollbar to it. The menu floats above every
// other host surface (the marker dialog uses z-index 2000).

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SelectMenuProps, SelectOption } from '@ace-tacphone/api';

import styles from './SelectMenu.module.css';

/** Space kept free around the menu inside the viewport. */
const VIEWPORT_MARGIN = 8;
/** Maximum menu height before it scrolls internally. */
const MAX_MENU_HEIGHT = 300;
/** Minimum height worth opening for; below this the menu flips above. */
const MIN_MENU_HEIGHT = 140;

interface MenuPosition {
    left: number;
    /** Distance from the viewport top, when the menu opens below the trigger. */
    top?: number;
    /** Distance from the viewport bottom, when the menu flips above the trigger. */
    bottom?: number;
    width: number;
    maxHeight: number;
}

function isDisabled(option: SelectOption): boolean {
    return option.disabled === true;
}

function matchesQuery(option: SelectOption, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
        return true;
    }

    return option.label.toLowerCase().includes(needle) || String(option.value).toLowerCase().includes(needle);
}

function defaultOptionContent(option: SelectOption): React.ReactNode {
    return (
        <>
            {option.swatch && (
                <span className={styles.swatch} style={{ backgroundColor: option.swatch }} />
            )}
            {option.icon && (
                <span
                    className={styles.icon}
                    style={{
                        backgroundColor: option.iconColor ?? 'currentColor',
                        WebkitMaskImage: `url("${option.icon}")`,
                        maskImage: `url("${option.icon}")`,
                    }}
                />
            )}
            <span className={styles.label}>{option.label}</span>
        </>
    );
}

export function SelectMenu({
    id,
    value,
    options,
    onChange,
    placeholder = 'Select…',
    disabled = false,
    searchable = false,
    searchPlaceholder = 'Search…',
    size = 'normal',
    className,
    buttonClassName,
    menuClassName,
    optionClassName,
    renderOption,
    renderValue,
    testId,
    ariaLabel,
    emptyMessage = 'No matches',
}: SelectMenuProps): React.JSX.Element {
    const generatedId = useId();
    const triggerId = id ?? `select-menu-${generatedId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const menuId = `${triggerId}-menu`;

    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(-1);
    const [position, setPosition] = useState<MenuPosition | null>(null);

    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    const selected = useMemo(
        () => options.find((option) => Object.is(option.value, value)),
        [options, value],
    );

    const filtered = useMemo(
        () => (searchable ? options.filter((option) => matchesQuery(option, query)) : options),
        [options, query, searchable],
    );

    const close = useCallback((returnFocus: boolean): void => {
        setOpen(false);
        setQuery('');
        setActiveIndex(-1);
        setPosition(null);

        if (returnFocus) {
            triggerRef.current?.focus();
        }
    }, []);

    const choose = useCallback((option: SelectOption | undefined): void => {
        if (!option || isDisabled(option)) {
            return;
        }

        onChange(option.value);
        close(true);
    }, [close, onChange]);

    const openMenu = useCallback((): void => {
        if (disabled) {
            return;
        }

        const selectedIndex = options.findIndex((option) => Object.is(option.value, value));
        setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
        setQuery('');
        setOpen(true);
    }, [disabled, options, value]);

    const moveActive = useCallback((delta: number): void => {
        setActiveIndex((previous) => {
            if (filtered.length === 0) {
                return -1;
            }

            const start = previous < 0 ? (delta > 0 ? -1 : 0) : previous;
            let next = start;

            // Skip disabled rows, but stop when every row is disabled.
            for (let step = 0; step < filtered.length; step += 1) {
                next = (next + delta + filtered.length) % filtered.length;
                if (!isDisabled(filtered[next])) {
                    return next;
                }
            }

            return previous;
        });
    }, [filtered]);

    // Position the fixed menu from the trigger's viewport rect.
    const updatePosition = useCallback((): void => {
        const trigger = triggerRef.current;
        if (!trigger) {
            return;
        }

        const rect = trigger.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
        const spaceAbove = rect.top - VIEWPORT_MARGIN;
        const placeAbove = spaceBelow < MIN_MENU_HEIGHT && spaceAbove > spaceBelow;
        const available = Math.max(MIN_MENU_HEIGHT, placeAbove ? spaceAbove : spaceBelow);
        const maxHeight = Math.min(MAX_MENU_HEIGHT, available);
        const width = Math.max(rect.width, 120);
        const left = Math.min(
            Math.max(VIEWPORT_MARGIN, rect.left),
            Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
        );

        setPosition(placeAbove
            ? {
                left,
                bottom: Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.top + 2),
                width,
                maxHeight,
            }
            : {
                left,
                top: rect.bottom + 2,
                width,
                maxHeight,
            });
    }, []);

    useLayoutEffect(() => {
        if (!open) {
            return;
        }

        updatePosition();
        // The first pass happens before the menu exists, so it can only use the
        // trigger rect; a second pass after mount picks up fonts/scrollbars.
        const frame = window.requestAnimationFrame(updatePosition);

        return () => window.cancelAnimationFrame(frame);
    }, [open, updatePosition]);

    // Keep the menu attached to the trigger while the page scrolls or resizes.
    useEffect(() => {
        if (!open) {
            return;
        }

        const handleViewportChange = (): void => updatePosition();

        window.addEventListener('resize', handleViewportChange);
        window.addEventListener('scroll', handleViewportChange, true);

        return () => {
            window.removeEventListener('resize', handleViewportChange);
            window.removeEventListener('scroll', handleViewportChange, true);
        };
    }, [open, updatePosition]);

    // Focus the filter field on open; the trigger keeps focus otherwise.
    // autoFocus alone runs before the portal is committed in some browsers, so
    // focus on the next frame as well.
    useLayoutEffect(() => {
        if (!open || !searchable) {
            return;
        }

        const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
        return () => window.cancelAnimationFrame(frame);
    }, [open, searchable]);

    // Outside click: the menu lives in a portal, so check both refs.
    useEffect(() => {
        if (!open) {
            return;
        }

        const handlePointerDown = (event: PointerEvent): void => {
            const target = event.target as Node | null;
            if (!target) {
                return;
            }

            if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
                return;
            }

            close(false);
        };

        document.addEventListener('pointerdown', handlePointerDown, true);
        return () => document.removeEventListener('pointerdown', handlePointerDown, true);
    }, [open, close]);

    // Keyboard handling while the menu is open, from the trigger or the filter.
    useEffect(() => {
        if (!open) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent): void => {
            switch (event.key) {
                case 'Escape':
                    event.preventDefault();
                    // Capture-phase stop so an enclosing dialog does not also
                    // close itself on the same Escape.
                    event.stopPropagation();
                    close(true);
                    return;

                case 'Tab':
                    // Let focus leave naturally; the menu closes behind it.
                    close(false);
                    return;

                case 'ArrowDown':
                    event.preventDefault();
                    event.stopPropagation();
                    moveActive(1);
                    return;

                case 'ArrowUp':
                    event.preventDefault();
                    event.stopPropagation();
                    moveActive(-1);
                    return;

                case 'Home':
                    event.preventDefault();
                    event.stopPropagation();
                    setActiveIndex(filtered.length > 0 ? 0 : -1);
                    return;

                case 'End':
                    event.preventDefault();
                    event.stopPropagation();
                    setActiveIndex(filtered.length > 0 ? filtered.length - 1 : -1);
                    return;

                case 'Enter':
                case ' ': {
                    // Space typed into the filter is text, not a selection.
                    if (event.key === ' ' && event.target === searchRef.current) {
                        return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    choose(filtered[activeIndex]);
                    return;
                }

                default:
                    return;
            }
        };

        document.addEventListener('keydown', handleKeyDown, true);
        return () => document.removeEventListener('keydown', handleKeyDown, true);
    }, [open, close, moveActive, choose, filtered, activeIndex]);

    const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
        if (open) {
            return;
        }

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openMenu();
        }
    };

    const triggerClassName = [
        styles.trigger,
        size === 'compact' ? styles.triggerCompact : '',
        open ? styles.triggerOpen : '',
        buttonClassName ?? '',
    ].filter(Boolean).join(' ');

    const menuClassNameValue = [
        styles.menu,
        size === 'compact' ? styles.menuCompact : '',
        menuClassName ?? '',
    ].filter(Boolean).join(' ');

    const optionClassNameValue = [
        styles.option,
        optionClassName ?? '',
    ].filter(Boolean).join(' ');

    return (
        <span className={[styles.wrapper, className ?? ''].filter(Boolean).join(' ')}>
            <button
                ref={triggerRef}
                id={triggerId}
                type="button"
                className={triggerClassName}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                aria-label={ariaLabel}
                data-testid={testId}
                data-open={open ? 'true' : 'false'}
                data-size={size}
                disabled={disabled}
                onClick={() => (open ? close(true) : openMenu())}
                onKeyDown={handleTriggerKeyDown}
            >
                <span className={styles.value}>
                    {renderValue
                        ? renderValue(selected)
                        : (selected ? defaultOptionContent(selected) : placeholder)}
                </span>
                <span className={styles.chevron} aria-hidden="true" />
            </button>

            {open && position && createPortal(
                <div
                    ref={menuRef}
                    id={menuId}
                    className={menuClassNameValue}
                    role="listbox"
                    aria-label={ariaLabel}
                    data-dropdown-menu
                    data-testid={testId ? `${testId}-menu` : undefined}
                    style={{
                        position: 'fixed',
                        left: position.left,
                        ...(position.top === undefined ? { bottom: position.bottom } : { top: position.top }),
                        width: position.width,
                        maxHeight: position.maxHeight,
                    }}
                >
                    {searchable && (
                        <input
                            ref={searchRef}
                            className={styles.search}
                            type="search"
                            value={query}
                            placeholder={searchPlaceholder}
                            autoFocus
                            data-testid="select-menu-search"
                            onChange={(event) => {
                                setQuery(event.target.value);
                                setActiveIndex(0);
                            }}
                            onKeyDown={(event) => {
                                // The document listener handles navigation; this
                                // only stops the form-less input from submitting.
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                }
                            }}
                        />
                    )}

                    <div className={styles.options} data-testid="select-menu-options">
                        {filtered.map((option, index) => (
                            <button
                                key={`${String(option.value)}:${index}`}
                                type="button"
                                role="option"
                                className={`${optionClassNameValue}${index === activeIndex ? ` ${styles.optionActive}` : ''}${isDisabled(option) ? ` ${styles.optionDisabled}` : ''}`}
                                aria-selected={Object.is(option.value, value)}
                                aria-disabled={isDisabled(option) ? true : undefined}
                                title={option.label}
                                data-testid={`select-menu-option-${String(option.value)}`}
                                disabled={isDisabled(option)}
                                onMouseEnter={() => setActiveIndex(index)}
                                onClick={() => choose(option)}
                            >
                                {renderOption ? renderOption(option) : defaultOptionContent(option)}
                            </button>
                        ))}

                        {filtered.length === 0 && (
                            <div className={styles.empty}>{emptyMessage}</div>
                        )}
                    </div>
                </div>,
                document.body,
            )}
        </span>
    );
}
