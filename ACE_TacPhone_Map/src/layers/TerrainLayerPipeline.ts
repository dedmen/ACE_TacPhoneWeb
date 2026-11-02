// Progressive terrain-layer loader.
//
// The host delivers terrain layers one at a time: the remote transport sends
// each layer's compressed chunks as it produces them, and even the in-game
// transport hands them over as soon as the whole SVG is split. This pipeline
// turns that arrival into visible layers without ever blocking the cheap ones
// behind an element-heavy SVG:
//
// - a layer is decoded as soon as it arrives (two light decodes in flight);
// - the element-heavy `objects`/`countlines` layers are decoded one at a time
//   once every light layer's first tiles have finished loading. They are not
//   visible at that zoom, so the initial render never waits for their parse,
//   but they are normally ready before the user zooms in;
// - a layer that fails to decode is skipped instead of blanking the map.
//
// The priority order itself lives in `TerrainLayerPriority`; this file only
// schedules that order and tracks per-layer debug counters.

import type TileLayer from 'ol/layer/Tile';
import type Projection from 'ol/proj/Projection';
import type ImageTileSource from 'ol/source/ImageTile';
import type TileGrid from 'ol/tilegrid/TileGrid.js';
import type { TerrainLayer } from '@ace-tacphone/api';

import type { MapViewTileStats } from '../MapMarkers/MapTestHooks';
import type { PriorityMap } from './PriorityMap';
import {
    planTerrainLayer,
    type TerrainLayerPlan,
} from './TerrainLayerPriority';
import { createTerrainTileLayer, loadTerrainLayerImage } from './TerrainLayerSource';

/** Decode concurrency for the light layers: next one warm, without competing. */
const LIGHT_DECODE_CONCURRENCY = 2;

/** The heavy phase decodes one layer at a time. */
const HEAVY_DECODE_CONCURRENCY = 1;

/**
 * One task of breathing room after the last base tile, so that frame can paint
 * before a multi-megabyte SVG is parsed.
 */
const HEAVY_PHASE_START_DELAY_MS = 0;

export interface TerrainTileSettings {
    tileSize: number;
    smoothScaling: boolean;
    preload: number;
    cacheSize: number;
}

/** Progress of one layer inside the terrain reply. */
export interface TerrainLayerArrival {
    /** Position in `TerrainData.layers`. */
    index: number;
    /** Total layer count in the reply. */
    count: number;
}

export interface TerrainLayerPipelineOptions {
    map: PriorityMap;
    projection: Projection;
    tileGrid: TileGrid;
    resolutions: readonly number[];
    settings: TerrainTileSettings;
    /** Called on every tile start/end/error and when a layer is activated. */
    onTileActivity: () => void;
    /** Called whenever pending/activation/tile counters change. */
    onStatsChanged: () => void;
}

interface LayerSlot {
    plan: TerrainLayerPlan;
    image: HTMLImageElement | null;
    decoding: boolean;
    error: string | null;
    layer: TileLayer<ImageTileSource> | null;
    stats: MapViewTileStats;
}

/** Orders two plans by rank, then by their position in the terrain document. */
function comparePlans(left: TerrainLayerPlan, right: TerrainLayerPlan): number {
    return left.rank - right.rank || left.documentIndex - right.documentIndex;
}

/** Inserts a slot into a plan-sorted list without disturbing it. */
function insertByPlan<T extends { plan: TerrainLayerPlan }>(list: T[], entry: T): void {
    const insertAt = list.findIndex((existing) => comparePlans(existing.plan, entry.plan) > 0);
    if (insertAt === -1) {
        list.push(entry);
    } else {
        list.splice(insertAt, 0, entry);
    }
}

export class TerrainLayerPipeline {
    private readonly map: PriorityMap;
    private readonly onTileActivity: () => void;
    private readonly onStatsChanged: () => void;

    private projection: Projection;
    private tileGrid: TileGrid;
    private resolutions: readonly number[];
    private settings: TerrainTileSettings;

