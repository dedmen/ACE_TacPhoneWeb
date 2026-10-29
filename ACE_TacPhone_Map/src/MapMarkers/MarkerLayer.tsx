import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature, { type FeatureLike } from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import { Style, Icon, Text, Fill, Stroke } from 'ol/style';
import { mapCommandRegistry } from '../CommandRegistry';
import { markKnownMarkerNames, notifyMarkerUpsert, registerMarkerLayer } from './MarkerNotifications';


// name, type, color, dir, pos, text, shape, alpha, brush, size, channel, polyline
export type MarkerUpdate = [string, string, string, number, [number, number, number], string, string, number, string, string, number, string];

type PendingMarkerOperation =
    | { kind: 'upsert'; marker: MarkerUpdate }
    | { kind: 'delete'; name: string };

const MAX_PENDING_MARKER_OPERATIONS = 512;
const MARKER_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MARKER_COLOR = '#ffffff';
const DEFAULT_MARKER_SIZE: [number, number] = [1, 1];

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

function isValidMarkerScale(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function isFinitePosition(position: unknown): position is [number, number] {
    return Array.isArray(position) && Number.isFinite(position[0]) && Number.isFinite(position[1]);
}

/**
 * Marker sizes arrive either as a number or as a "width,height" string.
 * Invalid input falls back to the game's default uniform scale (1).
 */
function parseMarkerSize(size: unknown): [number, number] {
    if (typeof size === 'number') {
        return isValidMarkerScale(size) ? [size, size] : DEFAULT_MARKER_SIZE;
    }

    if (typeof size !== 'string') {
        return DEFAULT_MARKER_SIZE;
    }

    const parts = size.split(',');
    if (parts.length === 1) {
        const uniform = Number(parts[0]);
        return parts[0].trim() !== '' && isValidMarkerScale(uniform)
            ? [uniform, uniform]
            : DEFAULT_MARKER_SIZE;
    }

    if (parts.length === 2) {
        const width = Number(parts[0]);
        const height = Number(parts[1]);
        if (parts[0].trim() !== '' && parts[1].trim() !== '' && isValidMarkerScale(width) && isValidMarkerScale(height)) {
            return [width, height];
        }
    }

    return DEFAULT_MARKER_SIZE;
}

/**
 * Parses "x1;y1;x2;y2;..." into coordinates. Returns null when any component
 * is malformed or there is not an even number of them.
 */
function parsePolylineCoordinates(polyline: unknown): number[][] | null {
    if (typeof polyline !== 'string' || polyline === '') {
        return null;
    }

    const parts = polyline.split(';');
    if (parts.length < 4 || parts.length % 2 !== 0) {
        return null;
    }

    const coordinates: number[][] = [];
    for (let i = 0; i < parts.length; i += 2) {
        if (parts[i].trim() === '' || parts[i + 1].trim() === '') {
            return null;
        }

        const x = Number(parts[i]);
        const y = Number(parts[i + 1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return null;
        }

        coordinates.push([x, y]);
    }

    return coordinates;
}

/**
 * Settles with the request result, or null after a timeout/error. This keeps a
 * hung game request from blocking marker loading forever.
 */
function requestWithTimeout<T>(request: Promise<T>, description: string): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
        let settled = false;
        let timer: number | null = null;

        const settle = (value: T | null): void => {
            if (settled) {
                return;
            }

            settled = true;
            if (timer !== null) {
                window.clearTimeout(timer);
            }
            resolve(value);
        };

        timer = window.setTimeout(() => {
            console.warn(`${description} timed out after ${MARKER_REQUEST_TIMEOUT_MS} ms`);
            settle(null);
        }, MARKER_REQUEST_TIMEOUT_MS);

        request.then(
            (value) => settle(value),
            (error: unknown) => {
                console.error(`${description} failed`, error);
                settle(null);
            },
        );
    });
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
    private pendingOverflowWarned = false;
    private destroyed = false;

    private unregisterHooks: Array<() => void> = [];

    // Keeps the module-scope marker notification backup handler quiet while this
    // layer owns the marker features.
    private releaseMarkerLayer: (() => void) | null = null;

    constructor(title: string = 'Live Markers') {
        this.markerConfigReady = new Promise<void>((resolve) => {
            this.resolveMarkerConfigReady = resolve;
        });

        this.releaseMarkerLayer = registerMarkerLayer();

        this.source = new VectorSource();
        this.layer = new VectorLayer({
            properties: { title },
            source: this.source,
            // Text declutterMode only has an effect on a decluttering layer.
            declutter: true,
            style: this.dynamicIconStyleFunction
        });

        // Register handlers via the class instance methods
        this.unregisterHooks.push(
            mapCommandRegistry.register('Marker.Upsert', (payload) => this.handleUpsert((payload as {marker: MarkerUpdate}).marker))
        );
        this.unregisterHooks.push(
            mapCommandRegistry.register('Marker.Delete', (payload) => this.handleDelete((payload as {marker: string}).marker as string))
        );

        // Retrieve both snapshots in parallel. GetMarkerTypes used to gate
        // GetAllMarkers, so a single hung request could block marker loading
        // forever. requestWithTimeout() guarantees that both settle.
        const markerConfigPromise = this.loadMarkerConfig();
        const initialMarkersPromise = this.loadInitialMarkers();

        void Promise.all([markerConfigPromise, initialMarkersPromise]).then(([, markers]) => {
            if (this.destroyed || !markers) {
                return;
            }

            markers.forEach((marker) => {
                try {
                    this.applyUpsert(marker);
                } catch (error) {
                    console.error('Failed to apply a marker from the initial snapshot', error);
                }
            });

            // Everything in the snapshot already exists, so seeding the names
            // keeps the initial load silent. Queued live updates are flushed
            // afterwards by the finally block and may still notify.
            markKnownMarkerNames(markers.map((marker) => marker[0]));
        }).finally(() => {
            if (this.destroyed) {
                return;
            }

            // Even a failed/timed-out load must unblock the update queue.
            this.initialMarkersLoaded = true;
            this.flushPendingMarkerOperations();
        });
    }

    private loadMarkerConfig(): Promise<void> {
        return requestWithTimeout(
            window.Networking.Request({a: "ACE_TacPhone_Map", c: "GetMarkerTypes"}),
            'GetMarkerTypes',
        ).then((markerInfo: object | null) => {
            if (this.destroyed || !markerInfo) {
                return;
            }

            // Game sends them as arrays, because thats cheaper to serialize than hashmaps
            const {types, colors, brushes} = markerInfo as
            {
                types: Array<[string, string, [number, number, number, number], number, string, number]>,
                colors: Array<[string, string, [number, number, number, number]]>,
                brushes: Array<[string, string, string, number]>
            };

            // Convert them all to our structure types
            if (Array.isArray(types)) {
                types.forEach(type => {
                    const [className, name, color, size, icon, shadow] = type;
                    this.markerTypes.set(className, {className, name, color: colorToHex(color), size, shadow, icon});
                });
            }

            if (Array.isArray(colors)) {
                colors.forEach(type => {
                    const [className, name, color] = type;
                    this.markerColors.set(className, {className, name, color: colorToHex(color)});
                });
            }

            if (Array.isArray(brushes)) {
                brushes.forEach(type => {
                    const [className, name, texture, drawBorder] = type;
                    this.markerBrushes.set(className, {className, name, texture, drawBorder});
                });
            }
        }).catch((error: unknown) => {
            console.error('Failed to load marker types', error);
        }).finally(() => {
            // Also resolves when the request timed out or this manager was destroyed.
            this.resolveMarkerConfigReady();
        });
    }

    private loadInitialMarkers(): Promise<MarkerUpdate[] | null> {
        return requestWithTimeout(
            window.Networking.Request({a: "ACE_TacPhone_Map", c: "GetAllMarkers"}),
            'GetAllMarkers',
        ).then((markerInfo: object | null) => {
            if (this.destroyed || !markerInfo) {
                return null;
            }

            const {markers} = markerInfo as {markers?: unknown};
            return Array.isArray(markers) ? markers as MarkerUpdate[] : [];
        }).catch((error: unknown) => {
            console.error('Failed to load markers', error);
            return null;
        });
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        // Unregisters cleanly from the global registry when called
        this.unregisterHooks.forEach((unregister) => unregister());
        this.unregisterHooks = [];
        this.pendingMarkerOperations = [];
        this.markerTextures.clear();
        this.markerRegistry.clear();
        this.source.clear();

        // The release function is idempotent, so the layer count cannot go below 0.
        this.releaseMarkerLayer?.();
        this.releaseMarkerLayer = null;
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
        if (this.destroyed) {
            return Promise.reject(new Error('Marker layer manager was destroyed'));
        }

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
            // The manager may have been destroyed while the texture was loading.
            if (!this.destroyed) {
                this.markerTextures.set(iconPath, iconData); // Replace promise with real data, so that others won't wait on it
                this.source.changed(); // Notify the layer of the change, it needs to refresh the icon
            }
            return iconData;
        }).catch((error: unknown) => {
            if (!this.destroyed) {
                this.markerTextures.delete(iconPath);
            }
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
                if (!this.destroyed) {
                    markerIcon.setSrc(iconData);
                }
            }).catch(() => {
                // Keep the placeholder spinner if the icon could not be loaded
            });
        }

        // `color` is a CfgMarkerColors class name, or empty for the marker type's
        // own color. markerColors is keyed by class name, not by a hex value.
        var colorResolved = color !== '' ? this.markerColors.get(color) : undefined;

        markerIcon.setColor(colorResolved?.color || typeResolved.color || DEFAULT_MARKER_COLOR);
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
        this.pendingOverflowWarned = false;

        pending.forEach((operation) => {
            if (this.destroyed) {
                return;
            }

            try {
                if (operation.kind === 'upsert') {
                    this.applyUpsert(operation.marker);
                    notifyMarkerUpsert(operation.marker);
                } else {
                    this.deleteMarker(operation.name);
                }
            } catch (error) {
                // One malformed update must not abort the rest of the queue.
                console.error('Failed to apply a queued marker operation', error);
            }
        });
    }

    private queuePendingMarkerOperation(operation: PendingMarkerOperation): void {
        if (this.pendingMarkerOperations.length >= MAX_PENDING_MARKER_OPERATIONS) {
            // Drop the oldest update so the newest positions survive, but never
            // grow the queue without bound while the initial snapshot is pending.
            this.pendingMarkerOperations.shift();

            if (!this.pendingOverflowWarned) {
                this.pendingOverflowWarned = true;
                console.warn(`More than ${MAX_PENDING_MARKER_OPERATIONS} marker updates were queued before the initial snapshot loaded; dropping the oldest updates.`);
            }
        }

        this.pendingMarkerOperations.push(operation);
    }

    /**
     * Processes an incoming addition or position update
     */
    public handleUpsert(data: MarkerUpdate): void {
        if (this.destroyed) {
            return;
        }

        if (!this.initialMarkersLoaded) {
            this.queuePendingMarkerOperation({ kind: 'upsert', marker: data });
            return;
        }

        this.applyUpsert(data);
        notifyMarkerUpsert(data);
    }

    private applyUpsert(data: MarkerUpdate): void {
        const [name, type, color, dir, pos, text, shape, alpha, brush, size, channel, polyline] = data;
        const registryKey = this.markerKey(name, channel);

        var sizeSplit = parseMarkerSize(size);
        var featureStyle = this.createFeatureStyle(type, shape, color, brush, size, alpha);
        var shadow = this.getMarkerShadow(type);

        // Parse polyline if present. Malformed geometry is ignored instead of
        // handing NaN coordinates to OpenLayers.
        const coordinates = parsePolylineCoordinates(polyline);
        if (coordinates) {
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

        if (!isFinitePosition(pos)) {
            console.warn(`Skipping marker "${name}" with an invalid position.`);
            return;
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
        if (this.destroyed) {
            return;
        }

        if (!this.initialMarkersLoaded) {
            this.queuePendingMarkerOperation({ kind: 'delete', name: id });
            return;
        }

        this.deleteMarker(id);
    }

    /**
     * Clear all markers at once
     */
    public clearAll(): void {
        if (this.destroyed) {
            return;
        }

        this.source.clear();
        this.markerRegistry.clear();
    }
}
