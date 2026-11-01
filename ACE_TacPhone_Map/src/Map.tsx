import React, { createRef, type RefObject } from 'react'
import styles from './styles.module.scss'

import "ol/ol.css";
import type { AppProps, TerrainData, TerrainLayer } from '@ace-tacphone/api';
import Map from "ol/Map";
import { View } from 'ol';
import type { ViewOptions } from 'ol/View.js';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Polygon from 'ol/geom/Polygon';
import Circle from 'ol/geom/Circle';
import { Style, Stroke, Fill } from 'ol/style';
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom';
import DragRotate from 'ol/interaction/DragRotate';
import PinchRotate from 'ol/interaction/PinchRotate';
import Zoom from 'ol/control/Zoom';


import Projection from 'ol/proj/Projection';
import { getTopLeft } from 'ol/extent.js';
import TileGrid from 'ol/tilegrid/TileGrid.js';
import ImageTileSource from 'ol/source/ImageTile';

import { LayerSwitcher } from './LayerSwitcher';
import { MarkerOverlay, type MarkerOverlayHandle } from './MapMarkers/MarkerOverlay';
import { LayerSwitcherRegistry } from './MapMarkers/LayerSwitcherRegistry';
import {
    onMapRenderSettingsChanged,
    readMapRenderSettings,
    type MapRenderSettings,
} from './MapOptions';
import {
    MAP_SERVICE,
    MAP_SERVICE_VERSION,
    type MapApi,
    type MapBoundingBox,
    type MapFlyToOptions,
    type MapFocusMarkerOptions,
} from './api';
import {
    registerMapViewTestProbe,
    unregisterMapViewTestProbe,
    type MapHighlightState,
    type MapViewDebugState,
    type MapViewTileStats,
} from './MapMarkers/MapTestHooks';
import { t } from './i18n';

// The view's zoom-out limit must not depend on the user's tile size: a 512 px
// tile would otherwise fit only half of the terrain into the viewport.
const VIEW_REFERENCE_TILE_SIZE = 256;
// Placeholder size until the terrain layers report the real one.
const INITIAL_TERRAIN_EXTENT: [number, number, number, number] = [0, 0, 30720, 30720];

/** Temporary glowing outline used by `flyTo({ highlight: true })`. */
const FLY_TO_HIGHLIGHT_STYLE = [
    new Style({
        stroke: new Stroke({ color: 'rgba(34, 211, 238, 0.30)', width: 16 }),
        fill: new Fill({ color: 'rgba(34, 211, 238, 0.10)' }),
    }),
    new Style({
        stroke: new Stroke({ color: 'rgba(34, 211, 238, 0.95)', width: 3 }),
        fill: new Fill({ color: 'rgba(34, 211, 238, 0.06)' }),
    }),
];
const FLY_TO_HIGHLIGHT_MS = 2600;
const FLY_TO_FIT_MARGIN_PX = 48;

interface MapState {
  layerSwitcherIsOpen: boolean;
  terrainError: string | null;
}

class App extends React.Component<AppProps,MapState> {
    // Setup the ref for the map canvas container element
    private mapRef: RefObject<HTMLDivElement | null> = createRef();
    // Keep the map instance directly on the class instance
    private map: Map | null = null;
    private terrainLayers: TileLayer<ImageTileSource>[] = [];
    private terrainLoadToken = 0;
    private terrainViewReady = false;
    /** Per-layer tile load counters for the debug test hook. */
    private terrainTileStats: MapViewTileStats[] = [];
    private lastTerrainTileEventAt = 0;

    private highlightSource: VectorSource | null = null;
    private highlightLayer: VectorLayer<VectorSource> | null = null;
    private highlightTimer: number | null = null;
    private highlightState: MapHighlightState | null = null;
    /** Decoded terrain layers, kept so option changes can rebuild tiles without a game request. */
    private terrainSource: {
        extent: [number, number, number, number];
        layers: Array<{ name: string; image: HTMLImageElement }>;
    } | null = null;

    /** Current tiling/rendering settings, refreshed when the host options change. */
    private renderSettings: MapRenderSettings | undefined;
    private unsubscribeOptions: (() => void) | undefined;

    private markerUiRef = createRef<MarkerOverlayHandle>();
    private readonly layerSwitcherSections = new LayerSwitcherRegistry();

