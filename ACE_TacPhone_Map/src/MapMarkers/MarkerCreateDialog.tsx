import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SelectOption } from '@ace-tacphone/api';
import type { MarkerColor, MarkerType } from './MarkerLayer';
import type { MarkerCreationData } from './MarkerApi';
import type { MarkerChannel } from './Channels';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import {
    DEFAULT_MARKER_COLOR,
    MAX_MARKER_TEXT_LENGTH,
    clampMarkerText,
    isDefaultMarkerColor,
    parseMarkerColor,
    resolveMarkerColor,
} from './MarkerColorUtils';
import DialogStyle from './MarkerCreateDialog.module.scss';
import { t } from '../i18n';

export interface MarkerDialogDraft {
    position: [number, number];
    label: string;
    type: string;
    color: string;
    dir: number;
    size: number;
    channel: number;
}

interface MarkerCreateDialogProps {
    mode: 'create' | 'edit';
    coordinate: [number, number];
    markerTypes: MarkerType[];
    markerColors: MarkerColor[];
    channels: MarkerChannel[];
    multiplayer: boolean;
    loadMarkerIcon: (iconPath: string) => Promise<string>;
    onSubmit: (marker: MarkerCreationData) => void;
    onCancel: () => void;
    /** Pre-filled values when the dialog edits an existing marker. */
    initialLabel?: string;
    initialType?: string;
    initialColor?: string;
    initialDir?: number;
    initialScale?: number;
    initialChannel?: number;
    /** Marker position in pixels relative to the map container. */
    anchor: { x: number; y: number } | null;
    containerSize: { width: number; height: number };
    onChannelChange?: (channel: number) => void;
    onDraftChange?: (draft: MarkerDialogDraft) => void;
    /** Accessible name of the dialog. */
    title?: string;
    submitLabel?: string;
}

// Icons are cached module wide, so reopening the menu is instant.
const markerIconCache = new Map<string, string>();
const tintedIconCache = new Map<string, string>();

/** Parses the small CSS color subset used by marker colors. */
function parsePreviewColor(value: string): [number, number, number, number] {
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(value.trim());
    if (hex) {
        return [
            Number.parseInt(hex[1], 16),
            Number.parseInt(hex[2], 16),
            Number.parseInt(hex[3], 16),
            hex[4] === undefined ? 1 : Number.parseInt(hex[4], 16) / 255,
        ];
    }

    const rgb = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i.exec(value.trim());
    if (rgb) {
        return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
    }

    return [255, 255, 255, 1];
}

/**
 * Multiplies the icon's pixels by the resolved marker color, matching the
 * OpenLayers Icon tint used on the map. CSS masks flatten the icon to one solid
 * color (and can show a white box when the source is a white flag), so the
 * preview is rendered as a tinted PNG instead.
 */
function tintMarkerIcon(imageUrl: string, color: string): Promise<string> {
    const cacheKey = `${imageUrl}|${color}`;
    const cached = tintedIconCache.get(cacheKey);
    if (cached) {
        return Promise.resolve(cached);
    }

    return new Promise<string>((resolve) => {
        const image = new Image();

        image.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, image.naturalWidth);
                canvas.height = Math.max(1, image.naturalHeight);
                const context = canvas.getContext('2d');
                if (!context) {
                    resolve(imageUrl);
                    return;
                }

                context.drawImage(image, 0, 0);
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
                const [red, green, blue, alpha] = parsePreviewColor(color);

                for (let index = 0; index < pixels.data.length; index += 4) {
                    pixels.data[index] = Math.round((pixels.data[index] * red) / 255);
                    pixels.data[index + 1] = Math.round((pixels.data[index + 1] * green) / 255);
                    pixels.data[index + 2] = Math.round((pixels.data[index + 2] * blue) / 255);
                    pixels.data[index + 3] = Math.round(pixels.data[index + 3] * alpha);
                }

                context.putImageData(pixels, 0, 0);
                const tinted = canvas.toDataURL('image/png');
                tintedIconCache.set(cacheKey, tinted);
                resolve(tinted);
            } catch {
                resolve(imageUrl);
            }
        };

        image.onerror = () => resolve(imageUrl);
        image.src = imageUrl;
    });
}

