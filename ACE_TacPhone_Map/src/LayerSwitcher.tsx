import React, { useEffect, useRef, useState } from 'react';
import type Map from 'ol/Map';
import type BaseLayer from 'ol/layer/Base';
import { getUid } from 'ol/util.js';

import LayerSwitcherStyle from './LayerSwitcherStyle.module.scss';

// Define the shape of the layer data we want React to track
interface LayerData {
  id: string;
  title: string;
  visible: boolean;
  layerInstance: BaseLayer;
}

interface LayerSwitcherProps {
  map: Map | null;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}

export function LayerSwitcher({ map, isOpen, onToggle, onClose }: LayerSwitcherProps): React.JSX.Element | null {
  const [layers, setLayers] = useState<LayerData[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!map) {
      setLayers([]);
      return;
    }

    const updateLayersState = (): void => {
      const layersData: LayerData[] = map.getLayers().getArray()
        .filter((layer): layer is BaseLayer & { get(key: 'title'): string } => {
          // Explicitly check that a title exists and is a string
          return typeof layer.get('title') === 'string';
        })
        .map((layer) => ({
          id: getUid(layer),
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
    layersCollection.on('add', updateLayersState);
    layersCollection.on('remove', updateLayersState);

    // 3. Clean up event listeners on unmount
    return () => {
      layersCollection.un('add', updateLayersState);
      layersCollection.un('remove', updateLayersState);
    };
  }, [map]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  const handleToggle = (layerData: LayerData, isChecked: boolean): void => {
    // Imperative OpenLayers layer visibility change
    layerData.layerInstance.setVisible(isChecked);

    // Declarative React state change to reflect checkmark toggles instantly
    setLayers((prevLayers) =>
      prevLayers.map((layer) => (layer.id === layerData.id ? { ...layer, visible: isChecked } : layer))
    );
  };

  if (layers.length === 0) return null;

  return (
    <div className={LayerSwitcherStyle.layer_switcher_container} ref={containerRef}>
      {/* The Trigger Button */}
      <button
        type="button"
        className={`${LayerSwitcherStyle.layer_switcher_btn}${isOpen ? ` ${LayerSwitcherStyle.active}` : ''}`}
        onClick={onToggle}
        title="Toggle Layers"
        aria-expanded={isOpen}
      >
        🥞
      </button>

      {/* The Dropdown Menu */}
      {isOpen && (
        <div className={LayerSwitcherStyle.layer_switcher_dropdown}>
          <h4>Layers</h4>
          {layers.map((layerData) => (
            <div key={layerData.id} className={LayerSwitcherStyle.layer_row}>
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
      )}
    </div>
  );
}