    /** Unregister function for the Map API. */
    private unregisterMapApi: (() => void) | undefined;

    constructor(props: AppProps) {
        super(props);
        this.state = {
            layerSwitcherIsOpen: false,
            terrainError: null,
        };
    }

    private getRenderSettings(): MapRenderSettings {
        if (!this.renderSettings)
            this.renderSettings = readMapRenderSettings();

        return this.renderSettings;
    }

    private getPreservedViewState(
        previousView: View | null,
        extent: [number, number, number, number],
        maxResolution: number,
    ): { center: [number, number]; resolution: number } | null {
        if (!previousView) {
            return null;
        }

        const center = previousView.getCenter();
        const resolution = previousView.getResolution();
        const minResolution = this.getRenderSettings().minResolution;

        if (
            !center ||
            !Number.isFinite(center[0]) ||
            !Number.isFinite(center[1]) ||
            typeof resolution !== 'number' ||
            !Number.isFinite(resolution) ||
            center[0] < extent[0] || center[0] > extent[2] ||
            center[1] < extent[1] || center[1] > extent[3] ||
            resolution < minResolution || resolution > maxResolution
        ) {
            return null;
        }

        return { center: [center[0], center[1]], resolution };
    }

    private createTerrainView(
        projection: Projection,
        extent: [number, number, number, number],
        previousView: View | null,
    ): { view: View; preserved: boolean } {
        const minResolution = this.getRenderSettings().minResolution;

        // At this resolution a single reference-sized tile covers the whole
        // terrain, so it is the farthest the view needs to zoom out. The extent
        // constraint caps it further when the panel is larger than that tile.
        const maxResolution = Math.max(
            Math.max(extent[2] - extent[0], extent[3] - extent[1]) / VIEW_REFERENCE_TILE_SIZE,
            minResolution,
        );

        const options: ViewOptions = {
            projection,
            extent,
            // Let fit() show the whole terrain on panels whose aspect ratio differs
            // from the terrain instead of clipping one axis.
            showFullExtent: true,
            // The map is north-up only: the rotation constraint ignores every
            // rotation, including two-finger rotate and programmatic calls.
            enableRotation: false,
            minResolution,
            maxResolution,
            center: [
                (extent[0] + extent[2]) / 2,
                (extent[1] + extent[3]) / 2,
            ],
            resolution: maxResolution,
        };

        const preservedState = this.getPreservedViewState(previousView, extent, maxResolution);
        if (preservedState) {
            options.center = preservedState.center;
            options.resolution = preservedState.resolution;
        }

        return { view: new View(options), preserved: preservedState !== null };
    }

    componentDidMount() {

        if (!this.mapRef.current) return;

        registerMapViewTestProbe(this);

        this.renderSettings = readMapRenderSettings();

        var projection = new Projection({
            code: 'static-image',
            units: 'pixels',
            extent: INITIAL_TERRAIN_EXTENT
        });

        const map = new Map({
            target: this.mapRef.current,
            layers: [],
            pixelRatio: this.renderSettings.pixelRatio,
            view: this.createTerrainView(projection, INITIAL_TERRAIN_EXTENT, null).view,
        });
        this.map = map;

        // The phone UI has no room for OL's +/- zoom buttons; wheel and pinch
        // zoom stay available.
        map.getControls().forEach((control) => {
            if (control instanceof Zoom) {
                map.removeControl(control);
            }
        });

        this.highlightSource = new VectorSource();
        this.highlightLayer = new VectorLayer({
            source: this.highlightSource,
            style: FLY_TO_HIGHLIGHT_STYLE,
            zIndex: 100,
        });
        map.addLayer(this.highlightLayer);

        // Options changed from the host Options panel apply to the live map.
        this.unsubscribeOptions = onMapRenderSettingsChanged(this.applyRenderSettings);

        // The map instance is imperative, so re-render to hand it to the layer
        // switcher and marker overlay. Register the Map API only after that
        // commit, so focusMarker() can reach the mounted marker module.
        this.forceUpdate(() => {
            if (this.map) {
                this.buildAndRegisterMapApi();
            }
        });

        // Double-click zoom and rotation are removed: the map stays north-up,
        // and a two-finger touch only pans/zooms instead of rotating.
        [...map.getInteractions().getArray()].forEach((interaction) => {
            if (
                interaction instanceof DoubleClickZoom ||
                interaction instanceof DragRotate ||
                interaction instanceof PinchRotate
            ) {
                map.removeInteraction(interaction);
            }
        });

        void window.TacPhone.networking
            .LoadGameTerrain({ drawTreeObjects: false, layerMountains: true, simpleRoads: true })
            .then((terrain) => this.applyTerrainLayers(terrain))
            .catch((error: unknown) => {
                console.error('Failed to load map terrain', error);
                this.showTerrainError(error);
            });
    }

