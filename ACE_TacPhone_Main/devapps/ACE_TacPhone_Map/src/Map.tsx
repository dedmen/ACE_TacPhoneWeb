import React from 'react'
import styles from './styles.module.scss'

import "ol/ol.css";
import Map from "ol/map";
import { View } from 'ol';
import { Tile} from 'ol/layer.js';
import Projection from 'ol/proj/Projection';
import { getTopLeft } from 'ol/extent.js';
import TileGrid from 'ol/tilegrid/TileGrid.js';
import ImageTileSource from 'ol/source/ImageTile';

class App extends React.Component<{},{
    count : number
}> {
    map: Map |undefined;

    constructor(props: {}) {
        super(props);
        this.state = {count: 0};
    }

    componentDidMount() {


        var extent = [0, 0, 30720, 30720];
        var projection = new Projection({
            code: 'static-image',
            units: 'pixels',
            extent: extent
        });

        this.map = new Map({
            target: "map",
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

        window.Networking.LoadGameFileText("\\z\\ace\\addons\\tacphone\\apps\\map\\data\\altis.svg")
        //fetch("/devapps/ACE_TacPhone_Map/assets/altis.svg")
        .then(async res => {

        // Load our big SVG once, then the canvas will render sub-sections later
        var bytes = Uint8Array.from(res, c => c.charCodeAt(0));
        //var bytes = await res.bytes();
        let url = URL.createObjectURL(new Blob([bytes], {type: 'image/svg+xml'}));

         
        // Base measurements of your standalone SVG artwork blueprint
        const svgBaseWidth = 30720; 
        const svgBaseHeight = 30720;
        const tileSize = 256; // Standard map grid slice dimension

        // 1. Establish the boundary coordinate limits matching the SVG native dimensions
        const extent = [0, 0, svgBaseWidth, svgBaseHeight];

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

       
        const masterImg = new Image();

        // 4. Create the custom on-the-fly rasterizer source
        const svgTileSource = new ImageTileSource({
            tileGrid: tileGrid,
            projection: projection,
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
                    console.log({
                        x: x,
                        y: y,
                        z: z,
                        resolution: resolution,
                        chunkWidth: chunkWidth,
                        svgX: svgX,
                        svgY: svgY
                    });
                    //svgX = 0;
                    //svgY = 0;
                    
                    // Draw the computed vector fragment text onto an offscreen canvas component
                    const canvas = document.createElement('canvas');
                    canvas.width = tileSize;
                    canvas.height = tileSize;
                    const ctx = canvas.getContext('2d')!;

                    // Instantaneous Blit/Crop: Sub-sections of the single pre-cached image are drawn directly 
                    ctx.drawImage(
                        masterImg, 
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

        masterImg.onload = () => {
            this.map!.addLayer(new Tile({
                source: svgTileSource,
            }));
        };

        masterImg.src = url;
        });

    }

    componentWillUnmount() {
        this.map?.setTarget(undefined);
    }

    render() {
        return <div id="map" className={`${styles.map}`} style={{width: "100%", height: "100%"}}/>;
    }
}

export default App