interface MarkerIconPreviewProps {
    icon: string;
    color: string;
    loadMarkerIcon: (iconPath: string) => Promise<string>;
    /** Only start loading the texture once the preview is scrolled into view. */
    lazy?: boolean;
}

function MarkerIconPreview({ icon, color, loadMarkerIcon, lazy = false }: MarkerIconPreviewProps): React.JSX.Element {
    const hostRef = useRef<HTMLSpanElement>(null);
    const [isVisible, setIsVisible] = useState(!lazy);
    const [imageUrl, setImageUrl] = useState<string | null>(() => (icon ? markerIconCache.get(icon) ?? null : null));
    const [tintedUrl, setTintedUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!lazy) {
            setIsVisible(true);
            return;
        }

        const host = hostRef.current;
        if (!host || typeof IntersectionObserver === 'undefined') {
            setIsVisible(true);
            return;
        }

        // The select menu is portaled to <body>; its menu element carries
        // `data-dropdown-menu` so only visible rows load their texture.
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                setIsVisible(true);
                observer.disconnect();
            }
        }, {
            root: host.closest('[data-dropdown-menu]'),
            rootMargin: '40px',
        });

        observer.observe(host);
        return () => observer.disconnect();
    }, [lazy]);

    useEffect(() => {
        if (!icon) {
            setImageUrl(null);
            return;
        }

        if (!isVisible) {
            return;
        }

        const cached = markerIconCache.get(icon);
        if (cached) {
            setImageUrl(cached);
            return;
        }

        let cancelled = false;
        setImageUrl(null);

        loadMarkerIcon(icon).then((url) => {
            markerIconCache.set(icon, url);
            if (!cancelled) {
                setImageUrl(url);
            }
        }).catch(() => {
            if (!cancelled) {
                setImageUrl(null);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [icon, isVisible, loadMarkerIcon]);

    useEffect(() => {
        if (!imageUrl) {
            setTintedUrl(null);
            return;
        }

        let cancelled = false;
        void tintMarkerIcon(imageUrl, color).then((url) => {
            if (!cancelled) {
                setTintedUrl(url);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [imageUrl, color]);

    return (
        <span ref={hostRef} className={DialogStyle.icon_preview}>
            {imageUrl ? (
                <img
                    className={DialogStyle.icon_image}
                    src={tintedUrl ?? imageUrl}
                    alt=""
                />
            ) : (
                <span className={DialogStyle.icon_placeholder} />
            )}
        </span>
    );
}

// Remember the last type/color chosen while creating. Module scope keeps it
// for the current page session; the sandbox has no localStorage.
let rememberedMarkerType = '';
let rememberedMarkerColor = '';

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function MarkerCreateDialog({
    mode,
    coordinate,
    markerTypes,
    markerColors,
    channels,
    multiplayer,
    loadMarkerIcon,
    onSubmit,
    onCancel,
    initialLabel = '',
    initialType = '',
    initialColor = '',
    initialDir = 0,
    initialScale = 1,
    initialChannel,
    anchor,
    containerSize,
    onChannelChange,
    onDraftChange,
    title = t('STR_ACE_Tacphone_Map_MarkerDialog_AddTitle'),
    submitLabel = t('STR_A3_RscDisplayMain_Spotlight_Create'),
}: MarkerCreateDialogProps): React.JSX.Element {
    const SelectMenu = window.TacPhone.components.SelectMenu;

    const [label, setLabel] = useState(initialLabel);
    const [selectedType, setSelectedType] = useState(initialType || rememberedMarkerType || '');
    // "Default" means "use the marker type's own color[]".
    const [selectedColor, setSelectedColor] = useState(initialColor || rememberedMarkerColor || 'Default');
    const [selectedChannel, setSelectedChannel] = useState(initialChannel ?? channels[0]?.id ?? 3);
    const [dir, setDir] = useState(clamp(Number.isFinite(initialDir) ? initialDir : 0, -180, 180));
    const [scale, setScale] = useState(clamp(Number.isFinite(initialScale) ? initialScale : 1, 0.5, 2));
    const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        if (markerTypes.length > 0 && !markerTypes.some((type) => type.className === selectedType)) {
            setSelectedType(markerTypes[0].className);
        }
    }, [markerTypes, selectedType]);

    useEffect(() => {
        if (markerColors.length === 0) {
            return;
        }

        if (isDefaultMarkerColor(selectedColor)) {
            return;
        }

        // A custom RGBA value is not a CfgMarkerColors class name; keep it.
        if (parseMarkerColor(selectedColor)) {
            return;
        }

        if (!markerColors.some((color) => color.className === selectedColor)) {
            setSelectedColor('Default');
        }
    }, [markerColors, selectedColor]);

    useEffect(() => {
        if (mode !== 'create' || channels.length === 0) {
            return;
        }

        if (!channels.some((channel) => channel.id === selectedChannel)) {
            setSelectedChannel(channels[0].id);
        }
    }, [channels, mode, selectedChannel]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                // An open SelectMenu owns Escape: it must close the menu without
                // also closing the dialog that contains the trigger.
                if (document.querySelector('[data-dropdown-menu]'))
                    return;

                onCancel();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onCancel]);

    // Measure the dialog and place it bottom-right of the marker so the icon
    // and its label stay visible. The label is drawn to the right of the icon
    // and above the dialog, so typing never has to move it. Only values that
    // change the dialog's size (scale affects the icon clearance) re-place it.
    useLayoutEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) {
            return;
        }

        const width = dialog.offsetWidth;
        const height = dialog.offsetHeight;
        const containerWidth = Math.max(containerSize.width, width + 24);
        const containerHeight = Math.max(containerSize.height, height + 24);
        const margin = 12;
        // Clear the marker icon at its current scale.
        const gap = 18 + 12 * scale;

        const clampX = (value: number): number => clamp(value, margin, Math.max(margin, containerWidth - width - margin));
        const clampY = (value: number): number => clamp(value, margin, Math.max(margin, containerHeight - height - margin));

        if (!anchor) {
            setPlacement({
                left: clampX((containerWidth - width) / 2),
                top: clampY((containerHeight - height) / 2),
            });
            return;
        }

        const fits = (left: number, top: number): boolean => (
            left >= margin
            && top >= margin
            && left + width <= containerWidth - margin
            && top + height <= containerHeight - margin
        );

        // Preference order: bottom-right, bottom-left, top-right, top-left.
        const candidates: Array<{ left: number; top: number }> = [
            { left: anchor.x + gap, top: anchor.y + gap },
            { left: anchor.x - gap - width, top: anchor.y + gap },
            { left: anchor.x + gap, top: anchor.y - gap - height },
            { left: anchor.x - gap - width, top: anchor.y - gap - height },
        ];

        const chosen = candidates.find((candidate) => fits(candidate.left, candidate.top));

        setPlacement(chosen
            ? { left: chosen.left, top: chosen.top }
            : { left: clampX(anchor.x - width / 2), top: clampY(anchor.y - height / 2) });
        // Content lengths are layout inputs, not values: the dialog can only
        // grow when the color grid or the channel row appears.
    }, [anchor, containerSize, scale, markerColors.length, markerTypes.length, multiplayer]);

    const selectedTypeInfo = markerTypes.find((type) => type.className === selectedType) ?? null;
    // Color the type icons/swatch would get: the selected color, or the
    // selected type's own color[] while "Default" is active.
    const typeDefaultColor = selectedTypeInfo?.color || DEFAULT_MARKER_COLOR;
    const effectiveColor = resolveMarkerColor(
        selectedColor,
        markerColors.find((color) => color.className === selectedColor)?.color,
        typeDefaultColor,
    );

    const canSubmit = selectedType !== '';
    const channelOptions: MarkerChannel[] = channels.slice();
    if (!channelOptions.some((channel) => channel.id === selectedChannel)) {
        channelOptions.unshift({
            id: selectedChannel,
            label: t('STR_ACE_Tacphone_Map_Channel_Number', selectedChannel),
            custom: true,
            mapMarkersEnabled: true,
        });
    }

    const selectType = (className: string): void => {
        setSelectedType(className);
        if (mode === 'create') {
            rememberedMarkerType = className;
        }
    };

    const selectColor = (className: string): void => {
        setSelectedColor(className);
        if (mode === 'create') {
            rememberedMarkerColor = className;
        }
    };

    const selectChannel = (channel: number): void => {
        setSelectedChannel(channel);
        onChannelChange?.(channel);
    };

    useEffect(() => {
        if (!onDraftChange || !selectedType) {
            return;
        }

        onDraftChange({
            position: coordinate,
            label: label.trim(),
            type: selectedType,
            color: selectedColor,
            dir,
            size: scale,
            channel: selectedChannel,
        });
    }, [label, selectedType, selectedColor, dir, scale, selectedChannel, coordinate, onDraftChange]);

    // The in-game browser sandbox has no 'allow-forms', so a real <form> submit is
    // blocked before any handler runs. Submit from button/Enter handlers instead.
    const submit = (): void => {
        if (!canSubmit) return;

        onSubmit({
            label: clampMarkerText(label.trim()),
            type: selectedType,
            color: selectedColor,
            position: coordinate,
            dir,
            size: [scale, scale],
            ...(multiplayer ? { channel: selectedChannel } : {}),
        });
    };

    const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submit();
        }
    };

    const typeOptions: SelectOption[] = markerTypes.map((type) => ({
        value: type.className,
        label: type.name || type.className,
    }));

    const typeColorFor = (option: SelectOption): string => {
        if (!isDefaultMarkerColor(selectedColor)) {
            return effectiveColor;
        }

        return markerTypes.find((type) => type.className === option.value)?.color || DEFAULT_MARKER_COLOR;
    };

    const renderTypeOption = (option: SelectOption): React.ReactNode => (
        <>
            <MarkerIconPreview
                icon={markerTypes.find((type) => type.className === option.value)?.icon ?? ''}
                color={typeColorFor(option)}
                loadMarkerIcon={loadMarkerIcon}
                lazy
            />
            <span className={DialogStyle.option_label}>{option.label}</span>
        </>
    );

    const renderTypeValue = (option: SelectOption | undefined): React.ReactNode => (
        <>
            <MarkerIconPreview
                icon={markerTypes.find((type) => type.className === option?.value)?.icon ?? ''}
                color={effectiveColor}
                loadMarkerIcon={loadMarkerIcon}
            />
            <span className={DialogStyle.option_label}>
                {option ? option.label : (markerTypes.length === 0 ? t('STR_ACE_Tacphone_Map_MarkerDialog_LoadingTypes') : t('STR_ACE_Tacphone_Map_MarkerDialog_SelectType'))}
            </span>
        </>
    );

    const channelSelectOptions: SelectOption[] = channelOptions.map((channel) => ({
        value: channel.id,
        label: channel.label,
    }));

    return (
        <div
            className={DialogStyle.overlay}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onCancel();
                }
            }}
        >
            <div
                ref={dialogRef}
                className={DialogStyle.dialog}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                data-testid="marker-create-dialog"
                style={placement
                    ? { left: placement.left, top: placement.top, visibility: 'visible' }
                    : { left: 0, top: 0, visibility: 'hidden' }}
            >
                <label className={DialogStyle.field}>
                    <span className={DialogStyle.field_label}>{t('STR_ACE_Tacphone_Map_MarkerDialog_NameLabel')}</span>
                    <input
                        ref={inputRef}
                        className={DialogStyle.text_input}
                        type="text"
                        value={label}
                        maxLength={MAX_MARKER_TEXT_LENGTH}
                        placeholder={t('STR_ACE_Tacphone_Map_MarkerDialog_NamePlaceholder')}
                        onChange={(event) => setLabel(event.target.value)}
                        onKeyDown={handleInputKeyDown}
                    />
                </label>

                <div className={DialogStyle.field}>
                    <span className={DialogStyle.field_label}>{t('STR_ACE_Tacphone_Map_MarkerDialog_TypeLabel')}</span>
                    <SelectMenu
                        value={selectedType}
                        options={typeOptions}
                        onChange={(value) => selectType(String(value))}
                        placeholder={t('STR_ACE_Tacphone_Map_MarkerDialog_SelectType')}
                        disabled={markerTypes.length === 0}
                        searchable
                        searchPlaceholder={t('STR_ACE_Tacphone_Map_MarkerDialog_SearchTypes')}
                        size="compact"
                        testId="marker-type-select"
                        ariaLabel={t('STR_ACE_Tacphone_Map_MarkerDialog_TypeAria')}
                        emptyMessage={t('STR_ACE_Tacphone_Map_MarkerDialog_NoTypesMatch')}
                        className={DialogStyle.select_control}
                        buttonClassName={DialogStyle.select_trigger}
                        menuClassName={DialogStyle.select_menu}
                        optionClassName={DialogStyle.select_option}
                        renderOption={renderTypeOption}
                        renderValue={renderTypeValue}
                    />
                </div>

                <div className={DialogStyle.field}>
                    <span className={DialogStyle.field_label}>{t('str_a3_rscdiary_markercolor_tooltip')}</span>
                    <ColorSwatchPicker
                        colors={markerColors}
                        selectedColor={selectedColor}
                        onSelect={selectColor}
                        compact
                        leadingDefault={{ color: typeDefaultColor, label: t('STR_ACE_Tacphone_Map_MarkerDialog_DefaultColor') }}
                        excludeClassName="Default"
                        onCustomColorChange={selectColor}
                        customColor={parseMarkerColor(selectedColor) ? selectedColor : undefined}
                        testId="marker-color-picker"
                        swatchTestId="marker-color-swatch"
                        customTestId="marker-color-custom"
                        customInputTestId="marker-color-custom-input"
                        customAlphaTestId="marker-color-custom-alpha"
                        customPopoverTestId="marker-color-custom-popover"
                        ariaLabel={t('str_a3_rscdiary_markercolor_tooltip')}
                    />
                </div>

                {multiplayer && (
                    <div className={DialogStyle.field}>
                        <span className={DialogStyle.field_label}>{t('str_a3_cfgvehicles_modulechat_f_arguments_channel_0')}</span>
                        <SelectMenu
                            value={selectedChannel}
                            options={channelSelectOptions}
                            onChange={(value) => selectChannel(Number(value))}
                            placeholder={t('STR_ACE_Tacphone_Map_MarkerDialog_LoadingChannels')}
                            disabled={channelOptions.length === 0}
                            size="compact"
                            testId="marker-channel-select"
                            ariaLabel={t('str_a3_cfgvehicles_modulechat_f_arguments_channel_0')}
                            className={DialogStyle.select_control}
                            buttonClassName={DialogStyle.select_trigger}
                            menuClassName={DialogStyle.select_menu}
                            optionClassName={DialogStyle.select_option}
                        />
                    </div>
                )}

                <label className={DialogStyle.field}>
                    <span className={DialogStyle.field_label}>
                        {t('str_a3_rscdisplayarcademodules_direction')}
                        <span className={DialogStyle.field_value}>{dir}°</span>
                    </span>
                    <input
                        className={DialogStyle.slider}
                        type="range"
                        min={-180}
                        max={180}
                        step={1}
                        value={dir}
                        onChange={(event) => setDir(Number(event.target.value))}
                    />
                </label>

                <label className={DialogStyle.field}>
                    <span className={DialogStyle.field_label}>
                        {t('str_usract_buld_scale')}
                        <span className={DialogStyle.field_value}>{scale.toFixed(2)}×</span>
                    </span>
                    <input
                        className={DialogStyle.slider}
                        type="range"
                        min={0.5}
                        max={2}
                        step={0.05}
                        value={scale}
                        onChange={(event) => setScale(Number(event.target.value))}
                    />
                </label>

                <div className={DialogStyle.actions}>
                    <button
                        type="button"
                        className={DialogStyle.button}
                        onClick={onCancel}
                        data-testid="marker-cancel"
                    >
                        {t('STR_3DEN_Display3DEN_ControlsHint_Cancel')}
                    </button>
                    <button
                        type="button"
                        className={`${DialogStyle.button} ${DialogStyle.button_primary}`}
                        onClick={submit}
                        disabled={!canSubmit}
                        data-testid="marker-submit"
                    >
                        {submitLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