    /**
     * Applies a view move, queueing it until the terrain view exists. This is
     * the implementation of `MapApi.flyTo()` and of marker focusing.
     */
    private flyToCoordinate(options: MapFlyToOptions): void {
        const bbox = this.readBoundingBox(options.bbox);
        if (options.bbox !== undefined && bbox === null) {
            console.warn('MapApi.flyTo: invalid bounding box, expected [minX, minY, maxX, maxY]');
        }

        const hasCenter = typeof options.x === 'number'
            && typeof options.y === 'number'
            && Number.isFinite(options.x)
            && Number.isFinite(options.y);

        if (!bbox && !hasCenter) {
            console.warn('MapApi.flyTo: invalid x/y coordinates');
            return;
        }

        // The terrain view is replaced once the SVG arrives, so a request
        // that arrives before then is applied by applyPendingFlyTo().
        if (!this.map || !this.terrainViewReady) {
            this.pendingFlyTo = options;
            return;
        }

        const view = this.map.getView();
        const projection = view.getProjection();

        const center: [number, number] = bbox
            ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
            : [options.x as number, options.y as number];

        // Clamp the center to the current view projection extent when one exists
        const extent = projection.getExtent();
        if (extent) {
            center[0] = Math.max(extent[0], Math.min(center[0], extent[2]));
            center[1] = Math.max(extent[1], Math.min(center[1], extent[3]));
        }

        // Only apply resolution when it is a finite positive number. A bounding
        // box without an explicit resolution is fitted to the viewport.
        let resolution = options.resolution !== undefined
            && Number.isFinite(options.resolution)
            && options.resolution > 0
            ? options.resolution
            : undefined;

        if (resolution === undefined && bbox) {
            const size = this.map.getSize();
            const width = Math.max(1, (size?.[0] ?? 512) - FLY_TO_FIT_MARGIN_PX * 2);
            const height = Math.max(1, (size?.[1] ?? 512) - FLY_TO_FIT_MARGIN_PX * 2);
            const fitted = Math.max((bbox[2] - bbox[0]) / width, (bbox[3] - bbox[1]) / height);

            if (Number.isFinite(fitted) && fitted > 0) {
                resolution = Math.min(
                    view.getMaxResolution(),
                    Math.max(view.getMinResolution(), fitted),
                );
            }
        }

        if (options.animate !== false) {
            const animation: { center: number[]; resolution?: number; duration: number } = { center, duration: 450 };
            if (resolution !== undefined)
                animation.resolution = resolution;
            view.animate(animation);
        } else {
            view.setCenter(center);
            if (resolution !== undefined) {
                view.setResolution(resolution);
            }
        }

        if (options.highlight) {
            let highlightBbox = bbox;

            if (
                bbox
                && resolution !== undefined
                && options.highlightSizePx !== undefined
                && Number.isFinite(options.highlightSizePx)
                && options.highlightSizePx > 0
            ) {
                const half = (options.highlightSizePx * resolution) / 2;
                highlightBbox = [center[0] - half, center[1] - half, center[0] + half, center[1] + half];
            }

            this.showFlyToHighlight(highlightBbox, center, resolution ?? view.getResolution() ?? undefined);
        } else {
            this.clearFlyToHighlight();
        }
    }

    /** Validates and copies a world-space bounding box. */
    private readBoundingBox(value: MapBoundingBox | undefined): MapBoundingBox | null {
        if (
            !Array.isArray(value)
            || value.length !== 4
            || !value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
        ) {
            return null;
        }

        const [minX, minY, maxX, maxY] = value;
        return minX < maxX && minY < maxY ? [minX, minY, maxX, maxY] : null;
    }

