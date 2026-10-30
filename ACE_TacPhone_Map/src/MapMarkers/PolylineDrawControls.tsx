import React from 'react';
import type { MarkerColor } from './MarkerLayer';
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

                    {colors.length === 0 ? (
                        <div className={PolylineStyle.panel_muted}>Loading colors…</div>
                    ) : (
                        <div className={PolylineStyle.swatch_grid}>
                            {colors.map((color) => (
                                <button
                                    key={color.className}
                                    type="button"
                                    className={`${PolylineStyle.swatch}${color.className === selectedColor ? ` ${PolylineStyle.swatch_selected}` : ''}`}
                                    style={{ backgroundColor: color.color }}
                                    title={color.name || color.className}
                                    aria-label={color.name || color.className}
                                    aria-pressed={color.className === selectedColor}
                                    onClick={() => onSelectColor(color.className)}
                                />
                            ))}
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
