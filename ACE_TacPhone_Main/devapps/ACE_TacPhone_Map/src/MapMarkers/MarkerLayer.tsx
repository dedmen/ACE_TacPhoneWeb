import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature, { type FeatureLike } from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import { Style, Icon, Text, Fill, Stroke } from 'ol/style';
import { mapCommandRegistry } from '../CommandRegistry';


//#TODO size is "12,123", decompose it into two numbers
// name, type, color, dir, pos, text, shape, alpha, brush, size, channel, polyline
type MarkerUpdate = [string, string, string, number, [number, number, number], string, string, number, string, string, string, string];

interface MarkerType {
    className: string;
    name: string;
    color: string;
    size: number;
    shadow: number;
    icon: string;
}

interface MarkerColor {
    className: string;
    name: string;
    color: string;
}

interface MarkerBrush {
    className: string;
    name: string;
    texture: string;
    drawBorder: number;
}

function colorToHex(rgba: [number, number, number, number]): string {
    const [r, g, b, a] = rgba;
    const toHex = (val: number) => (Math.round(val*255)).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}`;
}


export class MarkerLayerManager {
    public layer: VectorLayer<VectorSource>;
    private source: VectorSource;
    // Registry to easily find features by ID without looping through the entire layer
    private markerRegistry: Map<string, Feature<Point | LineString>> = new Map();

    //#TODO store these globally, and only load them once, in case we have multiple maps
    // In general if we have multiple maps, there should probably just be one MarkerLayerManager
    private markerTypes: Map<string, MarkerType> = new Map();
    private markerColors: Map<string, MarkerColor> = new Map();
    private markerBrushes: Map<string, MarkerBrush> = new Map();

    private markerTextures: Map<string, string | Promise<string>> = new Map();


    private markerStyleCache: Map<string, Style> = new Map();

    private unregisterHooks: Array<() => void> = [];

    constructor(title: string = 'Live Markers') {
        this.source = new VectorSource();
        this.layer = new VectorLayer({
            properties: { title },
            source: this.source,
            style: this.dynamicIconStyleFunction
        });

        // Register handlers via the class instance methods
        this.unregisterHooks.push(
            mapCommandRegistry.register('Marker.Upsert', (payload) => this.handleUpsert((payload as {marker: MarkerUpdate}).marker))
        );
        this.unregisterHooks.push(
            mapCommandRegistry.register('Marker.Delete', (payload) => this.handleDelete((payload as {marker: string}).marker as string))
        );

        // Retrieve all type info

        window.Networking.Request({a: "ACE_TacPhone_Map", c: "GetMarkerTypes"}).then((markerInfo: object) => {
            // Game sends them as arrays, because thats cheaper to serialize than hashmaps

            const {types, colors, brushes} = markerInfo as
            {
                types: Array<[string, string, [number, number, number, number], number, string, number]>,
                colors: Array<[string, string, [number, number, number, number]]>,
                brushes: Array<[string, string, string, number]>
            };

            // Convert them all to our structure types
            types.forEach(type => {
                const [className, name, color, size, icon, shadow] = type;
                this.markerTypes.set(className, {className, name, color: colorToHex(color), size, shadow, icon});
            });

            colors.forEach(type => {
                const [className, name, color] = type;
                this.markerColors.set(className, {className, name, color: colorToHex(color)});
            });

            brushes.forEach(type => {
                const [className, name, texture, drawBorder] = type;
                this.markerBrushes.set(className, {className, name, texture, drawBorder});
            });
        });

        window.Networking.Request({a: "ACE_TacPhone_Map", c: "GetAllMarkers"}).then((markerInfo: object) => {
            const {markers} = markerInfo as
            {
                markers: Array<MarkerUpdate>
            };

            markers.forEach(marker => {
                this.handleUpsert(marker);
            });
        });

    }

    public destroy(): void {
        // Unregisters cleanly from the global registry when called
        this.unregisterHooks.forEach((unregister) => unregister());
        this.unregisterHooks = [];
        this.source.clear();
    }

    private dynamicIconStyleFunction(feature: FeatureLike, resolution: number)
    {
        // Everything we can dynamically solve here, is slower (updated every render, instead of once at marker creation), but we don't fill the style cache with lots of crap

        const baseStyle = feature.get('baseStyle') as Style;
        if (!baseStyle) {
            return baseStyle;
        }

        const geometry = feature.getGeometry();
        if (geometry instanceof LineString) {
            const alpha = feature.get('alpha') as number;
            if (alpha !== undefined && alpha !== null && alpha !== 1) {
                const stroke = baseStyle.getStroke();
                if (stroke) {
                    const color = stroke.getColor();

                    // this is quite annoying, unlike icons/images, stroke has no opacity, it needs to be in the color#
                    // We initially set it as #hex

                    if (typeof color === 'string') {
                        if (color.startsWith('#') && color.length === 9) {
                            const r = parseInt(color.slice(1,3), 16);
                            const g = parseInt(color.slice(3,5), 16);
                            const b = parseInt(color.slice(5,7), 16);
                            stroke.setColor(`rgba(${r}, ${g}, ${b}, ${alpha})`);
                        } else if (color.startsWith('rgba')) {
                            // replace alpha
                            stroke.setColor(color.replace(/rgba\(([^,]+),([^,]+),([^,]+),([^)]+)\)/, `rgba($1,$2,$3,${alpha})`));
                        }
                    }
                }
            }
            return baseStyle;
        }

        // Everything we can dynamically solve here, is slower (updated every render, instead of once at marker creation), but we don't fill the style cache with lots of crap

        const rotationInRadians = (feature.get('dir') || 0) * (Math.PI / 180); 
        const alpha = feature.get('alpha') as number; 
        const size = feature.get('size') as [number, number];
        const shadow = feature.get('shadow') as boolean;


        // Try to replicate Arma's text zooming size behavior
        var zoom = 1 / resolution;
        if (zoom > 1.5)
            zoom = 1.5;
        if (zoom < 0.5)
            zoom = 0.5;

        //var textSize = 32 * zoom;

        var labelText = feature.get('label');

        if (labelText != '')
        {
            var text = new Text({
                text: feature.get('label'), // Will be updated per feature
                font: `normal bold condensed 24px "Roboto", sans-serif`,
                fill: new Fill({ color: (baseStyle.getImage() as Icon)?.getColor() || '#ffffff' }),
                offsetX: size ? 32*size[1] : 32, //#TODO offset depends on icon size, text is right side of icon
                scale: zoom,
                declutterMode: "declutter",
                textAlign: "left",
            });

            baseStyle.setText(text);
        }

        if (shadow)
        {
            // To annoying, makes it too hard to read
            //text.setStroke(new Stroke({ color: '#000000', width: 2 }));
        }

        baseStyle.getImage()?.setRotation(rotationInRadians);
        baseStyle.getImage()?.setOpacity(alpha);
        baseStyle.getImage()?.setScale(size);


        if (shadow)
        {
            var subShadow = baseStyle.clone();
            subShadow.getImage()?.setDisplacement([3, -3]); //#TODO thats not the correct offset, it also depends on scale?
            (subShadow.getImage() as Icon).setColor('rgba(0, 0, 0, 0.8)');

            return [
                subShadow,
                baseStyle
            ];
        }

        return baseStyle;
    }

    private createFeatureStyle(type: string, shape: string, color: string, brush: string, size: string): Style {

        var cacheKey = `${type}_${shape}_${color}_${brush}_${size}`;

        if (this.markerStyleCache.has(cacheKey))
            return this.markerStyleCache.get(cacheKey)!;

        if (shape === 'POLYLINE' || shape === 'polyline') {
            var colorResolved = this.markerColors.get(color);
            var lineColor = colorResolved ? colorResolved.color : '#000000';
            var strokeWidth = 2;

            var resStyle = new Style({
                stroke: new Stroke({
                    color: lineColor,
                    width: strokeWidth,
                }),
            });

            this.markerStyleCache.set(cacheKey, resStyle);
            return resStyle;
        }

        var markerIcon = new Icon({
                // Placeholder spinner image
                src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MCA1MCIgd2lkdGg9IjUwIiBoZWlnaHQ9IjUwIj4KICA8c3R5bGU+CiAgICAuc3Bpbm5lciB7CiAgICAgIGFuaW1hdGlvbjogcm90YXRlIDJzIGxpbmVhciBpbmZpbml0ZTsKICAgICAgdHJhbnNmb3JtLW9yaWdpbjogY2VudGVyIGNlbnRlcjsKICAgIH0KICAgIC5wYXRoIHsKICAgICAgc3Ryb2tlOiAjM2I4MmY2OwogICAgICBzdHJva2UtbGluZWNhcDogcm91bmQ7CiAgICAgIGFuaW1hdGlvbjogZGFzaCAxLjVzIGVhc2UtaW4tb3V0IGluZmluaXRlOwogICAgfQogICAgQGtleWZyYW1lcyByb3RhdGUgewogICAgICAxMDAlIHsgdHJhbnNmb3JtOiByb3RhdGUoMzYwZGVnKTsgfQogICAgfQogICAgQGtleWZyYW1lcyBkYXNoIHsKICAgICAgMCUgewogICAgICAgIHN0cm9rZS1kYXNoYXJyYXk6IDEsIDE1MDsKICAgICAgICBzdHJva2UtZGFzaG9mZnNldDogMDsKICAgICAgfQogICAgICA1MCUgewogICAgICAgIHN0cm9rZS1kYXNoYXJyYXk6IDkwLCAxNTA7CiAgICAgICAgc3Ryb2tlLWRhc2hvZmZzZXQ6IC0zNTsKICAgICAgfQogICAgICAxMDAlIHsKICAgICAgICBzdHJva2UtZGFzaGFycmF5OiA5MCwgMTUwOwogICAgICAgIHN0cm9rZS1kYXNob2Zmc2V0OiAtMTI0OwogICAgICB9CiAgICB9CiAgPC9zdHlsZT4KICA8Y2lyY2xlIGNsYXNzPSJzcGlubmVyIiBjeD0iMjUiIGN5PSIyNSIgcj0iMjAiIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iNCIgc3Ryb2tlPSIjZTJlOGYwIiAvPgogIDxjaXJjbGUgY2xhc3M9InNwaW5uZXIgcGF0aCIgY3g9IjI1IiBjeT0iMjUiIHI9IjIwIiBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjQiIC8+Cjwvc3ZnPg==",
                anchor: [0.5, 0.5], // Centers horizontal axis, anchors bottom vertical axis
                scale: 1,
                crossOrigin: 'anonymous',
            });

        var resStyle = new Style({
            image: markerIcon,
        });

        this.markerStyleCache.set(cacheKey, resStyle);


        /// Texture from main type

        var typeResolved = this.markerTypes.get(type);

        if (typeResolved == null) {
            //#TODO ????? Can markers even have non existing types?
            return resStyle;
        }

        if (!this.markerTextures.has(typeResolved.icon)) {
            // Fetch icon from game

            var texLoadPromise = new Promise<string>((resolve) => {
                window.Networking.LoadGameFileTexture(typeResolved!.icon, 64).then(iconData => {
                    this.markerTextures.set(typeResolved!.icon, iconData); // Replace promise with real data, so that others won't wait on it
                    resolve(iconData);
                    this.source.changed(); // Notify the layer of the change, it needs to refresh the icon
                });
            });

            this.markerTextures.set(typeResolved!.icon, texLoadPromise);
        };

        // If the icon is in markerTextures, we either have it in cache, or we are in the process of receiving it from game
        const markerTexture = this.markerTextures.get(typeResolved.icon)!;

        if (typeof markerTexture === 'string') {
            markerIcon.setSrc(markerTexture);
        }
        else 
        {
            // Its a promise, once its done we'll update the icon after the fact
            (markerTexture as Promise<string>).then(iconData =>
                markerIcon.setSrc(iconData)
            );
        }

        var colorResolved = this.markerColors.get(color == "" ? typeResolved.color : color);

        if (colorResolved == null) {
            //#TODO ????? Can markers even have non existing types?
            return resStyle;
        }

        markerIcon.setColor(colorResolved.color);
        return resStyle;
    }

    /**
     * Processes an incoming addition or position update
     */
    public handleUpsert(data: MarkerUpdate): void {

        const [name, type, color, dir, pos, text, shape, alpha, brush, size, _channel, polyline] = data;

        var sizeSplit = size.split(",").map(x => Number(x));

        // Parse polyline if present
        if (polyline && polyline.length > 0) {
            const coordinates: number[][] = [];
            const parts = polyline.split(';');
            for (let i = 0; i < parts.length; i += 2) {
                if (parts[i] !== '' && parts[i + 1] !== '') {
                    coordinates.push([Number(parts[i]), Number(parts[i + 1])]);
                }
            }

            if (coordinates.length > 0) {
                const existingFeature = this.markerRegistry.get(name);

                if (existingFeature) {
                    const geometry = existingFeature.getGeometry();
                    if (geometry instanceof LineString) {
                        geometry.setCoordinates(coordinates);
                    } else {
                        // Replace point with polyline
                        this.source.removeFeature(existingFeature);
                        this.markerRegistry.delete(name);
                        const newFeature = new Feature({
                            geometry: new LineString(coordinates),
                            id: name,
                            label: text,
                        });
                        newFeature.set("baseStyle", this.createFeatureStyle(type, shape, color, brush, size));
                        newFeature.set("alpha", alpha);
                        this.source.addFeature(newFeature);
                        this.markerRegistry.set(name, newFeature);
                        return;
                    }

                    existingFeature.set("baseStyle", this.createFeatureStyle(type, shape, color, brush, size));
                    existingFeature.set("label", text);
                    existingFeature.set("alpha", alpha);
                } else {
                    const newFeature = new Feature({
                        geometry: new LineString(coordinates),
                        id: name,
                        label: text,
                    });
                    newFeature.set("baseStyle", this.createFeatureStyle(type, shape, color, brush, size));
                    newFeature.set("alpha", alpha);
                    this.source.addFeature(newFeature);
                    this.markerRegistry.set(name, newFeature);
                }
                return;
            }
        }

        const existingFeature = this.markerRegistry.get(name);

        if (existingFeature) {
            // Update coordinates smoothly
            const geometry = existingFeature.getGeometry();
            if (geometry instanceof Point) {
                geometry.setCoordinates(pos);
            } else if (geometry instanceof LineString) {
                // Switching from polyline to point
                this.source.removeFeature(existingFeature);
                this.markerRegistry.delete(name);
                const newFeature = new Feature({
                    geometry: new Point(pos),
                    id: name,
                    label: text,
                });
                newFeature.set("dir", dir);
                newFeature.set("alpha", alpha);
                newFeature.set("size", sizeSplit);
                newFeature.set("baseStyle", this.createFeatureStyle(type, shape, color, brush, size));
                newFeature.set("shadow", this.markerTypes.get(type)!.shadow != 0);
                this.source.addFeature(newFeature);
                this.markerRegistry.set(name, newFeature);
                return;
            }

            existingFeature.set("dir", dir);
            existingFeature.set("alpha", alpha);
            existingFeature.set("size", sizeSplit);
            existingFeature.set("baseStyle", this.createFeatureStyle(type, shape, color, brush, size));
            existingFeature.set("label", text);

            //#TODO all the others

        } else {
            // Create new marker feature
            const newFeature = new Feature({
                geometry: new Point(pos),
                id: name,
                label: text,
            });

            //newFeature.setStyle(this.createFeatureStyle(type, shape, color, brush, dir, alpha, size));
            newFeature.set("dir", dir);
            newFeature.set("alpha", alpha);
            newFeature.set("size", sizeSplit);
            newFeature.set("baseStyle", this.createFeatureStyle(type, shape, color, brush, size));
            newFeature.set("shadow", this.markerTypes.get(type)!.shadow != 0);

            this.source.addFeature(newFeature);
            this.markerRegistry.set(name, newFeature);
        }
    }

    /**
     * Deletes a marker when it leaves or disconnects
     */
    public handleDelete(id: string): void {
        const feature = this.markerRegistry.get(id);
        if (feature) {
            this.source.removeFeature(feature);
            this.markerRegistry.delete(id);
        }
    }

    /**
     * Clear all markers at once
     */
    public clearAll(): void {
        this.source.clear();
        this.markerRegistry.clear();
    }
}
