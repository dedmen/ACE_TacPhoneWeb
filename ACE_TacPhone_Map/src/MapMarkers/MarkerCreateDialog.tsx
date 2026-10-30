import React, { useEffect, useRef, useState } from 'react';
import type { MarkerColor, MarkerType } from './MarkerLayer';
import type { MarkerCreationData } from './MarkerApi';
import DialogStyle from './MarkerCreateDialog.module.scss';

interface MarkerCreateDialogProps {
    coordinate: [number, number];
    markerTypes: MarkerType[];
    markerColors: MarkerColor[];
    loadMarkerIcon: (iconPath: string) => Promise<string>;
    onSubmit: (marker: MarkerCreationData) => void;
    onCancel: () => void;
    /** Pre-filled values when the dialog edits an existing marker. */
    initialLabel?: string;
    initialType?: string;
    initialColor?: string;
    title?: string;
    submitLabel?: string;
}

function useDropdown(): {
    open: boolean;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
    containerRef: React.RefObject<HTMLDivElement | null>;
} {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;

        const handleMouseDown = (event: MouseEvent): void => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };

        document.addEventListener('mousedown', handleMouseDown);
        return () => document.removeEventListener('mousedown', handleMouseDown);
    }, [open]);

    return { open, setOpen, containerRef };
}

// Icons are cached module wide, so opening the dropdown again is instant.
const markerIconCache = new Map<string, string>();

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

    return (
        <span ref={hostRef} className={DialogStyle.icon_preview}>
            {imageUrl ? (
                <span
                    className={DialogStyle.icon_image}
                    style={{
                        backgroundColor: color,
                        WebkitMaskImage: `url("${imageUrl}")`,
                        maskImage: `url("${imageUrl}")`,
                    }}
                />
            ) : (
                <span className={DialogStyle.icon_placeholder} />
            )}
        </span>
    );
}

function ColorSwatch({ color }: { color: string }): React.JSX.Element {
    return (
        <span className={DialogStyle.color_swatch_wrap}>
            <span className={DialogStyle.color_swatch} style={{ backgroundColor: color }} />
        </span>
    );
}

interface MarkerTypeDropdownProps {
    markerTypes: MarkerType[];
    selectedType: string;
    selectedColor: string;
    loadMarkerIcon: (iconPath: string) => Promise<string>;
    onSelect: (className: string) => void;
}

