import React, { createRef, type RefObject } from 'react'
import styles from './styles.module.scss'

import "ol/ol.css";
import type { AppProps, TerrainData, TerrainLayer, TerrainLayerProgress } from '@ace-tacphone/api';
import { View } from 'ol';
import type { ViewOptions } from 'ol/View.js';
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

import { LayerSwitcher } from './LayerSwitcher';
import { MarkerOverlay, type MarkerOverlayHandle } from './MapMarkers/MarkerOverlay';
import { GpsOverlay, type GpsOverlayHandle } from './MapGps/GpsOverlay';
import { LayerSwitcherRegistry } from './MapMarkers/LayerSwitcherRegistry';
import {
    onMapRenderSettingsChanged,
    readMapRenderSettings,
    type MapRenderSettings,
} from './MapOptions';
import {
    GPS_SERVICE,
    GPS_SERVICE_VERSION,
    MAP_SERVICE,
    MAP_SERVICE_VERSION,
    type GpsApi,
    type GpsStartRouteOptions,
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
} from './MapMarkers/MapTestHooks';
import { PriorityMap } from './layers/PriorityMap';
import { TerrainLayerPipeline, type TerrainTileSettings } from './layers/TerrainLayerPipeline';
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
  terrainData: TerrainData | null;
}

class App extends React.Component<AppProps & { mode?: 'map' | 'gps' }, MapState> {
    // Setup the ref for the map canvas container element
    private mapRef: RefObject<HTMLDivElement | null> = createRef();
    // Keep the map instance directly on the class instance
    private map: PriorityMap | null = null;
    private terrainPipeline: TerrainLayerPipeline | null = null;
    private terrainLoadToken = 0;
    private terrainViewReady = false;
    private lastTerrainTileEventAt = 0;

    private highlightSource: VectorSource | null = null;
    private highlightLayer: VectorLayer<VectorSource> | null = null;
    private highlightTimer: number | null = null;
    private highlightState: MapHighlightState | null = null;
    /** Terrain metadata, kept so option changes can rebuild tiles without a game request. */
    private terrainSource: {
        extent: [number, number, number, number];
        layers: TerrainLayer[];
    } | null = null;

    /** Current tiling/rendering settings, refreshed when the host options change. */
    private renderSettings: MapRenderSettings | undefined;
    private unsubscribeOptions: (() => void) | undefined;

    private markerUiRef = createRef<MarkerOverlayHandle>();
    private gpsUiRef = createRef<GpsOverlayHandle>();
    private readonly layerSwitcherSections = new LayerSwitcherRegistry();

    private get isGps(): boolean {
        return this.props.mode === 'gps';
    }

    /** Unregister function for the Map API. */
    private unregisterMapApi: (() => void) | undefined;
    /** Unregister function for the GPS-only API (GPS panels only). */
    private unregisterGpsApi: (() => void) | undefined;

