import React, { useSyncExternalStore } from 'react';

import type { LayerSwitcherSectionProps } from './LayerSwitcherRegistry';
import type { MarkerChannelStore } from './MarkerChannelStore';
import LayerSwitcherStyle from '../LayerSwitcherStyle.module.scss';
import { t } from '../i18n';

interface MarkerLayerSwitcherSectionProps extends LayerSwitcherSectionProps {
    channels: MarkerChannelStore;
}

export function MarkerLayerSwitcherSection({
    layers,
    setLayerVisible,
    channels,
}: MarkerLayerSwitcherSectionProps): React.JSX.Element | null {
    const snapshot = useSyncExternalStore(channels.subscribe, channels.getSnapshot);

    if (!snapshot.enabled) {
        return null;
    }

    const markerLayers = layers
        .filter((layer) => typeof layer.layer.get('markerChannel') === 'number')
        .sort((left, right) => (
            (left.layer.get('markerChannel') as number) - (right.layer.get('markerChannel') as number)
        ));

    if (markerLayers.length === 0) {
        return null;
    }

    return (
        <div className={LayerSwitcherStyle.marker_group}>
            <div className={LayerSwitcherStyle.marker_group_header}>
                <span>{t('STR_3DEN_Marker_textPlural')}</span>
                {snapshot.multiplayer && (
                    <span className={LayerSwitcherStyle.marker_group_active}>
                        {t('STR_ACE_Tacphone_Map_Layers_ActiveChannel', snapshot.activeChannelLabel)}
                    </span>
                )}
            </div>

            {markerLayers.map((layerData) => {
                const channel = layerData.layer.get('markerChannel') as number;
                const available = layerData.layer.get('markerChannelAvailable') !== false;

                return (
                    <div key={layerData.id} className={LayerSwitcherStyle.layer_row_channel}>
                        <input
                            type="checkbox"
                            id={`layer-${layerData.id}`}
                            checked={layerData.visible}
                            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                                setLayerVisible(layerData, event.target.checked)
                            }
                        />
                        {snapshot.multiplayer && (
                            <input
                                type="radio"
                                name="marker-active-channel"
                                className={LayerSwitcherStyle.channel_radio}
                                checked={channel === snapshot.activeChannel}
                                onChange={() => channels.setActiveChannel(channel)}
                                disabled={!available}
                                title={t('STR_ACE_Tacphone_Map_Layers_ChannelUse')}
                                aria-label={t('STR_ACE_Tacphone_Map_Layers_ChannelAria', layerData.title)}
                            />
                        )}
                        <label htmlFor={`layer-${layerData.id}`}>{layerData.title}</label>
                    </div>
                );
            })}
        </div>
    );
}
