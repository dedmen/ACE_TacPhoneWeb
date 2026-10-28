import React, { createRef, type RefObject } from 'react'
import styles from './styles.module.scss'

import "ol/ol.css";
import Map from "ol/Map";
import { View } from 'ol';
import type { ViewOptions } from 'ol/View.js';
import TileLayer from 'ol/layer/Tile';
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom';
import type { MapBrowserEvent } from 'ol';


import Projection from 'ol/proj/Projection';
import { getTopLeft } from 'ol/extent.js';
import TileGrid from 'ol/tilegrid/TileGrid.js';
import ImageTileSource from 'ol/source/ImageTile';

import { LayerSwitcher } from './LayerSwitcher';
import { MarkerLayerManager, type MarkerColor, type MarkerType } from './MapMarkers/MarkerLayer';
import { MarkerCreateDialog } from './MapMarkers/MarkerCreateDialog';
import { createMarker, type MarkerCreationData } from './MapMarkers/MarkerApi';

const LONG_PRESS_DURATION_MS = 600;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

const TERRAIN_TILE_SIZE = 256;
const TERRAIN_MIN_RESOLUTION = 0.2;
const TERRAIN_TILE_CACHE_SIZE = 48;
// Placeholder size until the terrain SVG reports the real one.
const INITIAL_TERRAIN_EXTENT: [number, number, number, number] = [0, 0, 30720, 30720];

interface MarkerDialogState {
  isOpen: boolean;
  coordinate: [number, number] | null;
  markerTypes: MarkerType[];
  markerColors: MarkerColor[];
}

interface MapState {
  layerSwitcherIsOpen: boolean;
  markerDialog: MarkerDialogState;
  terrainError: string | null;
}

class App extends React.Component<{},MapState> {
    // Setup the ref for the map canvas container element
    private mapRef: RefObject<HTMLDivElement | null> = createRef();
    // Keep the map instance directly on the class instance
    private map: Map | null = null;
    private terrainLayers: TileLayer<ImageTileSource>[] = [];
    private terrainLoadToken = 0;
    private terrainViewReady = false;

    private markerManager: MarkerLayerManager | null = null;

    private longPressTimer: number | null = null;
    private longPressStart: { x: number; y: number; pointerId: number; coordinate: [number, number] } | null = null;

    private loadMarkerIcon = (iconPath: string): Promise<string> => {
        if (!this.markerManager) {
            return Promise.reject(new Error('Marker manager is not initialized'));
        }

        return this.markerManager.loadMarkerIcon(iconPath);
    };


