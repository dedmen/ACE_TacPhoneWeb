import React from 'react';
import type { MarkerColor } from './MarkerLayer';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { parseMarkerColor } from './MarkerColorUtils';
import PolylineStyle from './PolylineDrawControls.module.scss';
import { t } from '../i18n';

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
                title={t('STR_ACE_Tacphone_Map_Polyline_DrawTitle')}
                aria-pressed={isActive}
                aria-label={t('STR_ACE_Tacphone_Map_Polyline_DrawTitle')}
            >
                ✏️
            </button>

            {isActive && (
                <div
                    className={PolylineStyle.polyline_panel}
                    role="group"
                    aria-label={t('STR_ACE_Tacphone_Map_Polyline_GroupLabel')}
                >
                    <div className={PolylineStyle.panel_header}>{t('STR_ACE_Tacphone_Map_Polyline_Title')}</div>

                    <label className={PolylineStyle.mode_row}>
                        <input
                            type="checkbox"
                            checked={clickPerPoint}
                            onChange={(event) => onClickPerPointChange(event.target.checked)}
                        />
                        <span>{t('STR_ACE_Tacphone_Map_Polyline_ClickPerPoint')}</span>
                    </label>

                    <div className={PolylineStyle.panel_muted}>{t('STR_ACE_Tacphone_Map_Polyline_RightDragPan')}</div>
                    {channelLabel !== '' && (
                        <div className={PolylineStyle.panel_muted}>{t('STR_ACE_Tacphone_Map_Polyline_Channel', channelLabel)}</div>
                    )}

                    {colors.length === 0 ? (
                        <div className={PolylineStyle.panel_muted}>{t('STR_ACE_Tacphone_Map_Polyline_LoadingColors')}</div>
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
                                ariaLabel={t('STR_ACE_Tacphone_Map_Polyline_Color')}
                            />
                        </div>
                    )}

                    <div className={PolylineStyle.panel_muted}>{t('STR_ACE_Tacphone_Map_Polyline_Points', vertexCount)}</div>

                    <div className={PolylineStyle.panel_actions}>
                        <button
                            type="button"
                            className={PolylineStyle.action_button}
                            onClick={onUndo}
                            disabled={!canUndo}
                        >
                            {t('str_3den_display3den_menubar_undo_text')}
                        </button>
                        <button
                            type="button"
                            className={PolylineStyle.action_button}
                            onClick={onCancel}
                        >
                            {t('STR_3DEN_Display3DEN_ControlsHint_Cancel')}
                        </button>
                        <button
                            type="button"
                            className={`${PolylineStyle.action_button} ${PolylineStyle.action_button_primary}`}
                            onClick={onFinish}
                            disabled={!canFinish}
                        >
                            {t('STR_ACE_Tacphone_Common_Done')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