    private startedAt = 0;
    private disposed = false;
    private pumping = false;
    /** Bumped on restart/dispose so callbacks from a previous generation bail out. */
    private epoch = 0;

    /** Every received layer, indexed by its position in the terrain document. */
    private layerData: TerrainLayer[] = [];
    /** True once every layer of the reply has arrived (or `finish()` ran). */
    private complete = false;
    /** Total layer count announced by the progress callback. */
    private receivedCount = 0;

    /** Live slots, sorted by rank for the debug state. */
    private slots: LayerSlot[] = [];
    /** Arrival order, so a layer never waits for one that has not been sent. */
    private lightQueue: LayerSlot[] = [];
    private heavyQueue: LayerSlot[] = [];

    private activeLightDecodes = 0;
    private activeHeavyDecodes = 0;
    private heavyPhaseStarted = false;
    private heavyScheduled = false;
    private heavyTimer: number | null = null;

    /** Decoded images survive an option rebuild (they are not tile-grid specific). */
    private readonly imageCache = new Map<number, HTMLImageElement>();
    /** In-flight decodes, so a restart does not decode the same layer twice. */
    private readonly pendingDecodes = new Map<number, Promise<HTMLImageElement>>();
    /** User layer visibility, preserved across an option rebuild. */
    private readonly savedVisibility = new Map<string, boolean>();

    constructor(options: TerrainLayerPipelineOptions) {
        this.map = options.map;
        this.projection = options.projection;
        this.tileGrid = options.tileGrid;
        this.resolutions = options.resolutions;
        this.settings = options.settings;
        this.onTileActivity = options.onTileActivity;
        this.onStatsChanged = options.onStatsChanged;
        this.startedAt = performance.now();
    }

    /**
     * Adds one layer that just arrived. Layers may arrive in any order; the
     * priority order is applied by the scheduler, not by the caller.
     */
    public pushLayer(layer: TerrainLayer, arrival: TerrainLayerArrival): void {
        if (this.disposed || this.layerData[arrival.index]) {
            return;
        }

        this.layerData[arrival.index] = layer;
        this.receivedCount = Math.max(this.receivedCount, arrival.count);
        this.addSlot(layer, arrival.index);
        // The final promise may still be in flight (the host has to assemble the
        // whole reply). Once every announced layer has arrived, the heavy phase
        // may start without waiting for it.
        if (this.receivedCount > 0 && this.slots.length >= this.receivedCount) {
            this.complete = true;
        }
        this.pump();
    }

    /**
     * Marks the reply complete. Any layer the caller did not push (for example
     * when a coalesced request resolved instantly from the cache) is added now.
     */
    public finish(layers: readonly TerrainLayer[]): void {
        if (this.disposed) {
            return;
        }

        layers.forEach((layer, index) => {
            if (this.layerData[index]) {
                return;
            }

            this.layerData[index] = layer;
            this.addSlot(layer, index);
        });

        this.complete = true;
        this.pump();
        this.maybeShowAllFailed();
    }

    /**
     * Rebuilds the layers after a tiling option change. Decoded images are
     * reused and the view is left untouched (the caller keeps it).
     */
    public restart(
        settings: TerrainTileSettings,
        tileGrid: TileGrid,
        resolutions: readonly number[],
    ): void {
        if (this.disposed) {
            return;
        }

        this.cancelScheduledHeavyPhase();
        this.saveVisibility();
        this.disposeLayers();
        this.map.clearSourceRanks();

        this.epoch += 1;
        this.settings = settings;
        this.tileGrid = tileGrid;
        this.resolutions = resolutions;
        this.startedAt = performance.now();

        this.slots = this.layerData
            .flatMap((layer, documentIndex) => (
                layer ? [planTerrainLayer(layer, documentIndex)] : []
            ))
            .sort(comparePlans)
            .map((plan) => this.createSlot(plan));
        this.lightQueue = this.slots.filter((slot) => !slot.plan.heavy);
        this.heavyQueue = this.slots.filter((slot) => slot.plan.heavy);
        this.activeLightDecodes = 0;
        this.activeHeavyDecodes = 0;
        this.heavyPhaseStarted = false;
        this.heavyScheduled = false;

        this.pump();
    }

