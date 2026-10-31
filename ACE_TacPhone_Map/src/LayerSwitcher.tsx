import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type Map from 'ol/Map';
import type BaseLayer from 'ol/layer/Base';
import { getUid } from 'ol/util.js';

import {
  type LayerSwitcherLayer,
  type LayerSwitcherRegistry,
  type LayerSwitcherSection,
} from './MapMarkers/LayerSwitcherRegistry';
import LayerSwitcherStyle from './LayerSwitcherStyle.module.scss';

interface LayerSwitcherProps {
  map: Map | null;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Map add-ons (markers, later GPS) inject sections here. */
  sections?: LayerSwitcherRegistry;
}

const EMPTY_SECTIONS: ReadonlyArray<LayerSwitcherSection> = [];
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined;
const EMPTY_SNAPSHOT = () => EMPTY_SECTIONS;

export function LayerSwitcher({
  map,
  isOpen,
  onToggle,
  onClose,
  sections,
}: LayerSwitcherProps): React.JSX.Element | null {
  const [layers, setLayers] = useState<LayerSwitcherLayer[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sectionList = useSyncExternalStore(
    sections?.subscribe ?? NOOP_SUBSCRIBE,
    sections?.getSnapshot ?? EMPTY_SNAPSHOT,
  );

  useEffect(() => {
    if (!map) {
      setLayers([]);
      return;
    }

    const updateLayersState = (): void => {
      const layersData: LayerSwitcherLayer[] = map.getLayers().getArray()
        .filter((layer): layer is BaseLayer & { get(key: 'title'): string } => {
          // Explicitly check that a title exists and is a string
          return typeof layer.get('title') === 'string';
        })
        .map((layer) => ({
          id: getUid(layer),
          title: layer.get('title'),
          visible: layer.getVisible(),
          layer,
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

  const handleToggle = (layerData: LayerSwitcherLayer, isChecked: boolean): void => {
    // Imperative OpenLayers layer visibility change
    layerData.layer.setVisible(isChecked);

    // Declarative React state change to reflect checkmark toggles instantly
    setLayers((prevLayers) =>
      prevLayers.map((layer) => (layer.id === layerData.id ? { ...layer, visible: isChecked } : layer))
    );
  };

  if (layers.length === 0) return null;

  // Sections own their layers; the marker module owns channel layers, so they
  // never appear as plain rows. A map without marker (or other) modules simply
  // has no sections and behaves like a plain layer list.
  const plainLayers = layers.filter((layer) => (
    !sectionList.some((section) => section.ownsLayer?.(layer.layer) === true)
  ));

  const renderRow = (layerData: LayerSwitcherLayer): React.JSX.Element => (
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
  );

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
          {plainLayers.map(renderRow)}

          {sectionList.map((section) => (
            <React.Fragment key={section.id}>
              {section.render({
                map,
                layers,
                setLayerVisible: handleToggle,
              })}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
