/**
 * Generic extension point for the map layer switcher.
 *
 * Map add-ons (markers, later GPS, ...) register a section here. LayerSwitcher
 * renders every registered section and lets each section claim the map layers
 * it owns, so marker channel layers never leak into the generic layer list.
 */

import type { ReactNode } from 'react';
import type OlMap from 'ol/Map';
import type BaseLayer from 'ol/layer/Base';

export interface LayerSwitcherLayer {
    id: string;
    title: string;
    visible: boolean;
    layer: BaseLayer;
}

export interface LayerSwitcherSectionProps {
    map: OlMap | null;
    layers: ReadonlyArray<LayerSwitcherLayer>;
    setLayerVisible(layer: LayerSwitcherLayer, visible: boolean): void;
}

export interface LayerSwitcherSection {
    id: string;
    /** Lower values render first. */
    order?: number;
    /** Return true for layers this section renders itself. */
    ownsLayer?(layer: BaseLayer): boolean;
    render(props: LayerSwitcherSectionProps): ReactNode;
}

const EMPTY_SECTIONS: ReadonlyArray<LayerSwitcherSection> = [];

export class LayerSwitcherRegistry {
    private readonly sections = new Map<string, LayerSwitcherSection>();
    private readonly listeners = new Set<() => void>();
    private snapshot: ReadonlyArray<LayerSwitcherSection> = EMPTY_SECTIONS;

    public getSnapshot = (): ReadonlyArray<LayerSwitcherSection> => this.snapshot;

    public subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    public register(section: LayerSwitcherSection): () => void {
        this.sections.set(section.id, section);
        this.rebuild();

        return () => {
            if (this.sections.get(section.id) !== section) {
                return;
            }

            this.sections.delete(section.id);
            this.rebuild();
        };
    }

    private rebuild(): void {
        this.snapshot = [...this.sections.values()]
            .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id));

        for (const listener of this.listeners) {
            listener();
        }
    }
}
