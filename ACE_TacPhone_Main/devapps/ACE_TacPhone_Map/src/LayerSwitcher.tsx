import React, { useEffect, useState } from 'react';
import Map from 'ol/Map';
import BaseLayer from 'ol/layer/Base';
import { CollectionEvent } from 'ol/Collection';

import LayerSwitcherStyle from './LayerSwitcherStyle.module.scss'

// Define the shape of the layer data we want React to track
interface LayerData {
  id: string;
  title: string;
  visible: boolean;
  layerInstance: BaseLayer;
}

interface LayerSwitcherProps {
  map: Map | null;
}

//#TODO that is currently unused crap, because the layers are actually done inside Map.tsx, but it should be moved back here, the only problem is the "clicked outside" area that should close the popup

export function LayerSwitcher({ map }: LayerSwitcherProps): React.JSX.Element | null {
  const [layers, setLayers] = useState<LayerData[]>([]);

  useEffect(() => {
    if (!map) return;

    const updateLayersState = (): void => {
      const layerArray = map.getLayers().getArray();
      
      const layersData: LayerData[] = layerArray
        .filter((layer): layer is BaseLayer & { get(key: 'title'): string } => {
          // Explicitly check that a title exists and is a string
          return typeof layer.get('title') === 'string';
        })
        .map((layer) => ({
          // OpenLayers assigns a string 'ol_uid' internally to all BaseLayer objects
          id: (layer as any).ol_uid || Math.random().toString(), 
          title: layer.get('title'),
          visible: layer.getVisible(),
          layerInstance: layer
        }));
      
      setLayers(layersData);
    };

    // 1. Set initial layers
    updateLayersState();

    // 2. Listen to dynamic collection additions or removals
    const layersCollection = map.getLayers();
    
    // We type the callback to match OpenLayers CollectionEvent structure
    const handleCollectionChange = (_e: CollectionEvent<BaseLayer>): void => {
      updateLayersState();
    };

    layersCollection.on('add', handleCollectionChange);
    layersCollection.on('remove', handleCollectionChange);

    // 3. Clean up event listeners on unmount
    return () => {
      layersCollection.un('add', handleCollectionChange);
      layersCollection.un('remove', handleCollectionChange);
    };
  }, [map]);

  const handleToggle = (layerData: LayerData, isChecked: boolean): void => {
    // Imperative OpenLayers layer visibility change
    layerData.layerInstance.setVisible(isChecked);
    
    // Declarative React state change to reflect checkmark toggles instantly
    setLayers((prevLayers) =>
      prevLayers.map((l) => (l.id === layerData.id ? { ...l, visible: isChecked } : l))
    );
  };

  if (layers.length === 0) return null;

  return (
    <div className={`${LayerSwitcherStyle.layer_switcher_panel}`}>
      <h4>Layers</h4>
      {layers.map((layerData) => (
        <div key={layerData.id} className={`${LayerSwitcherStyle.layer_row}`}>
          <input
            type="checkbox"
            id={`layer-${layerData.id}`}
            checked={layerData.visible}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => 
              handleToggle(layerData, e.target.checked)
            }
          />
          <label htmlFor={`layer-${layerData.id}`}>{layerData.title}</label>
        </div>
      ))}
    </div>
  );
}