function MarkerTypeDropdown({ markerTypes, selectedType, selectedColor, loadMarkerIcon, onSelect }: MarkerTypeDropdownProps): React.JSX.Element {
    const { open, setOpen, containerRef } = useDropdown();
    const selected = markerTypes.find((type) => type.className === selectedType) ?? null;

    return (
        <div className={DialogStyle.dropdown} ref={containerRef}>
            <button
                type="button"
                className={`${DialogStyle.dropdown_trigger} ${open ? DialogStyle.dropdown_trigger_open : ''}`}
                onClick={() => setOpen((isOpen) => !isOpen)}
                disabled={markerTypes.length === 0}
                aria-expanded={open}
            >
                <MarkerIconPreview icon={selected?.icon ?? ''} color={selectedColor} loadMarkerIcon={loadMarkerIcon} />
                <span className={DialogStyle.dropdown_value}>
                    {selected ? (selected.name || selected.className) : (markerTypes.length === 0 ? 'Loading marker types…' : 'Select marker type')}
                </span>
                <span className={DialogStyle.chevron} aria-hidden="true" />
            </button>

            {open && (
                <div className={DialogStyle.dropdown_menu} data-dropdown-menu>
                    {markerTypes.map((type) => (
                        <button
                            key={type.className}
                            type="button"
                            aria-pressed={type.className === selectedType}
                            className={`${DialogStyle.dropdown_option} ${type.className === selectedType ? DialogStyle.dropdown_option_selected : ''}`}
                            onClick={() => {
                                onSelect(type.className);
                                setOpen(false);
                            }}
                            title={type.name || type.className}
                        >
                            <MarkerIconPreview icon={type.icon} color={selectedColor} loadMarkerIcon={loadMarkerIcon} lazy />
                            <span className={DialogStyle.option_label}>{type.name || type.className}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

interface MarkerColorDropdownProps {
    markerColors: MarkerColor[];
    selectedColor: string;
    onSelect: (className: string) => void;
}

function MarkerColorDropdown({ markerColors, selectedColor, onSelect }: MarkerColorDropdownProps): React.JSX.Element {
    const { open, setOpen, containerRef } = useDropdown();
    const selected = markerColors.find((color) => color.className === selectedColor) ?? null;

    return (
        <div className={DialogStyle.dropdown} ref={containerRef}>
            <button
                type="button"
                className={`${DialogStyle.dropdown_trigger} ${open ? DialogStyle.dropdown_trigger_open : ''}`}
                onClick={() => setOpen((isOpen) => !isOpen)}
                disabled={markerColors.length === 0}
                aria-expanded={open}
            >
                <ColorSwatch color={selected?.color ?? 'transparent'} />
                <span className={DialogStyle.dropdown_value}>
                    {selected ? (selected.name || selected.className) : (markerColors.length === 0 ? 'Loading marker colors…' : 'Select marker color')}
                </span>
                <span className={DialogStyle.chevron} aria-hidden="true" />
            </button>

            {open && (
                <div className={DialogStyle.dropdown_menu} data-dropdown-menu>
                    {markerColors.map((color) => (
                        <button
                            key={color.className}
                            type="button"
                            aria-pressed={color.className === selectedColor}
                            className={`${DialogStyle.dropdown_option} ${color.className === selectedColor ? DialogStyle.dropdown_option_selected : ''}`}
                            onClick={() => {
                                onSelect(color.className);
                                setOpen(false);
                            }}
                            title={color.name || color.className}
                        >
                            <ColorSwatch color={color.color} />
                            <span className={DialogStyle.option_label}>{color.name || color.className}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function MarkerCreateDialog({
    coordinate,
    markerTypes,
    markerColors,
    loadMarkerIcon,
    onSubmit,
    onCancel,
    initialLabel = '',
    initialType = '',
    initialColor = '',
    title = 'Add Marker',
    submitLabel = 'Create',
}: MarkerCreateDialogProps): React.JSX.Element {
    const [label, setLabel] = useState(initialLabel);
    const [selectedType, setSelectedType] = useState(initialType);
    const [selectedColor, setSelectedColor] = useState(initialColor);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        if (markerTypes.length > 0 && !markerTypes.some((type) => type.className === selectedType)) {
            setSelectedType(markerTypes[0].className);
        }
    }, [markerTypes, selectedType]);

    useEffect(() => {
        if (markerColors.length > 0 && !markerColors.some((color) => color.className === selectedColor)) {
            setSelectedColor(markerColors[0].className);
        }
    }, [markerColors, selectedColor]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                onCancel();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onCancel]);

    const selectedColorInfo = markerColors.find((color) => color.className === selectedColor) ?? null;
    const canSubmit = label.trim().length > 0 && selectedType !== '' && selectedColor !== '';

    // The in-game browser sandbox has no 'allow-forms', so a real <form> submit is
    // blocked before any handler runs. Submit from button/Enter handlers instead.
    const submit = (): void => {
        if (!canSubmit) return;

        onSubmit({
            label: label.trim(),
            type: selectedType,
            color: selectedColor,
            position: coordinate,
        });
    };

    const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submit();
        }
    };

    return (
        <div
            className={DialogStyle.overlay}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onCancel();
                }
            }}
        >
            <div className={DialogStyle.dialog} role="dialog" aria-modal="true" aria-label={title}>
                <div className={DialogStyle.dialog_header}>
                    <h3 className={DialogStyle.dialog_title}>{title}</h3>
                    <button
                        type="button"
                        className={DialogStyle.close_button}
                        onClick={onCancel}
                        aria-label="Close marker dialog"
                        title="Close"
                    >
                        ×
                    </button>
                </div>

                <label className={DialogStyle.field}>
                    <span className={DialogStyle.field_label}>Marker Name</span>
                    <input
                        ref={inputRef}
                        className={DialogStyle.text_input}
                        type="text"
                        value={label}
                        maxLength={128}
                        placeholder="Enter marker name"
                        onChange={(event) => setLabel(event.target.value)}
                        onKeyDown={handleInputKeyDown}
                    />
                </label>

                <div className={DialogStyle.field}>
                    <span className={DialogStyle.field_label}>Marker Type</span>
                    <MarkerTypeDropdown
                        markerTypes={markerTypes}
                        selectedType={selectedType}
                        selectedColor={selectedColorInfo?.color ?? '#ffffff'}
                        loadMarkerIcon={loadMarkerIcon}
                        onSelect={setSelectedType}
                    />
                </div>

                <div className={DialogStyle.field}>
                    <span className={DialogStyle.field_label}>Marker Color</span>
                    <MarkerColorDropdown
                        markerColors={markerColors}
                        selectedColor={selectedColor}
                        onSelect={setSelectedColor}
                    />
                </div>

                <div className={DialogStyle.actions}>
                    <button type="button" className={DialogStyle.button} onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className={`${DialogStyle.button} ${DialogStyle.button_primary}`}
                        onClick={submit}
                        disabled={!canSubmit}
                    >
                        {submitLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