    /** Shows the temporary glowing box/circle used by `flyTo({ highlight: true })`. */
    private showFlyToHighlight(
        bbox: MapBoundingBox | null,
        center: [number, number],
        resolution: number | undefined,
    ): void {
        const source = this.highlightSource;
        if (!source) {
            return;
        }

        this.clearFlyToHighlight();

        const geometry = bbox
            ? new Polygon([[
                [bbox[0], bbox[1]],
                [bbox[2], bbox[1]],
                [bbox[2], bbox[3]],
                [bbox[0], bbox[3]],
                [bbox[0], bbox[1]],
            ]])
            : new Circle(center, Math.max((resolution ?? 1) * 80, 1));

        source.addFeature(new Feature({ geometry }));
        this.highlightState = {
            active: true,
            kind: bbox ? 'box' : 'circle',
            bbox: bbox ? [...bbox] : null,
        };
        this.highlightTimer = window.setTimeout(() => this.clearFlyToHighlight(), FLY_TO_HIGHLIGHT_MS);
    }

    /** Removes the temporary glow and cancels its timeout. */
    private clearFlyToHighlight(): void {
        if (this.highlightTimer !== null) {
            window.clearTimeout(this.highlightTimer);
            this.highlightTimer = null;
        }

        this.highlightSource?.clear();
        this.highlightState = null;
    }

    private buildAndRegisterMapApi(): void {
        if (this.map === null) {
            return;
        }

        /**
         * The MapApi public interface for other apps:
         * - flyTo(options): move the map view
         * - getView(): get current view state
         * - isReady(): check if API is available
         * - hasMarker(name): check if a marker exists
         * - focusMarker(name): fly to a marker, resolving false when it is gone
         */
        const api: MapApi = {
            flyTo: (options: MapFlyToOptions) => {
                this.flyToCoordinate(options);
            },
            getView: () => {
                if (!this.terrainViewReady || this.map === null) {
                    return undefined;
                }

                const view = this.map.getView();
                const center = view.getCenter();
                const resolution = view.getResolution();

                if (
                    !center ||
                    !Number.isFinite(center[0]) ||
                    !Number.isFinite(center[1]) ||
                    typeof resolution !== 'number' ||
                    !Number.isFinite(resolution)
                ) {
                    return undefined;
                }

                return { x: center[0], y: center[1], resolution };
            },
            isReady: () => {
                return this.terrainViewReady && this.map !== null;
            },
            hasMarker: (name: string) => {
                return typeof name === 'string' && name !== '' && this.markerUiRef.current?.hasMarker(name) === true;
            },
            focusMarker: (name: string, options?: MapFocusMarkerOptions) => {
                return this.markerUiRef.current?.focusMarker(name, options) ?? Promise.resolve(false);
            },
        };

        const registration = window.TacPhone.interApp.register(this.props.panel, {
            service: MAP_SERVICE,
            version: MAP_SERVICE_VERSION,
            api,
        });

        this.unregisterMapApi = registration;
    }

    /**
     * Debug-only terrain state for the browser tests: whether the view is ready
     * and how many tiles each terrain layer has started/finished loading.
     */
    public getMapViewDebugState(): MapViewDebugState {
        const tiles = this.terrainTileStats.map((stats) => ({ ...stats }));
        const started = tiles.reduce((total, stats) => total + stats.started, 0);
        const finished = tiles.reduce((total, stats) => total + stats.finished, 0);
        const errored = tiles.reduce((total, stats) => total + stats.errored, 0);
        const loading = tiles.reduce((total, stats) => total + stats.loading, 0);

        return {
            ready: this.terrainViewReady && this.map !== null,
            tiles,
            started,
            finished,
            errored,
            loading,
            quietForMs: this.lastTerrainTileEventAt === 0
                ? 0
                : Math.max(0, Date.now() - this.lastTerrainTileEventAt),
            settled: started > 0 && loading === 0,
            highlight: this.highlightState
                ? {
                    ...this.highlightState,
                    bbox: this.highlightState.bbox ? [...this.highlightState.bbox] : null,
                }
                : null,
        };
    }