    constructor(props: {}) {
        super(props);
        this.state = {
            layerSwitcherIsOpen: false,
            markerDialog: {
                isOpen: false,
                coordinate: null,
                markerTypes: [],
                markerColors: [],
            },
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
        // The map instance is imperative, so re-render to hand it to the layer switcher.
        this.forceUpdate();

        this.markerManager = new MarkerLayerManager('Markers');
        this.markerManager.layer.setZIndex(1);
        map.addLayer(this.markerManager.layer);

        // Double-click (desktop) creates a marker. Remove the default double-click zoom
        // interaction so that creating a marker doesn't also zoom the map.
        [...map.getInteractions().getArray()].forEach((interaction) => {
            if (interaction instanceof DoubleClickZoom) {
                map.removeInteraction(interaction);
            }
        });

        map.on('dblclick', this.handleMapDoubleClick);

        // Long-press (touch) creates a marker.
        const viewport = map.getViewport();
        viewport.addEventListener('pointerdown', this.handleMapPointerDown);
        viewport.addEventListener('pointermove', this.handleMapPointerMove);
        viewport.addEventListener('pointerup', this.handleMapPointerUp);
        viewport.addEventListener('pointercancel', this.handleMapPointerUp);

        void window.Networking.LoadGameTerrain({ drawTreeObjects: false, layerMountains: true, simpleRoads: true })
            .then((svgString) => {
                const bytes = new TextEncoder().encode(svgString);
                return this.applyNewTerrainSVG(bytes);
            })
            .catch((error: unknown) => {
                console.error('Failed to load map terrain', error);
                this.showTerrainError(error);
            });
    }

    componentWillUnmount(): void {
        this.cancelLongPress();
        this.terrainLoadToken += 1;

        const map = this.map;
        this.map = null;

        if (map) {
            map.un('dblclick', this.handleMapDoubleClick);

            const viewport = map.getViewport();
            viewport.removeEventListener('pointerdown', this.handleMapPointerDown);
            viewport.removeEventListener('pointermove', this.handleMapPointerMove);
            viewport.removeEventListener('pointerup', this.handleMapPointerUp);
            viewport.removeEventListener('pointercancel', this.handleMapPointerUp);

            // Detach the map from the DOM target
            map.setTarget(undefined);
        }

        // this.map is already null, so this only disposes the tile sources.
        this.disposeTerrainLayers();

        if (this.markerManager) {
            this.markerManager.destroy(); // Safely detaches from global registry
        }
    }

    private toggleLayerSwitcherMenu = (): void => {
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

    private handleMapDoubleClick = (event: MapBrowserEvent): void => {
        // OpenLayers also emulates double-click for touch double taps.
        // Only desktop double-clicks should open the dialog.
        const originalEvent = event.originalEvent as PointerEvent;
        if (originalEvent.pointerType === 'touch') {
            return;
        }

        this.openMarkerDialog([event.coordinate[0], event.coordinate[1]]);
    };

    private handleMapPointerDown = (event: PointerEvent): void => {
        if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
            return;
        }

        if (!event.isPrimary) {
            return;
        }

        // Ignore map controls (zoom buttons, attribution, ...) and OpenLayers overlays.
        if (event.target instanceof Element && event.target.closest('.ol-overlaycontainer-stopevent')) {
            return;
        }

        this.cancelLongPress();

        const coordinate = this.map?.getEventCoordinate(event);
        if (!coordinate) {
            return;
        }

        this.longPressStart = {
            x: event.clientX,
            y: event.clientY,
            pointerId: event.pointerId,
            coordinate: [coordinate[0], coordinate[1]],
        };

        this.longPressTimer = window.setTimeout(() => {
            const start = this.longPressStart;
            this.longPressTimer = null;

            if (!start) {
                return;
            }

            this.longPressStart = null;
            this.openMarkerDialog(start.coordinate);
        }, LONG_PRESS_DURATION_MS);
    };

    private handleMapPointerMove = (event: PointerEvent): void => {
        const start = this.longPressStart;
        if (!start || event.pointerId !== start.pointerId) {
            return;
        }

        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;

        if (dx * dx + dy * dy > LONG_PRESS_MOVE_TOLERANCE_PX * LONG_PRESS_MOVE_TOLERANCE_PX) {
            this.cancelLongPress();
        }
    };

    private handleMapPointerUp = (event: PointerEvent): void => {
        if (this.longPressStart && event.pointerId === this.longPressStart.pointerId) {
            this.cancelLongPress();
        }
    };

    private cancelLongPress(): void {
        if (this.longPressTimer !== null) {
            window.clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }

        this.longPressStart = null;
    }

    private openMarkerDialog = (coordinate: [number, number]): void => {
        const markerManager = this.markerManager;

        if (!markerManager) {
            return;
        }

        const markerTypes = markerManager.getMarkerTypes();
        const markerColors = markerManager.getMarkerColors();

        this.setState({
            layerSwitcherIsOpen: false,
            markerDialog: {
                isOpen: true,
                coordinate,
                markerTypes,
                markerColors,
            },
        });

        if (markerTypes.length === 0 || markerColors.length === 0) {
            void markerManager.whenMarkerConfigLoaded().then(() => {
                if (!this.map) {
                    return;
                }

                this.setState((prevState) => ({
                    markerDialog: {
                        ...prevState.markerDialog,
                        markerTypes: markerManager.getMarkerTypes(),
                        markerColors: markerManager.getMarkerColors(),
                    },
                }));
            });
        }
    };

    private closeMarkerDialog = (): void => {
        this.setState((prevState) => ({
            markerDialog: {
                ...prevState.markerDialog,
                isOpen: false,
                coordinate: null,
            },
        }));
    };

    private handleCreateMarker = (marker: MarkerCreationData): void => {
        createMarker(marker).catch((error: unknown) => {
            console.error('Failed to create marker', error);
        });
        this.closeMarkerDialog();
    };


    private splitSVGIntoLayers(bytes: Uint8Array<ArrayBuffer>): {
        width: number;
        height: number;
        layers: Array<{ name: string; imageUrl: string }>;
    } {
        // The SVG file contains the size of the terrain, which we need to know for our tiling and scaling
        // And we also want to split out the SVG layers

        const svgDoc = (new DOMParser()).parseFromString((new TextDecoder('utf-8')).decode(bytes), 'image/svg+xml');
        const rootSvg = svgDoc.documentElement;

        if (rootSvg.tagName.toLowerCase() !== 'svg') {
            throw new Error('The terrain response is not a valid SVG document.');
        }

        // Base measurements of your standalone SVG artwork blueprint
        const widthAttribute = rootSvg.getAttribute("width"); // Get the Terrain size from the SVG head
        const heightAttribute = rootSvg.getAttribute("height");
        const svgBaseWidth = Number(widthAttribute);
        const svgBaseHeight = Number(heightAttribute);

        if (
            widthAttribute === null ||
            heightAttribute === null ||
            !Number.isFinite(svgBaseWidth) ||
            !Number.isFinite(svgBaseHeight) ||
            svgBaseWidth <= 0 ||
            svgBaseHeight <= 0
        ) {
            throw new Error('The terrain SVG is missing a valid width or height.');
        }

        const originalDefs = rootSvg.querySelector("defs"); // defs will be copied into every file
        if (!originalDefs) {
            throw new Error('The terrain SVG is missing its <defs> section.');
        }

        const layers = rootSvg.querySelectorAll("svg > g");
        if (layers.length === 0) {
            throw new Error('The terrain SVG does not contain any layers.');
        }

        var svgSplitLayers: Array<{name: string, imageUrl: string}> = []; // We will split out the different layers

        layers.forEach((layer, index) => {
            // Clone the root <svg> element (shallow clone, so it copies attributes but not children)
            const newSvg = rootSvg.cloneNode(false);
            newSvg.appendChild(originalDefs.cloneNode(true)); // Deep clone the defs
            newSvg.appendChild(layer.cloneNode(true)); // Add the deep cloned layer

            // Serialize the newly constructed SVG DOM tree back into a string
            const serializer = new XMLSerializer();
            const newSVGString = serializer.serializeToString(newSvg);

            const svgBlob = new Blob([newSVGString], { type: "image/svg+xml;charset=utf-8" });
            const blobURL = URL.createObjectURL(svgBlob);

            svgSplitLayers.push({ name: layer.id || `Layer ${index + 1}`, imageUrl: blobURL});
        });

        return {
            width: svgBaseWidth,
            height: svgBaseHeight,
            layers: svgSplitLayers
        };
    }

    private loadTerrainLayerImage(layer: { name: string; imageUrl: string }): Promise<{ name: string; image: HTMLImageElement }> {
        return new Promise((resolve, reject) => {
            const image = new Image();

            image.onload = () => {
                // The browser no longer needs the blob URL once the image is decoded.
                URL.revokeObjectURL(layer.imageUrl);
                resolve({ name: layer.name, image });
            };

            image.onerror = () => {
                URL.revokeObjectURL(layer.imageUrl);
                reject(new Error(`Failed to load terrain layer "${layer.name}".`));
            };

            image.src = layer.imageUrl;
        });
    }

    private disposeTerrainLayers(): void {
        const map = this.map;

        for (const layer of this.terrainLayers) {
            map?.removeLayer(layer);

            const source = layer.getSource();
            layer.setSource(null);
            source?.dispose();
            layer.dispose();
        }

        this.terrainLayers = [];
    }

    private async applyNewTerrainSVG(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        const map = this.map;
        if (!map) {
            return;
        }

        const loadToken = ++this.terrainLoadToken;
        this.setState({ terrainError: null });

        const svgData = this.splitSVGIntoLayers(bytes);

        // Base measurements of your standalone SVG artwork blueprint
        const svgBaseWidth = svgData.width;
        const svgBaseHeight = svgData.height;
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

        // Load every split SVG image first, so a failure cannot leave half-created
        // tile sources behind.
        const loadedLayers = await Promise.all(
            svgData.layers.map((layer) => this.loadTerrainLayerImage(layer))
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
    }

    render() {
        return (
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>

                <div ref={this.mapRef} className={`${styles.map}`} style={{width: "100%", height: "100%"}}/>

                <LayerSwitcher
                    map={this.map}
                    isOpen={this.state.layerSwitcherIsOpen}
                    onToggle={this.toggleLayerSwitcherMenu}
                    onClose={this.closeLayerSwitcherMenu}
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

                {this.state.markerDialog.isOpen && this.state.markerDialog.coordinate !== null && (
                    <MarkerCreateDialog
                        coordinate={this.state.markerDialog.coordinate}
                        markerTypes={this.state.markerDialog.markerTypes}
                        markerColors={this.state.markerDialog.markerColors}
                        loadMarkerIcon={this.loadMarkerIcon}
                        onSubmit={this.handleCreateMarker}
                        onCancel={this.closeMarkerDialog}
                    />
                )}
            </div>
        );
    }
}

export default App