    /**
     * Snapshot in plan order. `lodVisible` is computed for the given view
     * resolution; pending and failed layers have no live layer and report false.
     */
    public getStats(viewResolution: number | null): MapViewTileStats[] {
        return this.slots.map((slot) => {
            const layer = slot.layer;
            const visible = layer !== null && layer.getVisible();
            slot.stats.lodVisible = visible
                && viewResolution !== null
                && viewResolution < slot.plan.maxResolution;

            return { ...slot.stats };
        });
    }

    /** Layer images still decoding or not yet added. Zero when the load is done. */
    public getPendingLayerCount(): number {
        return this.slots.reduce(
            (count, slot) => count + (slot.stats.pending ? 1 : 0),
            0,
        );
    }

    /** Combined error when every received layer failed, otherwise null. */
    public getAllFailedError(): string | null {
        if (!this.complete || this.slots.length === 0) {
            return null;
        }

        if (this.slots.some((slot) => slot.error === null)) {
            return null;
        }

        return this.slots
            .map((slot) => slot.error)
            .filter((error): error is string => error !== null)
            .join(' ');
    }

    /** Debug helper: how many decoded layer images are cached. */
    public getImageCacheSize(): number {
        return this.imageCache.size;
    }

    /** Removes every terrain layer/source and invalidates in-flight decodes. */
    public dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.epoch += 1;
        this.cancelScheduledHeavyPhase();
        this.disposeLayers();
        this.map.clearSourceRanks();