    constructor(props: AppProps) {
        super(props);
        this.state = {
            layerSwitcherIsOpen: false,
            terrainError: null,
            terrainData: null,
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
            // The regular Map is north-up only. GPS mode allows programmatic
            // rotation to follow the view direction.
            enableRotation: this.isGps,
            constrainRotation: this.isGps ? false : true,
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

        const map = new PriorityMap({
            target: this.mapRef.current,
            layers: [],
            pixelRatio: this.renderSettings.pixelRatio,
            view: this.createTerrainView(projection, INITIAL_TERRAIN_EXTENT, null).view,
        });
        this.map = map;

        // A Map in a background tab is `display: none`, so the viewport starts
        // at 0x0 and only gets a real size when the tab is selected. The fit
        // and queued fly-to requests wait for that size.
        map.on('change:size', this.handleMapSizeChange);

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

        this.startTerrainLoad();
    }

    /**
     * Requests the terrain and renders every layer the host delivers, instead of
     * waiting for the complete reply. Light layers arrive first, so the map
     * becomes visible while the heavy SVG layers are still transferring.
     */
    private startTerrainLoad(): void {
        const loadToken = ++this.terrainLoadToken;

        void window.TacPhone.networking
            .LoadGameTerrain(
                { drawTreeObjects: false, layerMountains: true, simpleRoads: true },
                (progress) => {
                    if (this.map && loadToken === this.terrainLoadToken) {
                        this.receiveTerrainLayer(progress);
                    }
                },
            )
            .then((terrain) => {
                if (!this.map || loadToken !== this.terrainLoadToken) {
                    return;
                }

                this.applyTerrainLayers(terrain);
            })
            .catch((error: unknown) => {
                if (loadToken !== this.terrainLoadToken) {
                    return;
                }

                console.error('Failed to load map terrain', error);
                this.showTerrainError(error);
            });
    }

    /**
     * Applies a view move, queueing it until the terrain view exists and the
     * map has a measurable viewport. This is the implementation of
     * `MapApi.flyTo()` and of marker focusing.
     */
    private flyToCoordinate(options: MapFlyToOptions): void {
        this.gpsUiRef.current?.suspendFollow();

        // The terrain view is replaced once the SVG arrives, and a Map in a
        // background tab is `display: none`, so OpenLayers reports a 0x0
        // viewport. A bbox fit would compute a meaningless resolution there;
        // apply the request when the view exists and the tab is shown.
        if (!this.map || !this.terrainViewReady || !this.hasMapArea()) {
            this.pendingFlyTo = options;
            return;
        }

        this.applyFlyToNow(options);
    }

    /** Applies one validated view move to the live, measured map. */
    private applyFlyToNow(options: MapFlyToOptions): void {
        const map = this.map;
        if (!map) {
            return;
        }

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

        const view = map.getView();
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
            const size = map.getSize();
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

        this.unregisterMapApi?.();
        this.unregisterMapApi = undefined;
        this.unregisterGpsApi?.();
        this.unregisterGpsApi = undefined;

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

        this.unregisterMapApi = window.TacPhone.interApp.register(this.props.panel, {
            service: MAP_SERVICE,
            version: MAP_SERVICE_VERSION,
            api,
        });

        // GPS commands target only GPS panels. A regular Map panel never
        // registers this service, so routing cannot select the wrong panel.
        if (this.isGps) {
            const gpsApi: GpsApi = {
                // A GPS is a Map: inherit the map methods and add route control.
                ...api,
                openSharedRoute: (route: unknown) => {
                    return this.gpsUiRef.current?.openSharedRoute(route) ?? Promise.resolve(false);
                },
                startRouteTo: (position: [number, number], options?: GpsStartRouteOptions) => {
                    return this.gpsUiRef.current?.startRouteTo(position, options)
                        ?? Promise.resolve(false);
                },
            };

            this.unregisterGpsApi = window.TacPhone.interApp.register(this.props.panel, {
                service: GPS_SERVICE,
                version: GPS_SERVICE_VERSION,
                api: gpsApi,
            });
        }
    }

    /**
     * Debug-only terrain state for the browser tests: whether the view is ready
     * and how many tiles each terrain layer has started/finished loading.
     */
    public getMapViewDebugState(): MapViewDebugState {
        const resolution = this.map?.getView().getResolution();
        const viewResolution = typeof resolution === 'number' && Number.isFinite(resolution)
            ? resolution
            : null;
        const mapSize = this.map?.getSize();
        const mapTarget = this.map?.getTargetElement();
        const tiles = this.terrainPipeline?.getStats(viewResolution) ?? [];
        const pendingLayers = this.terrainPipeline?.getPendingLayerCount() ?? 0;
        const started = tiles.reduce((total, stats) => total + stats.started, 0);
        const finished = tiles.reduce((total, stats) => total + stats.finished, 0);
        const errored = tiles.reduce((total, stats) => total + stats.errored, 0);
        const loading = tiles.reduce((total, stats) => total + stats.loading, 0);
        // The pipeline can settle from the streamed layers alone; the full reply
        // is what gives the layer switcher and the GPS overlay their layer list.
        const terrainDataReady = this.state.terrainData !== null;

        return {
            ready: this.terrainViewReady && this.map !== null,
            resolution: viewResolution,
            pendingLayers,
            terrainDataReady,
            terrainError: this.state.terrainError,
            mapTargetConnected: mapTarget?.isConnected ?? false,
            mapSize: mapSize ? [mapSize[0], mapSize[1]] : null,
            tiles,
            started,
            finished,
            errored,
            loading,
            quietForMs: this.lastTerrainTileEventAt === 0
                ? 0
                : Math.max(0, Date.now() - this.lastTerrainTileEventAt),
            settled: started > 0
                && loading === 0
                && pendingLayers === 0
                && terrainDataReady,
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
        if (this.unregisterGpsApi) {
            this.unregisterGpsApi();
            this.unregisterGpsApi = undefined;
        }

        if (this.unsubscribeOptions) {
            this.unsubscribeOptions();
            this.unsubscribeOptions = undefined;
        }

        /** Clear pending view work on unmount. */
        this.pendingFlyTo = null;
        this.pendingInitialFit = false;

        this.terrainLoadToken += 1;
        this.terrainSource = null;

        // Dispose the pipeline while the map is still attached: it has to
        // remove the live layers and clear their renderers.
        this.disposeTerrainPipeline();

        const map = this.map;
        this.map = null;

        if (map) {
            // Detach the map from the DOM target
            map.un('change:size', this.handleMapSizeChange);
            map.setTarget(undefined);
        }
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

    private readTileSettings(): TerrainTileSettings {
        const settings = this.getRenderSettings();

        return {
            tileSize: settings.tileSize,
            smoothScaling: settings.smoothScaling,
            // GPS rotates in place; preload a ring beyond the viewport so the
            // corners do not appear as black tiles while turning.
            preload: this.isGps ? Math.max(2, settings.tilePreload) : settings.tilePreload,
            cacheSize: settings.tileCacheSize,
        };
    }

    private disposeTerrainPipeline(): void {
        this.terrainPipeline?.dispose();
        this.terrainPipeline = null;
        this.lastTerrainTileEventAt = 0;
    }

    /** Shows the localized alert only when every terrain layer failed to decode. */
    private maybeShowAllLayersFailedError(): void {
        const error = this.terrainPipeline?.getAllFailedError() ?? null;
        if (error && this.state.terrainError !== error) {
            this.showTerrainError(error);
        }
    }

    /** Renders one terrain layer that arrived before the reply was complete. */
    private receiveTerrainLayer(progress: TerrainLayerProgress): void {
        if (!this.map) {
            return;
        }

        if (!this.terrainPipeline) {
            // The first layer carries the terrain metadata. Build the view and
            // the tile grid now; the remaining layers stream into the pipeline.
            this.terrainSource = {
                extent: [0, 0, progress.width, progress.height],
                layers: [],
            };

            // A reload replaces the whole pipeline: the previous layers must not
            // survive next to the new ones.
            this.disposeTerrainPipeline();
            if (!this.ensureTerrainPipeline()) {
                return;
            }
        }

        this.terrainPipeline?.pushLayer(progress.layer, {
            index: progress.index,
            count: progress.count,
        });
    }

    /**
     * Completes a terrain load. When the host could not stream (a coalesced
     * cache hit, for example) this adds every layer at once.
     */
    private applyTerrainLayers(terrain: TerrainData): void {
        if (!this.map) {
            return;
        }

        this.setState({ terrainError: null, terrainData: terrain });

        this.terrainSource = {
            extent: [0, 0, terrain.width, terrain.height],
            layers: terrain.layers,
        };

        if (!this.terrainPipeline) {
            this.disposeTerrainPipeline();
            if (!this.ensureTerrainPipeline()) {
                return;
            }
        }

        this.terrainPipeline?.finish(terrain.layers);
    }

    /** Creates the pipeline for the current terrain metadata and options. */
    private ensureTerrainPipeline(): boolean {
        const map = this.map;
        if (!map) {
            return false;
        }

        const tiling = this.rebuildTerrainView();
        if (!tiling || this.map !== map) {
            return false;
        }

        this.terrainPipeline = new TerrainLayerPipeline({
            map,
            projection: map.getView().getProjection(),
            tileGrid: tiling.tileGrid,
            resolutions: tiling.resolutions,
            settings: this.readTileSettings(),
            onTileActivity: () => {
                this.lastTerrainTileEventAt = Date.now();
            },
            onStatsChanged: () => {
                this.maybeShowAllLayersFailedError();
            },
        });

        return true;
    }

    /**
     * Builds the view constraints and tile grid for the current terrain size and
     * render settings. Used for the first load and whenever a tiling option
     * changes, without touching the game-side terrain data.
     */
    private rebuildTerrainView(): {
        tileGrid: TileGrid;
        resolutions: number[];
    } | null {
        const map = this.map;
        const terrain = this.terrainSource;
        if (!map || !terrain) {
            return null;
        }

        const settings = this.getRenderSettings();
        const extent = terrain.extent;
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
            tileSize: settings.tileSize,
        });

        // The view constraints depend on the actual terrain size, so they can only
        // be built now. Views have no setExtent(), hence the replacement view.
        const previousView = this.terrainViewReady ? map.getView() : null;
        const { view, preserved } = this.createTerrainView(projection, extent, previousView);
        map.setView(view);
        this.terrainViewReady = true;

        // Keep the user's position on a rebuild; on the first load (or if the old
        // position no longer fits the current profile) show the whole map at once.
        // Omitting `duration` applies the new state immediately; an animated fit
        // throttles new tile loads and would also request intermediate zooms that
        // are never displayed.
        if (!preserved) {
            if (this.hasMapArea()) {
                view.fit(extent);
            } else {
                // A Map built in a background tab has a 0x0 viewport; fitting
                // it now would divide by zero. Fit it when the tab is shown.
                this.pendingInitialFit = true;
            }
        }

        // A flyTo() that arrived before the terrain view existed must win over the
        // initial fit, so it is applied last.
        if (this.pendingFlyTo) {
            this.applyPendingFlyTo();
        }

        return { tileGrid, resolutions };
    }

    /**
     * Rebuilds the terrain tile layers for the current render settings. The
     * decoded layer images are reused, so no game request is needed.
     */
    private rebuildTerrainLayers(): void {
        const tiling = this.rebuildTerrainView();
        if (!tiling || !this.terrainPipeline) {
            return;
        }

        this.terrainPipeline.restart(
            this.readTileSettings(),
            tiling.tileGrid,
            tiling.resolutions,
        );
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
     * True when the initial whole-terrain fit was skipped because the Map was
     * built in a hidden (0x0) tab; it runs on the first measured viewport.
     */
    private pendingInitialFit = false;

    /** True when the OpenLayers viewport has a measurable size (the tab is shown). */
    private hasMapArea(): boolean {
        const size = this.map?.getSize();
        return Boolean(size && size[0] > 0 && size[1] > 0);
    }

    /**
     * Applies work that had to wait for a measurable viewport: a Map in a
     * background tab is `display: none`, so OpenLayers reports a 0x0 size until
     * the tab is selected and its ResizeObserver runs.
     */
    private handleMapSizeChange = (): void => {
        if (!this.hasMapArea()) {
            return;
        }

        if (this.pendingFlyTo) {
            this.pendingInitialFit = false;
            this.applyPendingFlyTo();
            return;
        }

        if (!this.pendingInitialFit) {
            return;
        }

        this.pendingInitialFit = false;

        const view = this.map?.getView();
        const extent = view?.getProjection().getExtent();
        if (view && extent) {
            view.fit(extent);
        }
    };

    /**
     * Applies a queued fly-to once the terrain view exists and the map has a
     * measurable viewport. A request that still cannot be applied stays queued.
     */
    private applyPendingFlyTo(): void {
        const pending = this.pendingFlyTo;
        if (!pending) {
            return;
        }

        if (!this.map || !this.terrainViewReady || !this.hasMapArea()) {
            return;
        }

        this.pendingFlyTo = null;
        this.applyFlyToNow(pending);
    }

    render() {
        return (
            // `overflow: hidden` keeps the OpenLayers canvas rounding from
            // making the flexlayout tab scrollable by a pixel or two, which
            // would let Chrome claim touch drags as pans (pointercancel).
            <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>

                <div ref={this.mapRef} className={`${styles.map}`} style={{width: "100%", height: "100%"}}/>

                {!this.isGps && (
                    <LayerSwitcher
                        map={this.map}
                        isOpen={this.state.layerSwitcherIsOpen}
                        onToggle={this.toggleLayerSwitcherMenu}
                        onClose={this.closeLayerSwitcherMenu}
                        sections={this.layerSwitcherSections}
                    />
                )}

                <MarkerOverlay
                    ref={this.markerUiRef}
                    map={this.map}
                    mapContainer={this.mapRef.current}
                    layerSwitcher={this.layerSwitcherSections}
                    flyTo={(options) => this.flyToCoordinate(options)}
                    onRequestCloseLayers={this.closeLayerSwitcherMenu}
                    interactive={!this.isGps}
                />

                {this.isGps && (
                    <GpsOverlay
                        ref={this.gpsUiRef}
                        map={this.map}
                        terrain={this.state.terrainData}
                        flyTo={(options) => this.flyToCoordinate(options)}
                        onRequestCloseLayers={this.closeLayerSwitcherMenu}
                    />
                )}

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
