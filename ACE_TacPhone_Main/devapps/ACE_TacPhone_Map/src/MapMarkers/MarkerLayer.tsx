import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature, { type FeatureLike } from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import { Style, Icon, Text, Fill, Stroke } from 'ol/style';
import { mapCommandRegistry } from '../CommandRegistry';


//#TODO size is "12,123", decompose it into two numbers
// name, type, color, dir, pos, text, shape, alpha, brush, size, channel, polyline
type MarkerUpdate = [string, string, string, number, [number, number, number], string, string, number, string, string, number, string];

type PendingMarkerOperation =
    | { kind: 'upsert'; marker: MarkerUpdate }
    | { kind: 'delete'; name: string };

export interface MarkerType {
    className: string;
    name: string;
    color: string;
    size: number;
    shadow: number;
    icon: string;
}

export interface MarkerColor {
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

function applyAlphaToColor(color: string, alpha: number): string {
    if (alpha === undefined || alpha === null || alpha === 1) {
        return color;
    }

    // Hex colors from the game are #rrggbbaa. Strokes have no separate opacity,
    // so the marker alpha has to be part of the stroke color.
    if (color.startsWith('#') && color.length === 9) {
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    if (color.startsWith('rgba')) {
        return color.replace(/rgba\(([^,]+),([^,]+),([^,]+),([^)]+)\)/, `rgba($1,$2,$3,${alpha})`);
    }

    return color;
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

    private markerConfigReady: Promise<void>;
    private resolveMarkerConfigReady!: () => void;

    private initialMarkersLoaded = false;
    private pendingMarkerOperations: PendingMarkerOperation[] = [];

    private unregisterHooks: Array<() => void> = [];

    constructor(title: string = 'Live Markers') {
        this.markerConfigReady = new Promise<void>((resolve) => {
            this.resolveMarkerConfigReady = resolve;
        });

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
        }).catch((error: unknown) => {
            console.error('Failed to load marker types', error);
        }).finally(() => {
            this.resolveMarkerConfigReady();
        });

