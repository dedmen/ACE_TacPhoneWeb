import React, { createRef, type RefObject } from 'react'
import styles from './styles.module.scss'
import LayerSwitcherStyle from './LayerSwitcherStyle.module.scss'

import "ol/ol.css";
import Map from "ol/Map";
import { View } from 'ol';
//import { Tile} from 'ol/layer.js';
import TileLayer from 'ol/layer/Tile';
import BaseLayer from 'ol/layer/Base';
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom';
import type { MapBrowserEvent } from 'ol';


import Projection from 'ol/proj/Projection';
import { getTopLeft } from 'ol/extent.js';
import TileGrid from 'ol/tilegrid/TileGrid.js';
import ImageTileSource from 'ol/source/ImageTile';

//import { LayerSwitcher } from './LayerSwitcher';
import { MarkerLayerManager, type MarkerColor, type MarkerType } from './MapMarkers/MarkerLayer';
import { MarkerCreateDialog } from './MapMarkers/MarkerCreateDialog';
import { createMarker, type MarkerCreationData } from './MapMarkers/MarkerApi';

const LONG_PRESS_DURATION_MS = 600;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

interface MarkerDialogState {
  isOpen: boolean;
  coordinate: [number, number] | null;
  markerTypes: MarkerType[];
  markerColors: MarkerColor[];
}

interface LayerData {
  id: string;
  title: string;
  visible: boolean;
  layerInstance: BaseLayer;
}

interface MapState {
  layers: LayerData[];
  layerSwitcherIsOpen: boolean;
  markerDialog: MarkerDialogState;
}

