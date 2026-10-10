import React, { createRef, type RefObject } from 'react'
import styles from './styles.module.scss'
import LayerSwitcherStyle from './LayerSwitcherStyle.module.scss'

import "ol/ol.css";
import Map from "ol/Map";
import { View } from 'ol';
//import { Tile} from 'ol/layer.js';
import TileLayer from 'ol/layer/Tile';
import BaseLayer from 'ol/layer/Base';


import Projection from 'ol/proj/Projection';
import { getTopLeft } from 'ol/extent.js';
import TileGrid from 'ol/tilegrid/TileGrid.js';
import ImageTileSource from 'ol/source/ImageTile';

//import { LayerSwitcher } from './LayerSwitcher';
import { MarkerLayerManager } from './MapMarkers/MarkerLayer';

interface LayerData {
  id: string;
  title: string;
  visible: boolean;
  layerInstance: BaseLayer;
}

interface MapState {
  layers: LayerData[];
  layerSwitcherIsOpen: boolean; 
}

class App extends React.Component<{},MapState> {
    // Setup the ref for the map canvas container element
    private mapRef: RefObject<HTMLDivElement | null> = createRef();
    private layerSwitcherRef: RefObject<HTMLDivElement | null> = createRef();
    // Keep the map instance directly on the class instance
    private map: Map | null = null;

    private markerManager: MarkerLayerManager | null = null;


    constructor(props: {}) {
        super(props);
        this.state = {
            layers: [],
            layerSwitcherIsOpen: false
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

        window.Networking.LoadGameTerrain({ drawTreeObjects: false, layerMountains: true, simpleRoads: true })
            .then(async res => {
                var bytes = Uint8Array.from(res, c => c.charCodeAt(0));
                this.applyNewTerrainSVG(bytes);
            });

    }

    componentWillUnmount(): void {
        if (this.map) {
            // Clean up collection event listeners to prevent memory leaks
            const layersCollection = this.map.getLayers();
            layersCollection.un('add', this.updateLayersState);
            layersCollection.un('remove', this.updateLayersState);
            
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
            </div>
        );
    }
}

export default App
