import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MarkerColor } from './MarkerLayer';
import {
    MIN_MARKER_COLOR_ALPHA,
    clampMarkerAlpha,
    hexToMarkerColor,
    isBlackMarkerColor,
    markerColorToCss,
    markerColorToHex,
    parseMarkerColor,
    rgbToMarkerColor,
} from './MarkerColorUtils';
import ColorStyle from './ColorSwatchPicker.module.scss';
import { t } from '../i18n';

export interface ColorSwatchPickerProps {
    /** Colors from the game's CfgMarkerColors. */
    colors: MarkerColor[];
    /** CfgMarkerColors class name of the selected color, or the default key. */
    selectedColor: string;
    /** Called with the CfgMarkerColors class name. */
    onSelect: (className: string) => void;
    /** Smaller swatches for the marker dialog. */
    compact?: boolean;
    /**
     * Virtual first swatch that means "marker type default". Its color is the
     * currently selected marker type's `color[]`, and it selects `Default`.
     */
    leadingDefault?: { color: string; label: string } | null;
    /** Hides one real CfgMarkerColors class (the marker dialog hides `Default`). */
    excludeClassName?: string;
    /** Adds the "Custom" swatch and its color/alpha popover. */
    onCustomColorChange?: (markerColor: string) => void;
    /** Last custom color, so the picker reopens on it. */
    customColor?: string;
    testId?: string;
    swatchTestId?: string;
    customTestId?: string;
    customInputTestId?: string;
    customAlphaTestId?: string;
    customPopoverTestId?: string;
    ariaLabel?: string;
}

interface SwatchEntry {
    className: string;
    label: string;
    color: string;
    isDefault: boolean;
}

interface PopoverPosition {
    left: number;
    top?: number;
    bottom?: number;
    width: number;
}

const POPOVER_WIDTH = 148;
const POPOVER_HEIGHT = 70;
const POPOVER_MARGIN = 6;