class App extends React.Component<{},MapState> {
    // Setup the ref for the map canvas container element
    private mapRef: RefObject<HTMLDivElement | null> = createRef();
    private layerSwitcherRef: RefObject<HTMLDivElement | null> = createRef();
    // Keep the map instance directly on the class instance
    private map: Map | null = null;

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
            layers: [],
            layerSwitcherIsOpen: false,
            markerDialog: {
                isOpen: false,
                coordinate: null,
                markerTypes: [],
                markerColors: [],
            },
        };
    }

    componentDidMount() {

        if (!this.mapRef.current) return;

        var extent = [0, 0, 30720, 30720]; //#TODO just only create the map after the image was loaded?
        var projection = new Projection({
            code: 'static-image',
            units: 'pixels',
            extent: extent
        });

        this.map = new Map({
            target: this.mapRef.current,
            layers: [
                //imgLayer,
                //vectorLayer,
                //new Tile({
                //source: new OSM(),
                //}),
            ],
            view: new View({
                projection: projection,
                center: [0, 0],
                zoom: 0,
            }),
        });

        // 2. Set up dynamic collection event listeners
        const layersCollection = this.map.getLayers();
        layersCollection.on('add', this.updateLayersState);
        layersCollection.on('remove', this.updateLayersState);

        this.updateLayersState();

        // Listen for global clicks to detect closing map tool windows
        document.addEventListener('mousedown', this.handleClickOutside);

        this.markerManager = new MarkerLayerManager('Markers');

        // Double-click (desktop) creates a marker. Remove the default double-click zoom
        // interaction so that creating a marker doesn't also zoom the map.
        [...this.map.getInteractions().getArray()].forEach((interaction) => {
            if (interaction instanceof DoubleClickZoom) {
                this.map!.removeInteraction(interaction);
            }
        });

        this.map.on('dblclick', this.handleMapDoubleClick);

        // Long-press (touch) creates a marker.
        const viewport = this.map.getViewport();
        viewport.addEventListener('pointerdown', this.handleMapPointerDown);
        viewport.addEventListener('pointermove', this.handleMapPointerMove);
        viewport.addEventListener('pointerup', this.handleMapPointerUp);
        viewport.addEventListener('pointercancel', this.handleMapPointerUp);
        viewport.addEventListener('contextmenu', this.handleMapContextMenu);

        window.Networking.LoadGameTerrain({ drawTreeObjects: false, layerMountains: true, simpleRoads: true })
            .then(async res => {
                var bytes = Uint8Array.from(res, c => c.charCodeAt(0));
                this.applyNewTerrainSVG(bytes);
            });

    }

    componentWillUnmount(): void {
        this.cancelLongPress();

        if (this.map) {
            // Clean up collection event listeners to prevent memory leaks
            const layersCollection = this.map.getLayers();
            layersCollection.un('add', this.updateLayersState);
            layersCollection.un('remove', this.updateLayersState);

            this.map.un('dblclick', this.handleMapDoubleClick);

            const viewport = this.map.getViewport();
            viewport.removeEventListener('pointerdown', this.handleMapPointerDown);
            viewport.removeEventListener('pointermove', this.handleMapPointerMove);
            viewport.removeEventListener('pointerup', this.handleMapPointerUp);
            viewport.removeEventListener('pointercancel', this.handleMapPointerUp);
            viewport.removeEventListener('contextmenu', this.handleMapContextMenu);

            // Detach the map from the DOM target
            this.map.setTarget(undefined);
        }

        if (this.markerManager) {
            this.markerManager.destroy(); // Safely detaches from global registry
        }

        document.removeEventListener('mousedown', this.handleClickOutside);
    }

    private updateLayersState = (): void => {
        if (!this.map) return;

        const layerArray = this.map.getLayers().getArray();

        const layersData: LayerData[] = layerArray
        .filter((layer): layer is BaseLayer & { get(key: 'title'): string } => {
            return typeof layer.get('title') === 'string';
        })
        .map((layer) => ({
            id: (layer as any).ol_uid || Math.random().toString(),
            title: layer.get('title'),
            visible: layer.getVisible(),
            layerInstance: layer
        }));

        this.setState({ layers: layersData });
    };

    private handleToggleLayer = (layerData: LayerData, isChecked: boolean): void => {
        // 1. Mutate imperative OpenLayers visibility
        layerData.layerInstance.setVisible(isChecked);
        
        // 2. Update local state to sync checkbox elements
        this.setState((prevState) => ({
        layers: prevState.layers.map((l) => 
            l.id === layerData.id ? { ...l, visible: isChecked } : l
        )
        }));
    };

    private handleClickOutside = (event: MouseEvent): void => {
        // Click onto our map, close all tool popups

        if (
            this.state.layerSwitcherIsOpen && 
            this.layerSwitcherRef.current && 
            !this.layerSwitcherRef.current.contains(event.target as Node)
        ) {
            this.setState({ layerSwitcherIsOpen: false });
        }
    };

    private toggleLayerSwitcherMenu = (): void => {
        this.setState((prevState) => ({ layerSwitcherIsOpen: !prevState.layerSwitcherIsOpen }));
    };

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

    private handleMapContextMenu = (event: MouseEvent): void => {
        // A long press can otherwise trigger the browser context menu on touch.
        event.preventDefault();
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


    splitSVGIntoLayers(bytes: Uint8Array<ArrayBuffer>)
    {
        // The SVG file contains the size of the terrain, which we need to know for our tiling and scaling
        // And we also want to split out the SVG layers

        const svgDoc = (new DOMParser()).parseFromString((new TextDecoder('utf-8')).decode(bytes), 'image/svg+xml');
        const rootSvg = svgDoc.documentElement;

        var svgSplitLayers: Array<{name: string, imageUrl: string}> = []; // We will split out the different layers
        {
            const originalDefs = rootSvg.querySelector("defs")!; // defs will be copied into every file
            const layers = rootSvg.querySelectorAll("svg > g");

            layers.forEach((layer) => {
                // Clone the root <svg> element (shallow clone, so it copies attributes but not children)
                const newSvg = rootSvg.cloneNode(false);
                newSvg.appendChild(originalDefs.cloneNode(true)); // Deep clone the defs
                newSvg.appendChild(layer.cloneNode(true)); // Add the deep cloned layer

                // Serialize the newly constructed SVG DOM tree back into a string
                const serializer = new XMLSerializer();
                const newSVGString = serializer.serializeToString(newSvg);

                const svgBlob = new Blob([newSVGString], { type: "image/svg+xml;charset=utf-8" });
                const blobURL = URL.createObjectURL(svgBlob);

                svgSplitLayers.push({ name: layer.id, imageUrl: blobURL});
            });
        }

        // Base measurements of your standalone SVG artwork blueprint
        const svgBaseWidth = Number(rootSvg.attributes.getNamedItem("width")?.value); // Get the Terrain size from the SVG head
        const svgBaseHeight = Number(rootSvg.attributes.getNamedItem("height")?.value);

        return {
            width: svgBaseWidth,
            height: svgBaseHeight,
            layers: svgSplitLayers
        };
    }

    async applyNewTerrainSVG(bytes: Uint8Array<ArrayBuffer>)
    {
        var svgData = this.splitSVGIntoLayers(bytes);

        // Base measurements of your standalone SVG artwork blueprint
        const svgBaseWidth = svgData.width;
        const svgBaseHeight = svgData.height;
        const tileSize = 256; // Standard map grid slice dimension

        // 1. Establish the boundary coordinate limits matching the SVG native dimensions
        const extent = [0, 0, svgBaseWidth, svgBaseHeight];
        this.map?.getView().getProjection().setExtent(extent);

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

        // Now create a map tile, from each of the split SVG images we have

        var createTile = (layer:{name: string, imageUrl: string}) : Promise<{name:string, svgTileSource: ImageTileSource}> => {

            const tileImage = new Image();

            // 4. Create the custom on-the-fly rasterizer source
            const svgTileSource = new ImageTileSource({
                tileGrid: tileGrid,
                projection: this.map?.getView().getProjection(),
                // The loader function handles slicing on demand
                loader: function (z, x, y) {
                    return new Promise((resolve) => {
                        // Calculate how many raw coordinate map units fit inside this single screen slice
                        const resolution = resolutions[z];
                        const chunkWidth = tileSize * resolution;
                        const chunkHeight = tileSize * resolution;

                        // Pinpoint the exact viewport frame block context to isolate and crop
                        let svgX = x * chunkWidth;
                        let svgY = y * chunkHeight; // svgBaseHeight - ((y + 1) * chunkHeight); // Inverts coordinates for map grids
                        //console.log({
                        //    x: x,
                        //    y: y,
                        //    z: z,
                        //    resolution: resolution,
                        //    chunkWidth: chunkWidth,
                        //    svgX: svgX,
                        //    svgY: svgY
                        //});
                        //svgX = 0;
                        //svgY = 0;

                        // Draw the computed vector fragment text onto an offscreen canvas component
                        const canvas = document.createElement('canvas');
                        canvas.width = tileSize;
                        canvas.height = tileSize;
                        const ctx = canvas.getContext('2d')!;

                        // Instantaneous Blit/Crop: Sub-sections of the single pre-cached image are drawn directly 
                        ctx.drawImage(
                            tileImage, 
                            svgX, svgY, chunkWidth, chunkHeight, // Bounding source box (Crop area on SVG)
                            0, 0, tileSize, tileSize             // Target destination box (Fills the 256x256 tile)
                        );

                        //canvas.toBlob(function(blob){
                        //    var link = URL.createObjectURL(blob);
                        //    console.log(link);
                        //},'image/png');

                        resolve(canvas);
                    });
                },
            });

            return new Promise((resolve) => {
                tileImage.onload = () => {

                    resolve({ name: layer.name, svgTileSource });
                    // To save memory, we now loaded the SVG image, the browser doesn't need to keep the blob URL alive
                    URL.revokeObjectURL(tileImage.src);
                };

                //img.onerror = () => {
                //    URL.revokeObjectURL(url);
                //    console.error(`Failed to load image at index ${index}`);
                //    resolve({ img: null, index }); // Resolve anyway to not break Promise.all
                //};

                tileImage.src = layer.imageUrl;
            });
        };

        // We need to add the layers in the correct order, that's why we wait
        const promises = svgData.layers.map(layer => createTile(layer));

        Promise.all(promises).then((results) => {
            results.forEach((result) => {
                this.map!.addLayer(new TileLayer({
                    properties: {title: result.name},
                    source: result.svgTileSource,
                }));
            });

            this.map!.addLayer(this.markerManager!.layer);
        });

        // Fit the whole map in view
        this.map?.getView().fit(extent, {
            duration: 1000            // Optional: Smoothly animate the zoom/pan over 1 second
        });
    }

    render() {
        return (
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>

                <div ref={this.mapRef} className={`${styles.map}`} style={{width: "100%", height: "100%"}}/>

                {/* Floating Expandable Layer Switcher */}
                {this.state.layers.length > 0 && (
                <div className={`${LayerSwitcherStyle.layer_switcher_container}`} ref={this.layerSwitcherRef}>
                    {/* The Trigger Button */}
                    <button 
                    className={`${LayerSwitcherStyle.layer_switcher_btn} ${this.state.layerSwitcherIsOpen ? 'active' : ''}`}
                    onClick={this.toggleLayerSwitcherMenu}
                    title="Toggle Layers"
                    >
                    🥞
                    </button>

                    {/* The Dropdown Menu */}
                    {this.state.layerSwitcherIsOpen && (
                    <div className={`${LayerSwitcherStyle.layer_switcher_dropdown}`}>
                        <h4>Layers</h4>
                        {this.state.layers.map((layerData) => (
                        <div key={layerData.id} className={`${LayerSwitcherStyle.layer_row}`}>
                            <input
                            type="checkbox"
                            id={`layer-${layerData.id}`}
                            checked={layerData.visible}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => 
                                this.handleToggleLayer(layerData, e.target.checked)
                            }
                            />
                            <label htmlFor={`layer-${layerData.id}`}>{layerData.title}</label>
                        </div>
                        ))}
                    </div>
                    )}
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
