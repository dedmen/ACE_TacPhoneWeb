// Map subclass whose tile queue honors the terrain layer order.
//
// OpenLayers has a single map-wide tile queue. Its base priority only considers
// the tile zoom and the distance from the viewport center, so tiles from the
// heavy `objects`/`countlines` layers compete with terrain and roads. Adding a
// per-source rank to the priority makes every terrain tile of a higher-ranked
// layer dequeue first.
//
// The task queue captures `this.getTilePriority.bind(this)` in the `Map`
// constructor, so patching an existing map instance is too late: a subclass
// created before construction is required.

import OlMap from 'ol/Map';
import type Tile from 'ol/Tile';
import type { Coordinate } from 'ol/coordinate';
import type TileSource from 'ol/source/Tile';
import { getUid } from 'ol/util.js';

/** Rank assumed for a source that was never registered (should not happen). */
const DEFAULT_RANK = 100;

/**
 * Larger than any base priority magnitude
 * (`65536 * log(resolution) + distancePx / resolution` stays around -1e6..1e6),
 * so the layer rank always dominates.
 */
const RANK_WEIGHT = 1e8;

export class PriorityMap extends OlMap {
    /** `getUid(source)` -> layer rank. */
    private readonly sourceRanks = new Map<string, number>();

    /** Sources already reported as unregistered, to log each one only once. */
    private readonly reportedUnregistered = new Set<string>();

    /**
     * Registers a tile source's loading rank.
     *
     * Must be called before `map.addLayer(layer)`: the canvas tile renderer
     * keys its queue entries by `getUid(tileSource)`, which is what this map
     * uses for the lookup.
     */
    public registerSource(source: TileSource, rank: number): void {
        this.sourceRanks.set(getUid(source), rank);
    }

    /** Drops every registered rank; call when the terrain layers are replaced. */
    public clearSourceRanks(): void {
        this.sourceRanks.clear();
        this.reportedUnregistered.clear();
    }

    public override getTilePriority(
        tile: Tile,
        tileSourceKey: string,
        tileCenter: Coordinate,
        tileResolution: number,
    ): number {
        const base = super.getTilePriority(tile, tileSourceKey, tileCenter, tileResolution);

        // Infinity means "drop this tile"; keep it out of the ranked queue.
        if (!Number.isFinite(base)) {
            return base;
        }

        const rank = this.sourceRanks.get(tileSourceKey);
        if (rank === undefined && import.meta.env.DEV && !this.reportedUnregistered.has(tileSourceKey)) {
            this.reportedUnregistered.add(tileSourceKey);
            console.warn(`PriorityMap: no rank registered for tile source ${tileSourceKey}`);
        }

        return base + (rank ?? DEFAULT_RANK) * RANK_WEIGHT;
    }
}