    componentWillUnmount(): void {
        unregisterMapViewTestProbe(this);
        this.clearFlyToHighlight();

        if (this.highlightLayer) {
            this.map?.removeLayer(this.highlightLayer);
            this.highlightLayer.setSource(null);
            this.highlightLayer = null;
        }
        this.highlightSource?.dispose();
        this.highlightSource = null;

        /**
         * Unregister the MapApi BEFORE map teardown, so that window.TacPhone.interApp.list()
         * and other lookups see the cleanup immediately. The pendingFlyTo is now
         * stale (map is null), so we clear it as well.
         */
        if (this.unregisterMapApi) {
            this.unregisterMapApi();
            this.unregisterMapApi = undefined;
        }

        if (this.unsubscribeOptions) {
            this.unsubscribeOptions();
            this.unsubscribeOptions = undefined;
        }

        /** Clear pending fly-to on unmount. */
        this.pendingFlyTo = null;

        this.terrainLoadToken += 1;
        this.terrainSource = null;

        const map = this.map;
        this.map = null;

        if (map) {
            // Detach the map from the DOM target
            map.setTarget(undefined);
        }

        // this.map is already null, so this only disposes the tile sources.
        this.disposeTerrainLayers();
    }

    private toggleLayerSwitcherMenu = (): void => {
        // The two panels share the same corner; never let them overlap.
        const aboutToOpen = !this.state.layerSwitcherIsOpen;
        if (aboutToOpen) {
            this.markerUiRef.current?.stopPolyline();
        }

        this.setState((prevState) => ({ layerSwitcherIsOpen: !prevState.layerSwitcherIsOpen }));
    };

    private closeLayerSwitcherMenu = (): void => {
        this.setState({ layerSwitcherIsOpen: false });
    };

    private showTerrainError(error: unknown): void {
        if (!this.map) {
            return;
        }

        this.setState({
            terrainError: error instanceof Error ? error.message : String(error),
        });
    }

    private loadTerrainLayerImage(layer: TerrainLayer): Promise<{ name: string; image: HTMLImageElement }> {
        return new Promise((resolve, reject) => {
            const image = new Image();
            const imageUrl = URL.createObjectURL(
                new Blob([layer.svg], { type: "image/svg+xml;charset=utf-8" }),
            );

            image.onload = () => {
                // The browser no longer needs the blob URL once the image is decoded.
                URL.revokeObjectURL(imageUrl);
                resolve({ name: layer.name, image });
            };

            image.onerror = () => {
                URL.revokeObjectURL(imageUrl);
                reject(new Error(`Failed to load terrain layer "${layer.name}".`));
            };

            image.src = imageUrl;
        });
    }

    private disposeTerrainLayers(): void {
        this.terrainTileStats = [];
        this.lastTerrainTileEventAt = 0;

        const map = this.map;
        const layers = this.terrainLayers;
        this.terrainLayers = [];

        for (const layer of layers) {
            map?.removeLayer(layer);

            // Do not call layer.dispose() here. It nulls the layer stored in the
            // shared layer state, but Map.frameState_ keeps referencing that state
            // until the next render. A pointermove in between makes
            // forEachFeatureAtPixel() hit `null.hasRenderer()` and throw.
            // Clearing the renderer and source releases the same resources
            // without invalidating the last frame state.
            layer.clearRenderer();

            const source = layer.getSource();
            layer.setSource(null);
            source?.dispose();
        }
    }

    private async applyTerrainLayers(terrain: TerrainData): Promise<void> {
        const map = this.map;
        if (!map) {
            return;
        }

        const loadToken = ++this.terrainLoadToken;
        this.setState({ terrainError: null });

        // Load every split SVG image first, so a failure cannot leave
        // half-created tile sources behind.
        const loadedLayers = await Promise.all(
            terrain.layers.map((layer) => this.loadTerrainLayerImage(layer))
        ).catch((error: unknown) => {
            // Ignore failures from a load that has already been superseded.
            if (this.map === map && loadToken === this.terrainLoadToken) {
                throw error;
            }

            return null;
        });

        if (!loadedLayers || this.map !== map || loadToken !== this.terrainLoadToken) {
            return;
        }

        // Keep the decoded layers so option changes can rebuild the tile sources
        // without asking the game for the terrain again.
        this.terrainSource = {
            extent: [0, 0, terrain.width, terrain.height],
            layers: loadedLayers,
        };

        this.rebuildTerrainLayers();
    }