        this.slots = [];
        this.lightQueue = [];
        this.heavyQueue = [];
        this.layerData = [];
        this.imageCache.clear();
        this.pendingDecodes.clear();
        this.savedVisibility.clear();
    }

    /** Creates the slot for one arriving layer and queues its decode. */
    private addSlot(layer: TerrainLayer, documentIndex: number): void {
        const slot = this.createSlot(planTerrainLayer(layer, documentIndex));

        // Keep the debug snapshot in plan order even when arrival order differs.
        insertByPlan(this.slots, slot);
        insertByPlan(slot.plan.heavy ? this.heavyQueue : this.lightQueue, slot);
    }

    private createSlot(plan: TerrainLayerPlan): LayerSlot {
        return {
            plan,
            image: null,
            decoding: false,
            error: null,
            layer: null,
            stats: {
                name: plan.name,
                priority: plan.rank,
                pending: true,
                lodVisible: false,
                maxResolution: plan.maxResolution,
                activatedAfterMs: null,
                firstTileStartMs: null,
                error: null,
                started: 0,
                finished: 0,
                errored: 0,
                loading: 0,
            },
        };
    }

    /**
     * Single state machine: start as many decodes as the current phase allows
     * and move the heavy phase to an idle moment once the light layers are in.
     */
    private pump(): void {
        if (this.disposed || this.pumping) {
            return;
        }

        this.pumping = true;
        try {
            this.startDecodes();
        } finally {
            this.pumping = false;
        }

        this.maybeScheduleHeavyPhase();
    }

    /** Starts decodes for the light phase and, once idle, for the heavy phase. */
    private startDecodes(): void {
        while (this.activeLightDecodes < LIGHT_DECODE_CONCURRENCY) {
            const slot = this.lightQueue.find((entry) => !this.isResolved(entry));
            if (!slot || !this.beginDecode(slot, 'light')) {
                break;
            }
        }

        if (!this.heavyPhaseStarted) {
            return;
        }

        while (this.activeHeavyDecodes < HEAVY_DECODE_CONCURRENCY) {
            const slot = this.heavyQueue.find((entry) => !this.isResolved(entry));
            if (!slot || !this.beginDecode(slot, 'heavy')) {
                break;
            }
        }
    }

    private isResolved(slot: LayerSlot): boolean {
        return slot.image !== null || slot.error !== null || slot.decoding;
    }

    /** Starts one decode. Returns false when the layer was already handled. */
    private beginDecode(slot: LayerSlot, phase: 'light' | 'heavy'): boolean {
        if (this.isResolved(slot)) {
            return false;
        }

        const cached = this.imageCache.get(slot.plan.documentIndex);
        if (cached) {
            this.activate(slot, cached);
            return true;
        }

        slot.decoding = true;
        if (phase === 'light') {
            this.activeLightDecodes += 1;
        } else {
            this.activeHeavyDecodes += 1;
        }

        const epoch = this.epoch;
        const settle = (): boolean => {
            if (this.disposed || epoch !== this.epoch) {
                // The pipeline was restarted; counters belong to the new
                // generation and this slot is no longer tracked.
                return false;
            }

            if (phase === 'light') {
                this.activeLightDecodes -= 1;
            } else {
                this.activeHeavyDecodes -= 1;
            }

            return true;
        };

        this.decodeLayer(slot.plan.documentIndex)
            .then((image) => {
                if (!settle()) {
                    return;
                }

                slot.decoding = false;
                slot.image = image;
                this.activate(slot, image);
                this.pump();
            })
            .catch((error: unknown) => {
                if (!settle()) {
                    return;
                }

                slot.decoding = false;
                slot.error = error instanceof Error ? error.message : String(error);
                slot.stats.pending = false;
                slot.stats.error = slot.error;
                this.onStatsChanged();
                this.pump();
                this.maybeShowAllFailed();
            });

        return true;
    }

    /** Resolves a layer image, reusing a cache hit or an in-flight decode. */
    private decodeLayer(documentIndex: number): Promise<HTMLImageElement> {
        const cached = this.imageCache.get(documentIndex);
        if (cached) {
            return Promise.resolve(cached);
        }

        const pending = this.pendingDecodes.get(documentIndex);
        if (pending) {
            return pending;
        }

        const promise = loadTerrainLayerImage(this.layerData[documentIndex])
            .then((image) => {
                this.imageCache.set(documentIndex, image);
                return image;
            })
            .finally(() => {
                this.pendingDecodes.delete(documentIndex);
            });

        this.pendingDecodes.set(documentIndex, promise);
        return promise;
    }

    private maybeScheduleHeavyPhase(): void {
        if (this.disposed || this.heavyPhaseStarted || this.heavyScheduled) {
            return;
        }

        // Do not parse a heavy SVG before the reply is complete: a light layer
        // that is still transferring would otherwise be added after a heavy one.
        if (!this.complete) {
            return;
        }

        // Wait until every light layer is decoded and added, so the base render
        // never competes with a multi-megabyte SVG parse.
        if (this.lightQueue.some((slot) => !this.isResolved(slot))) {
            return;
        }

        if (this.heavyQueue.every((slot) => this.isResolved(slot))) {
            return;
        }

        // Decode the heavy layers as soon as their base tiles are on screen.
        // They are LOD-hidden at this view; this only makes them ready for the
        // first zoom-in.
        if (!this.baseTilesLoaded()) {
            return;
        }

        this.scheduleHeavyPhase();
    }

    /** True once every visible base light layer has loaded its first tiles. */
    private baseTilesLoaded(): boolean {
        for (const slot of this.lightQueue) {
            // LOD-gated light layers (e.g. mountains) are hidden at a whole-map
            // view and request no tiles, so they must not block the heavy phase.
            if (Number.isFinite(slot.plan.maxResolution)) {
                continue;
            }

            // A failed or user-hidden layer cannot load tiles and must not block
            // the heavy phase forever.
            if (slot.error !== null || !slot.layer || !slot.layer.getVisible()) {
                continue;
            }

            if (slot.stats.started === 0 || slot.stats.loading > 0) {
                return false;
            }
        }

        return true;
    }

    private scheduleHeavyPhase(): void {
        this.heavyScheduled = true;

        const run = (): void => {
            this.heavyTimer = null;
            if (this.disposed) {
                return;
            }

            // A new tile can start between the check and this task (the browser
            // may still be discovering tiles). Wait for the next tile end.
            if (!this.baseTilesLoaded()) {
                this.heavyScheduled = false;
                return;
            }

            this.heavyPhaseStarted = true;
            this.pump();
        };

        this.heavyTimer = window.setTimeout(run, HEAVY_PHASE_START_DELAY_MS);
    }

    private cancelScheduledHeavyPhase(): void {
        if (this.heavyTimer !== null) {
            window.clearTimeout(this.heavyTimer);
            this.heavyTimer = null;
        }

        this.heavyScheduled = false;
    }

    /** Adds a decoded layer to the map and wires its tile counters. */
    private activate(slot: LayerSlot, image: HTMLImageElement): void {
        slot.image = image;

        if (slot.layer) {
            return;
        }

        const layer = createTerrainTileLayer(slot.plan, image, {
            projection: this.projection,
            tileGrid: this.tileGrid,
            resolutions: this.resolutions,
            tileSize: this.settings.tileSize,
            smoothScaling: this.settings.smoothScaling,
            preload: this.settings.preload,
            cacheSize: this.settings.cacheSize,
        });

        const source = layer.getSource();
        if (source) {
            // Must be registered before addLayer: the renderer snapshots the
            // source uid when it enqueues the first tiles.
            this.map.registerSource(source, slot.plan.rank);
        }

        const savedVisibility = this.savedVisibility.get(slot.plan.name);
        if (savedVisibility === false) {
            layer.setVisible(false);
        }

        this.map.addLayer(layer);

        slot.layer = layer;
        slot.stats.pending = false;
        slot.stats.activatedAfterMs = performance.now() - this.startedAt;

        if (source) {
            source.on('tileloadstart', () => {
                slot.stats.started += 1;
                slot.stats.loading += 1;
                if (slot.stats.firstTileStartMs === null) {
                    slot.stats.firstTileStartMs = performance.now() - this.startedAt;
                }
                this.onTileActivity();
                this.onStatsChanged();
            });

            source.on('tileloadend', () => {
                slot.stats.finished += 1;
                slot.stats.loading = Math.max(0, slot.stats.loading - 1);
                this.onTileActivity();
                this.onStatsChanged();
                this.maybeScheduleHeavyPhase();
            });

            source.on('tileloaderror', () => {
                slot.stats.errored += 1;
                slot.stats.loading = Math.max(0, slot.stats.loading - 1);
                this.onTileActivity();
                this.onStatsChanged();
                this.maybeScheduleHeavyPhase();
            });
        }

        this.onTileActivity();
        this.onStatsChanged();
    }

    private maybeShowAllFailed(): void {
        if (this.complete && this.getAllFailedError() !== null) {
            this.onStatsChanged();
        }
    }

    private saveVisibility(): void {
        for (const slot of this.slots) {
            if (slot.layer) {
                this.savedVisibility.set(slot.plan.name, slot.layer.getVisible());
            }
        }
    }

    private disposeLayers(): void {
        for (const slot of this.slots) {
            const layer = slot.layer;
            if (!layer) {
                continue;
            }

            this.map.removeLayer(layer);

            // Do not call layer.dispose() here. It nulls the layer stored in the
            // shared layer state, but Map.frameState_ keeps referencing that
            // state until the next render. A pointermove in between makes
            // forEachFeatureAtPixel() hit `null.hasRenderer()` and throw.
            layer.clearRenderer();

            const source = layer.getSource();
            layer.setSource(null);
            source?.dispose();

            slot.layer = null;
        }
    }
}
