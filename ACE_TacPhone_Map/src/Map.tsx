import React, { createRef, type RefObject } from 'react'
import styles from './styles.module.scss'

import "ol/ol.css";
import type { AppProps, TerrainData, TerrainLayer } from '@ace-tacphone/api';
import Map from "ol/Map";
import { View } from 'ol';
import type { ViewOptions } from 'ol/View.js';
import TileLayer from 'ol/layer/Tile';
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom';
import DragRotate from 'ol/interaction/DragRotate';
import PinchRotate from 'ol/interaction/PinchRotate';


import Projection from 'ol/proj/Projection';
import { getTopLeft } from 'ol/extent.js';
import TileGrid from 'ol/tilegrid/TileGrid.js';
import ImageTileSource from 'ol/source/ImageTile';

import { LayerSwitcher } from './LayerSwitcher';
import { MarkerOverlay, type MarkerOverlayHandle } from './MapMarkers/MarkerOverlay';
import { LayerSwitcherRegistry } from './MapMarkers/LayerSwitcherRegistry';
import {
    MAP_SERVICE,
    MAP_SERVICE_VERSION,
    type MapApi,
    type MapFlyToOptions,
} from './api';

const TERRAIN_TILE_SIZE = 256;
const TERRAIN_MIN_RESOLUTION = 0.2;
const TERRAIN_TILE_CACHE_SIZE = 48;
// Placeholder size until the terrain layers report the real one.
const INITIAL_TERRAIN_EXTENT: [number, number, number, number] = [0, 0, 30720, 30720];

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

        if (
            !center ||
            !Number.isFinite(center[0]) ||
            !Number.isFinite(center[1]) ||
            typeof resolution !== 'number' ||
            !Number.isFinite(resolution) ||
            center[0] < extent[0] || center[0] > extent[2] ||
            center[1] < extent[1] || center[1] > extent[3] ||
            resolution < TERRAIN_MIN_RESOLUTION || resolution > maxResolution
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
        // At this resolution a single tile covers the whole terrain, so it is the
        // farthest the view needs to zoom out. The extent constraint caps it further
        // when the panel is larger than that tile.
        const maxResolution = Math.max(
            Math.max(extent[2] - extent[0], extent[3] - extent[1]) / TERRAIN_TILE_SIZE,
            TERRAIN_MIN_RESOLUTION,
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
            minResolution: TERRAIN_MIN_RESOLUTION,
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

        var projection = new Projection({
            code: 'static-image',
            units: 'pixels',
            extent: INITIAL_TERRAIN_EXTENT
        });

        const map = new Map({
            target: this.mapRef.current,
            layers: [],
            view: this.createTerrainView(projection, INITIAL_TERRAIN_EXTENT, null).view,
        });
        this.map = map;
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
        // Validate before doing anything, including storing a pending target.
        if (
            typeof options.x !== 'number' ||
            typeof options.y !== 'number' ||
            !Number.isFinite(options.x) ||
            !Number.isFinite(options.y)
        ) {
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

        const center = [options.x, options.y];

        // Clamp the center to the current view projection extent when one exists
        const extent = projection.getExtent();
        if (extent) {
            center[0] = Math.max(extent[0], Math.min(options.x, extent[2]));
            center[1] = Math.max(extent[1], Math.min(options.y, extent[3]));
        }

        // Only apply resolution when it is a finite positive number
        const resolution = options.resolution !== undefined && Number.isFinite(options.resolution) && options.resolution > 0 ? options.resolution : undefined;

        if (options.animate !== false) {
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
            focusMarker: (name: string) => {
                return this.markerUiRef.current?.focusMarker(name) ?? Promise.resolve(false);
            },
        };

        const registration = window.TacPhone.interApp.register(this.props.panel, {
            service: MAP_SERVICE,
            version: MAP_SERVICE_VERSION,
            api,
        });

        this.unregisterMapApi = registration;
    }

    componentWillUnmount(): void {
        /**
         * Unregister the MapApi BEFORE map teardown, so that window.TacPhone.interApp.list()
         * and other lookups see the cleanup immediately. The pendingFlyTo is now
         * stale (map is null), so we clear it as well.
         */
        if (this.unregisterMapApi) {
            this.unregisterMapApi();
            this.unregisterMapApi = undefined;
        }

        /** Clear pending fly-to on unmount. */
        this.pendingFlyTo = null;

        this.terrainLoadToken += 1;

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

        // Base measurements reported by the terrain producer.
        const svgBaseWidth = terrain.width;
        const svgBaseHeight = terrain.height;
        const tileSize = TERRAIN_TILE_SIZE; // Standard map grid slice dimension

        // 1. Establish the boundary coordinate limits matching the SVG native dimensions
        const extent: [number, number, number, number] = [0, 0, svgBaseWidth, svgBaseHeight];
        const projection = map.getView().getProjection();
        projection.setExtent(extent);

        // 2. Generate custom resolution steps for smooth zooming calculation
        const maxZoom = 5;
        const resolutions: Array<number> = [];
        for (let z = 0; z <= maxZoom; ++z) {
            resolutions.push(Math.pow(2, maxZoom - z));
        }
        // We are converting SVG (which has millimeter-accurate information) to pixels.
        // This number is how many meters, one pixel is, on the most zoomed-in state. The code above stops at 1-meter
        resolutions.push(0.2);

        // 3. Set up the logical map tile matrix structure
        const tileGrid = new TileGrid({
            origin: getTopLeft(extent),
            resolutions: resolutions,
            tileSize: tileSize,
        });

        // Load every terrain layer image first, so a failure cannot leave
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

        // 4. Create a custom on-the-fly rasterizer source for each layer
        const newLayers: TileLayer<ImageTileSource>[] = [];
        try {
            for (const loadedLayer of loadedLayers) {
                const tileImage = loadedLayer.image;

                const svgTileSource = new ImageTileSource({
                    tileGrid: tileGrid,
                    projection: projection,
                    // The loader function handles slicing on demand
                    loader: function (z, x, y) {
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

                            // Instantaneous Blit/Crop: Sub-sections of the single pre-cached image are drawn directly
                            ctx.drawImage(
                                tileImage,
                                svgX, svgY, chunkWidth, chunkHeight, // Bounding source box (Crop area on SVG)
                                0, 0, tileSize, tileSize             // Target destination box (Fills the 256x256 tile)
                            );

                            resolve(canvas);
                        });
                    },
                });

                newLayers.push(new TileLayer({
                    properties: {title: loadedLayer.name},
                    source: svgTileSource,
                    // A phone-sized viewport only needs a few tiles per layer. The
                    // default (512) keeps hundreds of MiB of canvases per layer alive.
                    cacheSize: TERRAIN_TILE_CACHE_SIZE,
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

        // 5. Replace any previous terrain layers so repeated loads cannot stack duplicates.
        this.disposeTerrainLayers();

        newLayers.forEach((layer) => {
            map.addLayer(layer);
        });
        this.terrainLayers = newLayers;

        // 6. The view constraints depend on the real terrain size, so they can only
        // be built now. Views have no setExtent(), hence the replacement view.
        const previousView = this.terrainViewReady ? map.getView() : null;
        const { view, preserved } = this.createTerrainView(projection, extent, previousView);
        map.setView(view);
        this.terrainViewReady = true;

        // Keep the user's position on a reload; on the first load (or if the old
        // position no longer fits) show the whole map.
        if (!preserved) {
            view.fit(extent, {
                duration: 1000            // Optional: Smoothly animate the zoom/pan over 1 second
            });
        }

        // A flyTo() that arrived before the terrain view existed must win over the
        // initial fit, so it is applied last.
        if (this.pendingFlyTo) {
            this.applyPendingFlyTo();
        }
    }

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
                    flyTo={(position) => this.flyToCoordinate({ x: position[0], y: position[1] })}
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
                        Failed to load map terrain: {this.state.terrainError}
                    </div>
                )}
            </div>
        );
    }
}

export default App