export function ColorSwatchPicker({
    colors,
    selectedColor,
    onSelect,
    compact = false,
    leadingDefault = null,
    excludeClassName,
    onCustomColorChange,
    customColor,
    testId,
    swatchTestId,
    customTestId,
    customInputTestId,
    customAlphaTestId,
    customPopoverTestId,
    ariaLabel = t('str_3den_marker_attribute_color_displayname'),
}: ColorSwatchPickerProps): React.JSX.Element {
    const customButtonRef = useRef<HTMLButtonElement>(null);
    const customPopoverRef = useRef<HTMLDivElement>(null);
    const colorInputRef = useRef<HTMLInputElement>(null);
    const [customOpen, setCustomOpen] = useState(false);
    const [customPosition, setCustomPosition] = useState<PopoverPosition | null>(null);
    const customRgba = parseMarkerColor(selectedColor);
    const customActive = customRgba !== undefined;
    const customInputValue = markerColorToHex(selectedColor)
        ?? markerColorToHex(customColor)
        ?? '#ffffff';
    // A type whose color[] is black must not show its virtual default next to
    // the real black CfgMarkerColors entry: two identical swatches are noise.
    const hideLeadingDefault = leadingDefault !== null && isBlackMarkerColor(leadingDefault.color);
    const entries: SwatchEntry[] = [];

    if (leadingDefault && !hideLeadingDefault) {
        entries.push({
            className: 'Default',
            label: leadingDefault.label,
            color: leadingDefault.color,
            isDefault: true,
        });
    }

    for (const color of colors) {
        if (excludeClassName !== undefined && color.className === excludeClassName) {
            continue;
        }

        entries.push({
            className: color.className,
            label: color.name || color.className,
            color: color.color,
            isDefault: false,
        });
    }

    // With the virtual default hidden, show a real black class as selected while
    // the value still means "type default" (both resolve to the same black).
    const fallbackSelected = hideLeadingDefault && selectedColor === 'Default'
        ? entries.find((entry) => isBlackMarkerColor(entry.color))?.className
        : undefined;

    const updateCustomPosition = useCallback((): void => {
        const trigger = customButtonRef.current;
        if (!trigger) {
            return;
        }

        const rect = trigger.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom - POPOVER_MARGIN;
        const spaceAbove = rect.top - POPOVER_MARGIN;
        const placeAbove = spaceBelow < POPOVER_HEIGHT && spaceAbove > spaceBelow;
        const width = Math.min(POPOVER_WIDTH, Math.max(120, window.innerWidth - 2 * POPOVER_MARGIN));
        const left = Math.min(
            Math.max(POPOVER_MARGIN, rect.left),
            Math.max(POPOVER_MARGIN, window.innerWidth - width - POPOVER_MARGIN),
        );

        setCustomPosition(placeAbove
            ? { left, bottom: Math.max(POPOVER_MARGIN, window.innerHeight - rect.top + 4), width }
            : { left, top: rect.bottom + 4, width });
    }, []);

    useLayoutEffect(() => {
        if (!customOpen) {
            return;
        }

        updateCustomPosition();
        const frame = window.requestAnimationFrame(updateCustomPosition);
        return () => window.cancelAnimationFrame(frame);
    }, [customOpen, updateCustomPosition]);

    useEffect(() => {
        if (!customOpen) {
            return;
        }

        const handlePointerDown = (event: PointerEvent): void => {
            const target = event.target as Node | null;
            if (!target) {
                return;
            }

            if (customButtonRef.current?.contains(target) || customPopoverRef.current?.contains(target)) {
                return;
            }

            setCustomOpen(false);
        };

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') {
                return;
            }

            // Escape closes the popover only; the dialog that contains the
            // picker must stay open.
            event.stopImmediatePropagation();
            setCustomOpen(false);
        };

        const handleViewportChange = (): void => updateCustomPosition();

        document.addEventListener('pointerdown', handlePointerDown, true);
        document.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('resize', handleViewportChange);
        window.addEventListener('scroll', handleViewportChange, true);

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
            document.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('resize', handleViewportChange);
            window.removeEventListener('scroll', handleViewportChange, true);
        };
    }, [customOpen, updateCustomPosition]);

    const customCss = customActive ? markerColorToCss(selectedColor) : undefined;
    const alphaValue = clampMarkerAlpha(customRgba?.a ?? 1);

    return (
        <div
            className={`${ColorStyle.grid}${compact ? ` ${ColorStyle.compact}` : ''}`}
            role="group"
            aria-label={ariaLabel}
            data-testid={testId}
        >
            {entries.map((entry) => {
                const isSelected = entry.className === selectedColor
                    || (!hideLeadingDefault && entry.className === 'Default' && selectedColor === 'Default')
                    || entry.className === fallbackSelected;

                return (
                    <button
                        key={entry.className}
                        type="button"
                        className={`${ColorStyle.swatch}${isSelected ? ` ${ColorStyle.selected}` : ''}`}
                        style={{ backgroundColor: entry.color }}
                        title={entry.label}
                        aria-label={entry.label}
                        aria-pressed={isSelected}
                        data-color-class={entry.className}
                        data-color-default={entry.isDefault ? 'true' : undefined}
                        data-testid={swatchTestId}
                        onClick={() => onSelect(entry.className)}
                    />
                );
            })}
            {onCustomColorChange && (
                <>
                    <button
                        ref={customButtonRef}
                        type="button"
                        className={`${ColorStyle.swatch} ${ColorStyle.custom}${customActive ? ` ${ColorStyle.selected}` : ''}`}
                        style={customCss ? { background: customCss } : undefined}
                        title={t('STR_3DEN_Group_Mode_Custom')}
                        aria-label={t('STR_3DEN_Group_Mode_Custom')}
                        aria-pressed={customActive}
                        aria-expanded={customOpen}
                        data-color-class="Custom"
                        data-testid={customTestId}
                        onClick={() => {
                            if (customOpen) {
                                setCustomOpen(false);
                                return;
                            }

                            setCustomOpen(true);
                        }}
                    />
                    {customOpen && customPosition && createPortal(
                        <div
                            ref={customPopoverRef}
                            className={ColorStyle.custom_popover}
                            style={{
                                position: 'fixed',
                                left: customPosition.left,
                                ...(customPosition.top === undefined
                                    ? { bottom: customPosition.bottom }
                                    : { top: customPosition.top }),
                                width: customPosition.width,
                            }}
                            role="dialog"
                            aria-label={t('STR_ACE_Tacphone_Map_ColorPicker_CustomColor')}
                            data-testid={customPopoverTestId}
                        >
                            <label className={ColorStyle.custom_color_row}>
                                <span>{t('str_3den_marker_attribute_color_displayname')}</span>
                                <input
                                    ref={colorInputRef}
                                    className={ColorStyle.custom_color_input}
                                    type="color"
                                    value={customInputValue}
                                    data-testid={customInputTestId}
                                    onChange={(event) => {
                                        const next = hexToMarkerColor(event.target.value, alphaValue);
                                        if (next)
                                            onCustomColorChange(next);
                                    }}
                                />
                            </label>
                            <label className={ColorStyle.alpha}>
                                <span>{t('str_3den_marker_attribute_alpha_displayname')}</span>
                                <input
                                    type="range"
                                    min={MIN_MARKER_COLOR_ALPHA}
                                    max={1}
                                    step={0.01}
                                    value={alphaValue}
                                    aria-label={t('STR_ACE_Tacphone_Map_ColorPicker_AlphaAria')}
                                    data-testid={customAlphaTestId}
                                    onChange={(event) => onCustomColorChange(rgbToMarkerColor(
                                        (customRgba?.r ?? 1) * 255,
                                        (customRgba?.g ?? 1) * 255,
                                        (customRgba?.b ?? 1) * 255,
                                        Number(event.target.value),
                                    ))}
                                />
                                <span className={ColorStyle.alpha_value}>
                                    {Math.round(alphaValue * 100)}%
                                </span>
                            </label>
                        </div>,
                        document.body,
                    )}
                </>
            )}
        </div>
    );
}