    /**
     * Builds the terrain tile layers from the decoded images and the current
     * render settings. Used for the first load and whenever a tiling option
     * changes, without touching the game-side terrain data.
     */
    private rebuildTerrainLayers(): void {
        const map = this.map;
        const terrain = this.terrainSource;
        if (!map || !terrain) {
            return;
        }

        const settings = this.getRenderSettings();
        const extent = terrain.extent;
        const tileSize = settings.tileSize;
        const projection = map.getView().getProjection();
        projection.setExtent(extent);

        // Zoom levels from the coarsest (2^maxZoom map units per pixel) down to
        // the profile's finest resolution.
        const resolutions: number[] = [];
        for (let z = 0; z <= settings.maxZoom; z++) {
            resolutions.push(Math.pow(2, settings.maxZoom - z));
        }
        resolutions.push(settings.minResolution);

        const tileGrid = new TileGrid({
            origin: getTopLeft(extent),
            resolutions,
            tileSize,
        });

        const newLayers: TileLayer<ImageTileSource>[] = [];
        try {
            for (const loadedLayer of terrain.layers) {
                const tileImage = loadedLayer.image;

                const svgTileSource = new ImageTileSource({
                    tileGrid,
                    projection,
                    interpolate: settings.smoothScaling,
                    // The loader function handles slicing on demand.
                    loader: (z, x, y) => {
                        return new Promise((resolve, reject) => {
                            // Calculate how many raw coordinate map units fit inside this single screen slice
                            const resolution = resolutions[z];
                            const chunkWidth = tileSize * resolution;
                            const chunkHeight = tileSize * resolution;

                            // Pinpoint the exact viewport frame block context to isolate and crop
                            const svgX = x * chunkWidth;
                            const svgY = y * chunkHeight;

                            // Draw the computed vector fragment text onto an offscreen canvas component
                            const canvas = document.createElement('canvas');
                            canvas.width = tileSize;
                            canvas.height = tileSize;
                            const ctx = canvas.getContext('2d');

                            if (!ctx) {
                                reject(new Error('Failed to create a 2D canvas context for the terrain tile.'));
                                return;
                            }

                            ctx.imageSmoothingEnabled = settings.smoothScaling;

                            // Instantaneous Blit/Crop: Sub-sections of the single pre-cached image are drawn directly
                            ctx.drawImage(
                                tileImage,
                                svgX, svgY, chunkWidth, chunkHeight, // Bounding source box (Crop area on SVG)
                                0, 0, tileSize, tileSize             // Target destination box
                            );

                            resolve(canvas);
                        });
                    },
                });

                newLayers.push(new TileLayer({
                    properties: {title: loadedLayer.name},
                    source: svgTileSource,
                    preload: settings.tilePreload,
                    // A phone-sized viewport only needs a few tiles per layer. The
                    // default (512) keeps hundreds of MiB of canvases per layer alive.
                    cacheSize: settings.tileCacheSize,
                }));
            }
        } catch (error) {
            newLayers.forEach((layer) => {
                const source = layer.getSource();
                layer.setSource(null);
                source?.dispose();
                layer.dispose();
            });
            throw error;
        }

        // Replace any previous terrain layers so repeated rebuilds cannot stack duplicates.
        this.disposeTerrainLayers();

        this.terrainTileStats = [];
        this.lastTerrainTileEventAt = Date.now();

        newLayers.forEach((layer) => {
            map.addLayer(layer);

            const source = layer.getSource();
            const layerName = layer.get('title');
            if (!source) {
                return;
            }

            const stats: MapViewTileStats = {
                name: typeof layerName === 'string' ? layerName : 'Terrain',
                started: 0,
                finished: 0,
                errored: 0,
                loading: 0,
            };

            source.on('tileloadstart', () => {
                stats.started += 1;
                stats.loading += 1;
                this.lastTerrainTileEventAt = Date.now();
            });
            source.on('tileloadend', () => {
                stats.finished += 1;
                stats.loading = Math.max(0, stats.loading - 1);
                this.lastTerrainTileEventAt = Date.now();
            });
            source.on('tileloaderror', () => {
                stats.errored += 1;
                stats.loading = Math.max(0, stats.loading - 1);
                this.lastTerrainTileEventAt = Date.now();
            });

            this.terrainTileStats.push(stats);
        });
        this.terrainLayers = newLayers;

        // The view constraints depend on the actual terrain size, so they can only
        // be built now. Views have no setExtent(), hence the replacement view.
        const previousView = this.terrainViewReady ? map.getView() : null;
        const { view, preserved } = this.createTerrainView(projection, extent, previousView);
        map.setView(view);
        this.terrainViewReady = true;

        // Keep the user's position on a rebuild; on the first load (or if the old
        // position no longer fits the current profile) show the whole map.
        if (!preserved) {
            view.fit(extent, {
                duration: 1000
            });
        }

        // A flyTo() that arrived before the terrain view existed must win over the
        // initial fit, so it is applied last.
        if (this.pendingFlyTo) {
            this.applyPendingFlyTo();
        }
    }

