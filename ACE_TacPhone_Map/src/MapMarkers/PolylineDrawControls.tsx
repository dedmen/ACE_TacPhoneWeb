import React from 'react';
import type { MarkerColor } from './MarkerLayer';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { parseMarkerColor } from './MarkerColorUtils';
import PolylineStyle from './PolylineDrawControls.module.scss';

export interface PolylineDrawControlsProps {
    /** True while the polyline drawing mode is armed. */
    isActive: boolean;
    /** Number of vertices placed so far. */
    vertexCount: number;
    /** Colors from the game's CfgMarkerColors. */
    colors: MarkerColor[];
    /** CfgMarkerColors class name of the selected color. */
    selectedColor: string;
    /** Label of the active marker channel, or empty when unknown. */
    channelLabel?: string;
    /** True when a tap places one vertex instead of drawing freehand. */
    clickPerPoint: boolean;
    onToggle: () => void;
    onSelectColor: (className: string) => void;
    onClickPerPointChange: (clickPerPoint: boolean) => void;
    onUndo: () => void;
    onCancel: () => void;
    onFinish: () => void;
}

export function PolylineDrawControls({
    isActive,
    vertexCount,
    colors,
    selectedColor,
    channelLabel = '',
    clickPerPoint,
    onToggle,
    onSelectColor,
    onClickPerPointChange,
    onUndo,
    onCancel,
    onFinish,
}: PolylineDrawControlsProps): React.JSX.Element {
    const canUndo = vertexCount > 0;
    const canFinish = vertexCount >= 2;

    return (
        <div className={PolylineStyle.polyline_controls_container}>
            <button
                type="button"
                className={`${PolylineStyle.polyline_toggle_btn}${isActive ? ` ${PolylineStyle.active}` : ''}`}
                onClick={onToggle}
                title="Draw polyline marker"
                aria-pressed={isActive}
                aria-label="Draw polyline marker"
            >
                ✏️
            </button>

            {isActive && (
                <div
                    className={PolylineStyle.polyline_panel}
                    role="group"
                    aria-label="Polyline drawing"
                >
                    <div className={PolylineStyle.panel_header}>Polyline</div>

                    <label className={PolylineStyle.mode_row}>
                        <input
                            type="checkbox"
                            checked={clickPerPoint}
                            onChange={(event) => onClickPerPointChange(event.target.checked)}
                        />
                        <span>Click per point</span>
                    </label>

                    <div className={PolylineStyle.panel_muted}>Right-drag to pan</div>
                    {channelLabel !== '' && (
                        <div className={PolylineStyle.panel_muted}>Channel: {channelLabel}</div>
                    )}

                    {colors.length === 0 ? (
                        <div className={PolylineStyle.panel_muted}>Loading colors…</div>
                    ) : (
                        <div className={PolylineStyle.swatch_grid}>
                            <ColorSwatchPicker
                                colors={colors}
                                selectedColor={selectedColor}
                                onSelect={onSelectColor}
                                excludeClassName="Default"
                                onCustomColorChange={onSelectColor}
                                customColor={parseMarkerColor(selectedColor) ? selectedColor : undefined}
                                testId="polyline-color-picker"
                                swatchTestId="polyline-color-swatch"
                                customTestId="polyline-color-custom"
                                customInputTestId="polyline-color-custom-input"
                                customAlphaTestId="polyline-color-custom-alpha"
                                customPopoverTestId="polyline-color-custom-popover"
                                ariaLabel="Polyline color"
                            />
                        </div>
                    )}

                    <div className={PolylineStyle.panel_muted}>Points: {vertexCount}</div>

                    <div className={PolylineStyle.panel_actions}>
                        <button
                            type="button"
                            className={PolylineStyle.action_button}
                            onClick={onUndo}
                            disabled={!canUndo}
                        >
                            Undo
                        </button>
                        <button
                            type="button"
                            className={PolylineStyle.action_button}
                            onClick={onCancel}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            className={`${PolylineStyle.action_button} ${PolylineStyle.action_button_primary}`}
                            onClick={onFinish}
                            disabled={!canFinish}
                        >
                            Done
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