        // Marker updates can arrive while GetMarkerTypes is still in flight.
        // Wait for the config, then apply the initial snapshot before replaying
        // any updates that were queued in the meantime.
        void this.whenMarkerConfigLoaded().then(() => {
            return window.Networking.Request({a: "ACE_TacPhone_Map", c: "GetAllMarkers"});
        }).then((markerInfo: object) => {
            const {markers} = markerInfo as
            {
                markers: Array<MarkerUpdate>
            };

            markers.forEach(marker => {
                this.applyUpsert(marker);
            });
        }).catch((error: unknown) => {
            console.error('Failed to load markers', error);
        }).finally(() => {
            this.initialMarkersLoaded = true;
            this.flushPendingMarkerOperations();
        });

    }

    public destroy(): void {
        // Unregisters cleanly from the global registry when called
        this.unregisterHooks.forEach((unregister) => unregister());
        this.unregisterHooks = [];
        this.source.clear();
    }

    /**
     * Resolves once the marker types and colors have been received from the game.
     */
    public whenMarkerConfigLoaded(): Promise<void> {
        return this.markerConfigReady;
    }

    public getMarkerTypes(): MarkerType[] {
        return Array.from(this.markerTypes.values());
    }

    public getMarkerColors(): MarkerColor[] {
        return Array.from(this.markerColors.values());
    }

    /**
     * Loads (and caches) the icon texture of a marker type.
     */
    public loadMarkerIcon(iconPath: string): Promise<string> {
        if (!iconPath) {
            return Promise.reject(new Error('Marker type has no icon'));
        }

        const cachedTexture = this.markerTextures.get(iconPath);

        if (typeof cachedTexture === 'string') {
            return Promise.resolve(cachedTexture);
        }

        if (cachedTexture) {
            return cachedTexture;
        }

        const texturePromise = window.Networking.LoadGameFileTexture(iconPath, 64).then((iconData) => {
            this.markerTextures.set(iconPath, iconData); // Replace promise with real data, so that others won't wait on it
            this.source.changed(); // Notify the layer of the change, it needs to refresh the icon
            return iconData;
        }).catch((error: unknown) => {
            this.markerTextures.delete(iconPath);
            throw error;
        });

        this.markerTextures.set(iconPath, texturePromise);

        return texturePromise;
    }

    private dynamicIconStyleFunction = (feature: FeatureLike, resolution: number) => {
        // Each feature owns its base style. Anything that changes per update is
        // baked into that style in createFeatureStyle; only render-time values
        // are applied here.

        const baseStyle = feature.get('baseStyle') as Style;
        if (!baseStyle) {
            return baseStyle;
        }

        const geometry = feature.getGeometry();
        if (geometry instanceof LineString) {
            // The line color (including marker alpha) is baked into this
            // feature's own style when it is created/updated.
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
    };

    private createFeatureStyle(type: string, shape: string, color: string, _brush: string, _size: string, alpha: number): Style {

        if (shape === 'POLYLINE' || shape === 'polyline') {
            var colorResolved = this.markerColors.get(color);
            var lineColor = colorResolved ? colorResolved.color : '#000000';
            var strokeWidth = 2;

            // Styles are per-feature, so applying the alpha here cannot leak
            // into another polyline and is restored when alpha becomes 1.
            return new Style({
                stroke: new Stroke({
                    color: applyAlphaToColor(lineColor, alpha),
                    width: strokeWidth,
                }),
            });
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


        /// Texture from main type

        var typeResolved = this.markerTypes.get(type);

        if (typeResolved == null) {
            console.warn(`Unknown marker type "${type}"`);
            return resStyle;
        }

        var cachedTexture = this.markerTextures.get(typeResolved.icon);
        if (typeof cachedTexture === 'string') {
            markerIcon.setSrc(cachedTexture);
        } else {
            this.loadMarkerIcon(typeResolved.icon).then((iconData) => {
                markerIcon.setSrc(iconData);
            }).catch(() => {
                // Keep the placeholder spinner if the icon could not be loaded
            });
        }

        var colorResolved = this.markerColors.get(color == "" ? typeResolved.color : color);

        markerIcon.setColor(colorResolved ? colorResolved.color : '#ffffff');
        return resStyle;
    }

    private markerKey(name: string, channel: number): string {
        return `${channel ?? 0}:${name}`;
    }

    private getMarkerShadow(type: string): boolean {
        return (this.markerTypes.get(type)?.shadow ?? 0) !== 0;
    }

    private flushPendingMarkerOperations(): void {
        const pending = this.pendingMarkerOperations;
        this.pendingMarkerOperations = [];

        pending.forEach((operation) => {
            if (operation.kind === 'upsert') {
                this.applyUpsert(operation.marker);
            } else {
                this.deleteMarker(operation.name);
            }
        });
    }

    /**
     * Processes an incoming addition or position update
     */
    public handleUpsert(data: MarkerUpdate): void {
        if (!this.initialMarkersLoaded) {
            this.pendingMarkerOperations.push({ kind: 'upsert', marker: data });
            return;
        }

        this.applyUpsert(data);
    }

    private applyUpsert(data: MarkerUpdate): void {
        const [name, type, color, dir, pos, text, shape, alpha, brush, size, channel, polyline] = data;
        const registryKey = this.markerKey(name, channel);

        var sizeSplit = size.split(",").map(x => Number(x));
        var featureStyle = this.createFeatureStyle(type, shape, color, brush, size, alpha);
        var shadow = this.getMarkerShadow(type);

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
                const existingFeature = this.markerRegistry.get(registryKey);

                if (existingFeature) {
                    const geometry = existingFeature.getGeometry();
                    if (geometry instanceof LineString) {
                        geometry.setCoordinates(coordinates);
                    } else {
                        // Replace point with polyline
                        this.source.removeFeature(existingFeature);
                        this.markerRegistry.delete(registryKey);
                        const newFeature = new Feature({
                            geometry: new LineString(coordinates),
                            id: name,
                            label: text,
                        });
                        newFeature.set("dir", dir);
                        newFeature.set("alpha", alpha);
                        newFeature.set("size", sizeSplit);
                        newFeature.set("baseStyle", featureStyle);
                        newFeature.set("shadow", shadow);
                        this.source.addFeature(newFeature);
                        this.markerRegistry.set(registryKey, newFeature);
                        return;
                    }

                    existingFeature.set("baseStyle", featureStyle);
                    existingFeature.set("label", text);
                    existingFeature.set("alpha", alpha);
                } else {
                    const newFeature = new Feature({
                        geometry: new LineString(coordinates),
                        id: name,
                        label: text,
                    });
                    newFeature.set("alpha", alpha);
                    newFeature.set("baseStyle", featureStyle);
                    this.source.addFeature(newFeature);
                    this.markerRegistry.set(registryKey, newFeature);
                }
                return;
            }
        }

        const existingFeature = this.markerRegistry.get(registryKey);

        if (existingFeature) {
            // Update coordinates smoothly
            const geometry = existingFeature.getGeometry();
            if (geometry instanceof Point) {
                geometry.setCoordinates(pos);
            } else if (geometry instanceof LineString) {
                // Switching from polyline to point
                this.source.removeFeature(existingFeature);
                this.markerRegistry.delete(registryKey);
                const newFeature = new Feature({
                    geometry: new Point(pos),
                    id: name,
                    label: text,
                });
                newFeature.set("dir", dir);
                newFeature.set("alpha", alpha);
                newFeature.set("size", sizeSplit);
                newFeature.set("baseStyle", featureStyle);
                newFeature.set("shadow", shadow);
                this.source.addFeature(newFeature);
                this.markerRegistry.set(registryKey, newFeature);
                return;
            }

            existingFeature.set("dir", dir);
            existingFeature.set("alpha", alpha);
            existingFeature.set("size", sizeSplit);
            existingFeature.set("baseStyle", featureStyle);
            existingFeature.set("label", text);
            existingFeature.set("shadow", shadow);

            //#TODO all the others

        } else {
            // Create new marker feature
            const newFeature = new Feature({
                geometry: new Point(pos),
                id: name,
                label: text,
            });

            newFeature.set("dir", dir);
            newFeature.set("alpha", alpha);
            newFeature.set("size", sizeSplit);
            newFeature.set("baseStyle", featureStyle);
            newFeature.set("shadow", shadow);

            this.source.addFeature(newFeature);
            this.markerRegistry.set(registryKey, newFeature);
        }
    }

    private deleteMarker(name: string): void {
        const suffix = `:${name}`;

        // The game sends deletes by name only, so remove every channel entry
        // with that name. Marker names are normally unique anyway.
        [...this.markerRegistry.keys()].forEach((key) => {
            if (key !== name && !key.endsWith(suffix)) {
                return;
            }

            const feature = this.markerRegistry.get(key);
            if (feature) {
                this.source.removeFeature(feature);
                this.markerRegistry.delete(key);
            }
        });
    }

    /**
     * Deletes a marker when it leaves or disconnects
     */
    public handleDelete(id: string): void {
        if (!this.initialMarkersLoaded) {
            this.pendingMarkerOperations.push({ kind: 'delete', name: id });
            return;
        }

        this.deleteMarker(id);
    }

    /**
     * Clear all markers at once
     */
    public clearAll(): void {
        this.source.clear();
        this.markerRegistry.clear();
    }
}