    /** Applies changed Options values to the live map. */
    private applyRenderSettings = (settings: MapRenderSettings): void => {
        const previous = this.renderSettings;
        this.renderSettings = settings;

        if (!previous)
            return;

        if (previous.pixelRatio !== settings.pixelRatio)
            this.map?.setPixelRatio(settings.pixelRatio);

        const tilingChanged = previous.terrainQuality !== settings.terrainQuality
            || previous.tileSize !== settings.tileSize
            || previous.tileCacheSize !== settings.tileCacheSize
            || previous.tilePreload !== settings.tilePreload
            || previous.smoothScaling !== settings.smoothScaling;

        if (tilingChanged)
            this.rebuildTerrainLayers();
    };

    private pendingFlyTo: MapFlyToOptions | null = null;

    /**
     * Apply a pending fly-to request from before the terrain was ready.
     */
    private applyPendingFlyTo(): void {
        const pending = this.pendingFlyTo;
        if (!pending) {
            return;
        }

        this.pendingFlyTo = null;

        const view = this.map?.getView();
        if (!view) {
            console.warn('MapApi: applyPendingFlyTo() called but the map is not ready');
            return;
        }

        const projection = view.getProjection();

        // Validate x/y are finite numbers
        if (
            typeof pending.x !== 'number' ||
            typeof pending.y !== 'number' ||
            !Number.isFinite(pending.x) ||
            !Number.isFinite(pending.y)
        ) {
            console.warn('MapApi: pending fly-to has invalid x/y');
            return;
        }

        const center = [pending.x, pending.y];

        // Clamp the center to the current view projection extent when one exists
        const extent = projection.getExtent();
        if (extent) {
            center[0] = Math.max(extent[0], Math.min(pending.x, extent[2]));
            center[1] = Math.max(extent[1], Math.min(pending.y, extent[3]));
        }

        // Only apply resolution when it is a finite positive number
        const resolution = pending.resolution !== undefined && Number.isFinite(pending.resolution) && pending.resolution > 0 ? pending.resolution : undefined;

        if (pending.animate !== false) {
            const animation: { center: number[]; resolution?: number; duration: number } = { center, duration: 300 };
            if (resolution !== undefined)
                animation.resolution = resolution;
            view.animate(animation);
        } else {
            view.setCenter(center);
            if (resolution !== undefined) {
                view.setResolution(resolution);
            }
        }
    }

    render() {
        return (
            // `overflow: hidden` keeps the OpenLayers canvas rounding from
            // making the flexlayout tab scrollable by a pixel or two, which
            // would let Chrome claim touch drags as pans (pointercancel).
            <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>

                <div ref={this.mapRef} className={`${styles.map}`} style={{width: "100%", height: "100%"}}/>

                <LayerSwitcher
                    map={this.map}
                    isOpen={this.state.layerSwitcherIsOpen}
                    onToggle={this.toggleLayerSwitcherMenu}
                    onClose={this.closeLayerSwitcherMenu}
                    sections={this.layerSwitcherSections}
                />

                <MarkerOverlay
                    ref={this.markerUiRef}
                    map={this.map}
                    mapContainer={this.mapRef.current}
                    layerSwitcher={this.layerSwitcherSections}
                    flyTo={(options) => this.flyToCoordinate(options)}
                    onRequestCloseLayers={this.closeLayerSwitcherMenu}
                />

                {this.state.terrainError && (
                    <div
                        role="alert"
                        style={{
                            position: 'absolute',
                            top: 15,
                            left: 15,
                            zIndex: 1000,
                            maxWidth: 'calc(100% - 30px)',
                            padding: '8px 12px',
                            border: '1px solid #fca5a5',
                            borderRadius: 4,
                            background: '#fee2e2',
                            color: '#991b1b',
                            fontSize: 13,
                        }}
                    >
                        {t('STR_ACE_Tacphone_Map_TerrainError')}: {this.state.terrainError}
                    </div>
                )}
            </div>
        );
    }
}

export default App
