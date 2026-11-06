/**
 * Marker layer bookkeeping for an existing OpenLayers map.
 *
 * Owns the per-channel marker layers, the feature registry and the game
 * update flow. The OpenLayers styles are built by MarkerStyles; the
 * historic import path ./MarkerLayer re-exports this module.
 */

import type OlMap from 'ol/Map';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature, { type FeatureLike } from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import { Icon, type Style } from 'ol/style';
import { mapCommandRegistry } from '../CommandRegistry';
import { markKnownMarkerNames, notifyMarkerUpsert, registerMarkerLayer } from './MarkerNotifications';
import {
    createMarker,
    deleteMarker as deleteMarkerRequest,
    updateMarker as updateMarkerRequest,
    updateMarkerPosition,
    type MarkerCreationData,
} from './MarkerApi';
import {
    ALWAYS_VISIBLE_CHANNELS,
    DEFAULT_MULTIPLAYER_CHANNEL,
    INACTIVE_CHANNEL_ALPHA,
    SINGLEPLAYER_CHANNEL,
    getChannelLabel,
    isChannelAvailable,
    parseMarkerChannels,
    type MarkerChannel,
} from './Channels';
import { PolylineMeasurementLayer } from './PolylineMeasurementLayer';
import { isPolylineMeasurementsText } from './PolylineMeasurements';
import { markerLabelColor, resolveMarkerColor } from './MarkerColorUtils';
import type { MapDebugChannel, MapDebugMarker, MapDebugState } from './MapTestHooks';
import { MarkerStyles, applyAlphaToColor, colorAlpha } from './MarkerStyles';
import ImageState from 'ol/ImageState';


// name, type, color, dir, pos, text, shape, alpha, brush, size, channel, polyline
export type MarkerUpdate = [string, string, string, number, [number, number, number], string, string, number, string, string, number, string];

type PendingMarkerOperation =
    | { kind: 'upsert'; marker: MarkerUpdate }
    | { kind: 'delete'; name: string };

const MAX_PENDING_MARKER_OPERATIONS = 512;
const MARKER_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MARKER_SIZE: [number, number] = [1, 1];
// Minimum delay between two position updates sent to the game while a marker
// is dragged. In-between positions are coalesced into one trailing update.
const MARKER_MOVE_THROTTLE_MS = 100;
const USER_DEFINED_MARKER_PREFIX = '_USER_DEFINED';

/**
 * Only markers created by players (the game names them with the
 * `_USER_DEFINED` prefix) may be moved or deleted from the Web UI.
 */
export function isEditableMarkerName(name: unknown): name is string {
    return typeof name === 'string' && name !== '' && name.startsWith(USER_DEFINED_MARKER_PREFIX);
}

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

/** Everything the edit dialog needs to pre-fill itself. */
export interface MarkerProperties {
    name: string;
    label: string;
    type: string;
    color: string;
    position: [number, number];
    dir: number;
    size: [number, number];
    channel: number;
}

/** Live marker preview shown at the position the dialog will create at. */
export interface MarkerPreviewDraft {
    position: [number, number];
    label: string;
    type: string;
    color: string;
    dir: number;
    size: number;
    channel: number;
}

interface ChannelLayerState {
    channel: MarkerChannel;
    layer: VectorLayer<VectorSource>;
    source: VectorSource;
}

/**
 * Everything another app needs to show and describe an icon marker, for
 * example as a `map.marker` chat object in the Messenger app.
 */
export interface MarkerChatData {
    /** Internal marker name, used as the `focusMarker` argument. */
    name: string;
    /** Marker type class name (CfgMarkers). */
    type: string;
    /** Marker color class name (CfgMarkerColors); empty for the type color. */
    color: string;
    /** Marker text/label as sent by the game. */
    text: string;
    /** Alias of {@link text}; the game has no separate label for marker text. */
    label: string;
    /** Map/world position. Data only: never shown as coordinates in a preview. */
    position: [number, number];
    /** Game texture path of the marker type icon; empty when the type is unknown. */
    typeIcon: string;
    /** Resolved marker color as a CSS hex string. */
    resolvedColor: string;
}

/** Per-marker bookkeeping while the user drags a marker in the Web UI. */
interface MarkerMoveState {
    /** Timestamp of the last position update sent to the game. */
    lastSentAt: number;
    /** Last position sent, so duplicate requests are dropped. */
    lastSentPosition: [number, number] | null;
    /** Pending trailing update, at most one per marker. */
    pendingTimer: number | null;
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
    if (Array.isArray(size) && size.length === 2) {
        const width = Number(size[0]);
        const height = Number(size[1]);
        return isValidMarkerScale(width) && isValidMarkerScale(height)
            ? [width, height]
            : DEFAULT_MARKER_SIZE;
    }

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
    private readonly map: OlMap;
    public readonly styles: MarkerStyles;
    // Registry to easily find features by ID without looping through the entire layer
    private markerRegistry: Map<string, Feature<Point | LineString>> = new Map();

    /** One marker layer per channel that is currently shown. */
    private channelLayers: Map<number, ChannelLayerState> = new Map();
    private channels: MarkerChannel[] = [];
    private isMultiplayerFlag = false;
    public activeChannelId: number = SINGLEPLAYER_CHANNEL;
    private channelsLoaded = false;
    private channelsReady: Promise<void>;
    private resolveChannelsReady!: () => void;

    private measurementLayer: PolylineMeasurementLayer;
    private previewLayer: VectorLayer<VectorSource>;
    private previewSource: VectorSource;
    private previewFeature: Feature<Point> | null = null;
    /** Invalidates pending icon loads so only the newest preview style wins. */
    private previewStyleRevision = 0;

    //#TODO store these globally, and only load them once, in case we have multiple maps
    // In general if we have multiple maps, there should probably just be one MarkerLayerManager
    public markerTypes: Map<string, MarkerType> = new Map();
    private markerColors: Map<string, MarkerColor> = new Map();
    private markerBrushes: Map<string, MarkerBrush> = new Map();

    public markerTextures: Map<string, string | Promise<string>> = new Map();

    private markerConfigReady: Promise<void>;
    private resolveMarkerConfigReady!: () => void;

    private initialMarkersLoaded = false;
    /** Resolves once the initial marker snapshot is applied (or failed). */
    private markersLoaded: Promise<void>;
    private resolveMarkersLoaded!: () => void;
    private playerId: string | undefined;

    private pendingMarkerOperations: PendingMarkerOperation[] = [];
    private pendingOverflowWarned = false;
    public destroyed = false;

    // Markers the user is currently dragging in the Web UI. Presence means the
    // local geometry is authoritative until the drag ends, so game updates must
    // not fight the pointer.
    private movingMarkers = new Map<string, MarkerMoveState>();

    /**
     * Name of the polyline whose geometry the user is editing. Incoming
     * `Marker.Upsert` updates keep the local geometry for that marker.
     */
    private editingPolylineName: string | null = null;

    private unregisterHooks: Array<() => void> = [];

    // Keeps the module-scope marker notification backup handler quiet while this
    // layer owns the marker features.
    private releaseMarkerLayer: (() => void) | null = null;

    constructor(map: OlMap) {
        this.map = map;
        this.styles = new MarkerStyles(this);
        this.markerConfigReady = new Promise<void>((resolve) => {
            this.resolveMarkerConfigReady = resolve;
        });

        this.markersLoaded = new Promise<void>((resolve) => {
            this.resolveMarkersLoaded = resolve;
        });

        this.channelsReady = new Promise<void>((resolve) => {
            this.resolveChannelsReady = resolve;
        });

        this.releaseMarkerLayer = registerMarkerLayer();

        this.previewSource = new VectorSource();
        this.previewLayer = new VectorLayer({
            source: this.previewSource,
            declutter: true,
            style: this.styles.dynamicIconStyleFunction,
        });
        this.previewLayer.setZIndex(3);
        this.map.addLayer(this.previewLayer);

        this.measurementLayer = new PolylineMeasurementLayer(this.map, {
            isChannelVisible: (channel) => this.channelLayers.get(channel)?.layer.getVisible() ?? false,
            getActiveChannel: () => this.activeChannelId,
            getChannelDim: (channel) => this.getChannelDim(channel),
        });
        this.map.addLayer(this.measurementLayer.layer);

        // Register handlers via the class instance methods
        this.unregisterHooks.push(
            mapCommandRegistry.register('Marker.Upsert', (payload) => this.handleUpsert((payload as {marker: MarkerUpdate}).marker))
        );
        this.unregisterHooks.push(
            mapCommandRegistry.register('Marker.Delete', (payload) => this.handleDelete((payload as {marker: string}).marker as string))
        );

        // Retrieve all data in parallel. GetMarkerTypes used to gate
        // GetAllMarkers, so a single hung request could block marker loading
        // forever. requestWithTimeout() guarantees that all settle.
        const markerConfigPromise = this.loadMarkerConfig();
        const initialMarkersPromise = this.loadInitialMarkers();
        const channelsPromise = this.loadMarkerChannels();
        const gameInfoPromise = window.TacPhone.gameInfo.whenReady().catch((error: unknown) => {
            console.warn('Failed to read global game info for markers', error);
            return {
                multiplayer: false,
                playerId: '',
                missionName: '',
                terrainName: '',
                gameVersion: '',
                debug: false,
            };
        });

        void Promise.all([markerConfigPromise, initialMarkersPromise, channelsPromise, gameInfoPromise]).then(([, markers, , info]) => {
            if (this.destroyed) {
                return;
            }

            this.isMultiplayerFlag = info.multiplayer === true;
            this.playerId = info.playerId || undefined;
            this.activeChannelId = this.isMultiplayerFlag
                ? this.getDefaultMultiplayerChannel()
                : SINGLEPLAYER_CHANNEL;

            this.configureChannelLayers();

            if (!markers) {
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
            // Always resolve the readiness promise, even after destroy and after
            // a failed/timed-out snapshot: focusMarker() must never hang.
            this.resolveMarkersLoaded();

            if (this.destroyed) {
                return;
            }

            // A failed game-info load must not leave the manager without a layer.
            if (!this.channelsLoaded) {
                this.isMultiplayerFlag = false;
                this.configureChannelLayers();
            }

            // Even a failed/timed-out load must unblock the update queue.
            this.initialMarkersLoaded = true;
            this.flushPendingMarkerOperations();
        });
    }

    /** Resolves once the game mode and marker channels are ready. */
    public whenChannelsLoaded(): Promise<void> {
        return this.channelsReady;
    }

    public isMultiplayer(): boolean {
        return this.isMultiplayerFlag;
    }

    public getChannels(): MarkerChannel[] {
        return this.channels.map((channel) => ({ ...channel }));
    }

    public getAvailableChannels(): MarkerChannel[] {
        if (!this.isMultiplayerFlag) {
            return this.channels.filter((channel) => channel.id === SINGLEPLAYER_CHANNEL);
        }

        return this.channels.filter((channel) => channel.mapMarkersEnabled);
    }

    public getChannelLabel(channel: number): string {
        return getChannelLabel(this.channels, channel);
    }

    public getActiveChannel(): number {
        return this.activeChannelId;
    }

    public setActiveChannel(channel: number): void {
        if (this.destroyed || !this.isMultiplayerFlag) {
            return;
        }

        const info = this.channels.find((candidate) => candidate.id === channel);
        if (!isChannelAvailable(info)) {
            return;
        }

        if (this.activeChannelId === channel) {
            return;
        }

        this.activeChannelId = channel;
        this.refreshChannelStyles();
        this.measurementLayer.setActiveChannel();
        this.refreshAllSources();
    }

    public resolveChannel(channel: unknown): number {
        if (!this.isMultiplayerFlag) {
            return SINGLEPLAYER_CHANNEL;
        }

        const numeric = Number(channel);
        if (!Number.isInteger(numeric) || numeric < 0) {
            return DEFAULT_MULTIPLAYER_CHANNEL;
        }

        return numeric;
    }

    public getEffectiveChannelForRequest(channel: unknown): number {
        return this.resolveChannel(channel);
    }

    public isMarkerLayer(layer: unknown): boolean {
        for (const state of this.channelLayers.values()) {
            if (state.layer === layer) {
                return true;
            }
        }

        return false;
    }

    private getDefaultMultiplayerChannel(): number {
        const preferred = [DEFAULT_MULTIPLAYER_CHANNEL, 1, 3, 5, 2, 4];
        for (const id of preferred) {
            const info = this.channels.find((channel) => channel.id === id);
            if (isChannelAvailable(info)) {
                return id;
            }
        }

        return this.channels.find((channel) => channel.mapMarkersEnabled)?.id
            ?? DEFAULT_MULTIPLAYER_CHANNEL;
    }

    private configureChannelLayers(): void {
        if (this.channelsLoaded) {
            return;
        }

        this.channelsLoaded = true;

        if (this.channels.length === 0) {
            this.channels = parseMarkerChannels(null);
        }

        const active = this.channels.find((channel) => channel.id === this.activeChannelId);
        if (this.isMultiplayerFlag && !isChannelAvailable(active)) {
            this.activeChannelId = this.getDefaultMultiplayerChannel();
        }

        const always = this.isMultiplayerFlag
            ? [...ALWAYS_VISIBLE_CHANNELS]
            : [SINGLEPLAYER_CHANNEL];

        for (const channel of always) {
            this.ensureChannelLayer(channel);
        }

        this.resolveChannelsReady();
    }

    private ensureChannelLayer(channel: number): ChannelLayerState {
        const existing = this.channelLayers.get(channel);
        if (existing) {
            return existing;
        }

        const info = this.channels.find((candidate) => candidate.id === channel) ?? {
            id: channel,
            label: getChannelLabel(this.channels, channel),
            custom: channel > 5,
            mapMarkersEnabled: false,
        };

        const source = new VectorSource();
        const layer = new VectorLayer({
            properties: {
                title: info.label,
                markerChannel: channel,
                markerChannelAvailable: info.mapMarkersEnabled,
            },
            source,
            declutter: true,
            style: this.styles.dynamicIconStyleFunction,
        });
        layer.setZIndex(1);
        layer.on('change:visible', () => this.measurementLayer.refresh());
        this.map.addLayer(layer);

        const state: ChannelLayerState = { channel: info, layer, source };
        this.channelLayers.set(channel, state);
        return state;
    }

    private removeChannelLayerIfEmpty(channel: number): void {
        if (!this.isMultiplayerFlag || ALWAYS_VISIBLE_CHANNELS.has(channel)) {
            return;
        }

        const state = this.channelLayers.get(channel);
        if (!state || state.source.getFeatures().length > 0) {
            return;
        }

        this.map.removeLayer(state.layer);
        this.channelLayers.delete(channel);
        this.measurementLayer.refresh();
    }

    public getChannelDim(channel: unknown): number {
        if (!this.isMultiplayerFlag) {
            return 1;
        }

        return Number(channel) === this.activeChannelId ? 1 : INACTIVE_CHANNEL_ALPHA;
    }

    private refreshChannelStyles(): void {
        for (const [key, feature] of this.markerRegistry) {
            const geometry = feature.getGeometry();
            if (!(geometry instanceof LineString)) {
                continue;
            }

            const channel = this.resolveChannel(feature.get('channel'));
            const type = (feature.get('type') as string | undefined) ?? '';
            const color = (feature.get('color') as string | undefined) ?? '';
            const alpha = (feature.get('alpha') as number | undefined) ?? 1;
            feature.set('baseStyle', this.styles.createFeatureStyle(type, 'POLYLINE', color, '', '', alpha, channel));
            feature.set('channel', channel);
            this.markerRegistry.set(key, feature);
        }
    }

    private refreshAllSources(): void {
        for (const state of this.channelLayers.values()) {
            state.source.changed();
        }
        this.previewSource.changed();
    }

    private loadMarkerChannels(): Promise<void> {
        return requestWithTimeout(
            window.TacPhone.networking.Request({ a: 'ACE_TacPhone_Map', c: 'GetMarkerChannels' }),
            'GetMarkerChannels',
        ).then((value) => {
            if (this.destroyed) {
                return;
            }

            this.channels = parseMarkerChannels(value);
        }).catch((error: unknown) => {
            console.error('Failed to load marker channels', error);
            this.channels = parseMarkerChannels(null);
        });
    }

    private loadMarkerConfig(): Promise<void> {
        return requestWithTimeout(
            window.TacPhone.networking.Request({a: "ACE_TacPhone_Map", c: "GetMarkerTypes"}),
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
            window.TacPhone.networking.Request({a: "ACE_TacPhone_Map", c: "GetAllMarkers"}),
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

        // Drop in-flight move updates; the markers are gone with the layer.
        this.movingMarkers.forEach((move) => {
            if (move.pendingTimer !== null) {
                window.clearTimeout(move.pendingTimer);
            }
        });
        this.movingMarkers.clear();
        this.editingPolylineName = null;

        this.pendingMarkerOperations = [];
        this.markerTextures.clear();
        this.markerRegistry.clear();

        this.measurementLayer.destroy();
        this.map.removeLayer(this.measurementLayer.layer);

        this.hideMarkerPreview();
        this.map.removeLayer(this.previewLayer);
        this.previewSource.clear();

        for (const state of this.channelLayers.values()) {
            this.map.removeLayer(state.layer);
            state.source.clear();
        }
        this.channelLayers.clear();

        // Nobody may wait forever for the snapshot of a destroyed layer.
        this.resolveMarkersLoaded();
        this.resolveChannelsReady();

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

    /**
     * Resolves once the initial marker snapshot has been applied, or after it
     * failed/timed out, or when this manager was destroyed. Never rejects.
     */
    public whenMarkersLoaded(): Promise<void> {
        return this.markersLoaded;
    }

    /** True when a marker with this name is currently on the layer. */
    public hasMarker(name: string): boolean {
        if (this.destroyed || typeof name !== 'string' || name === '') {
            return false;
        }

        return this.getRegisteredFeature(name) !== null;
    }

    /**
     * Data of an icon or polyline marker for sharing with another app
     * (Messenger), or null when the marker does not exist. Polyline text is
     * data-only; the measurement tag is never exposed as a label.
     */
    public getMarkerChatData(name: string): MarkerChatData | null {
        if (this.destroyed || typeof name !== 'string' || name === '') {
            return null;
        }

        const feature = this.getRegisteredFeature(name);
        const geometry = feature?.getGeometry();

        if (!feature || !(geometry instanceof Point || geometry instanceof LineString)) {
            return null;
        }

        const type = (feature.get('type') as string | undefined) ?? '';
        const color = (feature.get('color') as string | undefined) ?? '';
        const rawText = (feature.get('label') as string | undefined) ?? '';
        const isPolyline = geometry instanceof LineString;
        // Measurement tags are internal; do not show them on a shared card.
        const text = isPolyline && isPolylineMeasurementsText(rawText) ? '' : rawText;
        const label = text || (isPolyline ? 'Polyline' : '');
        const typeResolved = this.markerTypes.get(type);
        let position: [number, number] | null = null;

        if (geometry instanceof Point) {
            const coordinates = geometry.getCoordinates();
            if (isFinitePosition(coordinates)) {
                position = [coordinates[0], coordinates[1]];
            }
        } else {
            const extent = geometry.getExtent();
            if (extent.every((coordinate) => Number.isFinite(coordinate))) {
                position = [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
            }
        }

        if (!position) {
            return null;
        }

        return {
            name,
            type,
            color,
            text,
            label,
            position,
            typeIcon: typeResolved?.icon ?? '',
            resolvedColor: this.resolveColorFor(type, color),
        };
    }

    /**
     * Flies to a marker through the supplied `flyTo` callback when it exists.
     * Returns false for an unknown marker, so callers can report a deleted one.
     * A polyline calls back with its whole bounding box; a point calls back
     * without a box (the caller chooses a focus area).
     */
    public focusMarker(
        name: string,
        flyTo: (position: [number, number], bbox?: [number, number, number, number]) => void,
    ): boolean {
        if (this.destroyed || typeof name !== 'string' || name === '') {
            return false;
        }

        const geometry = this.getRegisteredFeature(name)?.getGeometry();
        let position: [number, number] | null = null;
        let bbox: [number, number, number, number] | undefined;

        if (geometry instanceof Point) {
            const coordinates = geometry.getCoordinates();
            if (isFinitePosition(coordinates)) {
                position = [coordinates[0], coordinates[1]];
            }
        } else if (geometry instanceof LineString) {
            const extent = geometry.getExtent();
            if (extent.every((coordinate) => Number.isFinite(coordinate))) {
                position = [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
                bbox = [extent[0], extent[1], extent[2], extent[3]];
            }
        }

        if (!position) {
            return false;
        }

        flyTo(position, bbox);
        return true;
    }

    /** Resolves a CfgMarkerColors class name, falling back to the type color. */
    public resolveColorFor(type: string, colorClassName: string): string {
        return resolveMarkerColor(
            colorClassName,
            this.markerColors.get(colorClassName)?.color,
            this.markerTypes.get(type)?.color,
        );
    }

    public getMarkerTypes(): MarkerType[] {
        return Array.from(this.markerTypes.values());
    }

    public getMarkerColors(): MarkerColor[] {
        return Array.from(this.markerColors.values());
    }

    /**
     * Debug-only snapshot of the rendered channel layers and markers.
     *
     * Canvas styling cannot be asserted from the DOM, so the browser tests read
     * the channel dimming and resolved colors from here instead of inspecting
     * pixels. The values mirror what `dynamicIconStyleFunction` and
     * `createFeatureStyle` apply.
     */
    public getDebugSnapshot(): Omit<MapDebugState, 'polyline'> {
        const channels: MapDebugChannel[] = [];

        for (const state of this.channelLayers.values()) {
            channels.push({
                id: state.channel.id,
                label: state.channel.label,
                available: state.channel.mapMarkersEnabled,
                visible: state.layer.getVisible(),
            });
        }

        channels.sort((left, right) => left.id - right.id);

        const markers: MapDebugMarker[] = [];
        const seen = new Set<Feature<Point | LineString>>();

        for (const feature of this.markerRegistry.values()) {
            if (seen.has(feature)) {
                continue;
            }
            seen.add(feature);

            const geometry = feature.getGeometry();
            const channel = this.resolveChannel(feature.get('channel'));
            const type = (feature.get('type') as string | undefined) ?? '';
            const color = (feature.get('color') as string | undefined) ?? '';
            const rawAlpha = feature.get('alpha');
            const alpha = Number.isFinite(rawAlpha) ? Number(rawAlpha) : 1;
            const dim = this.getChannelDim(channel);
            const resolvedColor = this.resolveColorFor(type, color);
            const baseStyle = feature.get('baseStyle') as Style | undefined;
            const iconOpacity = baseStyle?.getImage()?.getOpacity() ?? 1;
            let geometryKind: MapDebugMarker['geometry'] = 'Other';
            let position: [number, number] | null = null;

            if (geometry instanceof Point) {
                geometryKind = 'Point';
                const coordinates = geometry.getCoordinates();
                if (isFinitePosition(coordinates)) {
                    position = [coordinates[0], coordinates[1]];
                }
            } else if (geometry instanceof LineString) {
                geometryKind = 'LineString';
                const first = geometry.getCoordinates()[0];
                if (isFinitePosition(first)) {
                    position = [first[0], first[1]];
                }
            }

            markers.push({
                name: (feature.get('id') as string | undefined) ?? '',
                channel,
                type,
                color,
                shape: (feature.get('shape') as string | undefined) ?? '',
                alpha,
                layerVisible: this.channelLayers.get(channel)?.layer.getVisible() ?? false,
                dim,
                opacity: alpha * dim * colorAlpha(resolvedColor),
                iconOpacity,
                resolvedColor,
                labelColor: markerLabelColor(resolvedColor),
                strokeColor: geometryKind === 'LineString'
                    ? applyAlphaToColor(resolvedColor, alpha * dim)
                    : '',
                geometry: geometryKind,
                position,
            });
        }

        const previewStyle = this.previewFeature?.get('baseStyle') as Style | undefined;
        const previewState = previewStyle?.getImage()?.getImageState();

        return {
            multiplayer: this.isMultiplayerFlag,
            activeChannel: this.activeChannelId,
            channels,
            markers,
            preview: {
                visible: this.previewFeature !== null,
                color: (this.previewFeature?.get('color') as string | undefined) ?? '',
                iconState: previewState ?? -1,
                iconLoaded: previewState === ImageState.LOADED,
                iconOpacity: previewStyle?.getImage()?.getOpacity() ?? 1,
            },
        };
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

        const texturePromise = window.TacPhone.networking.LoadGameFileTexture(iconPath, 64).then((iconData) => {
            // The manager may have been destroyed while the texture was loading.
            if (!this.destroyed) {
                this.markerTextures.set(iconPath, iconData); // Replace promise with real data, so that others won't wait on it
                this.refreshAllSources(); // Notify every layer/feature that needs the new icon
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

    private markerKey(name: string, channel: number): string {
        return `${channel ?? 0}:${name}`;
    }

    private getMarkerShadow(type: string): boolean {
        return (this.markerTypes.get(type)?.shadow ?? 0) !== 0;
    }

    /**
     * Finds the registered feature for a marker name. Registry keys are
     * channel-prefixed, and the game addresses markers by name only.
     */
    private getRegisteredFeature(name: string): Feature<Point | LineString> | null {
        const suffix = `:${name}`;

        for (const [key, feature] of this.markerRegistry) {
            if (key === name || key.endsWith(suffix)) {
                return feature;
            }
        }

        return null;
    }

    private isRegisteredFeature(feature: FeatureLike): boolean {
        for (const registered of this.markerRegistry.values()) {
            if (registered === feature) {
                return true;
            }
        }

        return false;
    }

    /**
     * Returns the marker name of a registered marker feature, or null when the
     * feature does not belong to this layer.
     */
    public getMarkerName(feature: FeatureLike): string | null {
        if (this.destroyed) {
            return null;
        }

        const name = feature.get('id');
        if (typeof name !== 'string' || name === '') {
            return null;
        }

        return this.isRegisteredFeature(feature) ? name : null;
    }

    /**
     * Returns the marker name of a feature the user may edit, or null when the
     * feature is not a registered point marker created by a player.
     */
    public getEditableMarkerName(feature: FeatureLike): string | null {
        const name = this.getMarkerName(feature);

        if (!isEditableMarkerName(name) || !(feature.getGeometry() instanceof Point)) {
            return null;
        }

        return name;
    }

    /**
     * Returns the data needed to pre-fill the edit dialog for a player marker.
     */
    public getMarkerData(name: string): MarkerProperties | null {
        if (this.destroyed || !isEditableMarkerName(name)) {
            return null;
        }

        const feature = this.getRegisteredFeature(name);
        const geometry = feature?.getGeometry();
        if (!feature || !(geometry instanceof Point)) {
            return null;
        }

        const coordinates = geometry.getCoordinates();
        const size = parseMarkerSize(feature.get('size'));
        return {
            name,
            label: (feature.get('label') as string | undefined) ?? '',
            type: (feature.get('type') as string | undefined) ?? '',
            color: (feature.get('color') as string | undefined) ?? '',
            position: [coordinates[0], coordinates[1]],
            dir: (feature.get('dir') as number | undefined) ?? 0,
            size,
            channel: this.resolveChannel(feature.get('channel')),
        };
    }

    /**
     * Everything the polyline editor needs to pre-fill itself. Returns null for
     * point markers and for anything the player may not edit.
     */
    public getPolylineData(name: string): {
        points: Array<[number, number]>;
        color: string;
        channel: number;
        /** True when the marker carries the measurement tag in its text. */
        measurements: boolean;
    } | null {
        if (this.destroyed || !isEditableMarkerName(name)) {
            return null;
        }

        const feature = this.getRegisteredFeature(name);
        const geometry = feature?.getGeometry();
        if (!feature || !(geometry instanceof LineString)) {
            return null;
        }

        const points: Array<[number, number]> = [];
        for (const coordinate of geometry.getCoordinates()) {
            points.push([coordinate[0], coordinate[1]]);
        }

        return {
            points,
            color: (feature.get('color') as string | undefined) ?? '',
            channel: this.resolveChannel(feature.get('channel')),
            measurements: isPolylineMeasurementsText(
                (feature.get('label') as string | undefined) ?? '',
            ),
        };
    }

    /**
     * Marks one polyline as being edited, so incoming upserts do not overwrite
     * its local geometry. Pass null when editing ends.
     */
    public setEditingPolyline(name: string | null): void {
        this.editingPolylineName = name;
    }

    /** Local geometry of a marker: every vertex for a line, its point otherwise. */
    public getMarkerCoordinates(name: string): Array<[number, number]> | null {
        const feature = this.getRegisteredFeature(name);
        const geometry = feature?.getGeometry();
        if (!geometry) {
            return null;
        }

        if (geometry instanceof Point) {
            const position = geometry.getCoordinates();
            return [[position[0], position[1]]];
        }

        if (geometry instanceof LineString) {
            return geometry.getCoordinates().map(
                (coordinate): [number, number] => [coordinate[0], coordinate[1]],
            );
        }

        return null;
    }

    /**
     * Applies moved polyline vertices locally, without talking to the game.
     * The measurement overlay follows, so the labels match the new geometry.
     */
    public applyPolylineGeometry(name: string, points: ReadonlyArray<readonly [number, number]>): boolean {
        if (this.destroyed) {
            return false;
        }

        const feature = this.getRegisteredFeature(name);
        const geometry = feature?.getGeometry();
        if (!feature || !(geometry instanceof LineString)) {
            return false;
        }

        const coordinates = points.map(
            ([x, y]): [number, number] => [x, y],
        );
        if (coordinates.length < 2) {
            return false;
        }

        geometry.setCoordinates(coordinates);

        const channel = this.resolveChannel(feature.get('channel'));
        if (isPolylineMeasurementsText((feature.get('label') as string | undefined) ?? '')) {
            this.measurementLayer.upsert(name, channel, coordinates);
        } else {
            this.measurementLayer.remove(name);
        }

        this.channelLayers.get(channel)?.source.changed();
        return true;
    }

    /**
     * Applies edited polyline vertices locally and sends them to the game.
     * Rejects when the marker is not a local polyline or the request fails, so
     * the caller can restore the previous points.
     */
    public async updatePolylineData(name: string, points: ReadonlyArray<readonly [number, number]>): Promise<void> {
        if (this.destroyed || !isEditableMarkerName(name)) {
            throw new Error('Only player-created markers can be edited');
        }

        if (!this.applyPolylineGeometry(name, points)) {
            throw new Error('The marker is not an editable polyline');
        }

        const flat: number[] = [];
        for (const [x, y] of points) {
            flat.push(x, y);
        }

        await updateMarkerRequest(name, { polyline: flat });
    }

    /**
     * Registers a marker as being dragged. Until `endMarkerMove` is called the
     * local geometry wins over game updates, and the marker renders elevated.
     */
    public beginMarkerMove(name: string): boolean {
        if (this.destroyed || !isEditableMarkerName(name)) {
            return false;
        }

        const feature = this.getRegisteredFeature(name);
        if (!feature || !(feature.getGeometry() instanceof Point)) {
            return false;
        }

        this.movingMarkers.set(name, {
            lastSentAt: 0,
            lastSentPosition: null,
            pendingTimer: null,
        });
        feature.set('elevated', true);
        return true;
    }

    /**
     * Applies a drag position locally and forwards it to the game, throttled to
     * one request per marker every `MARKER_MOVE_THROTTLE_MS`.
     */
    public moveMarker(name: string, position: [number, number]): void {
        const move = this.movingMarkers.get(name);
        if (this.destroyed || !move) {
            return;
        }

        const feature = this.getRegisteredFeature(name);
        if (!feature) {
            return;
        }

        const geometry = feature.getGeometry();
        if (!(geometry instanceof Point)) {
            return;
        }

        // Local geometry is authoritative while dragging, so the icon follows
        // the pointer without waiting for the game.
        geometry.setCoordinates(position);

        const now = Date.now();

        if (now - move.lastSentAt >= MARKER_MOVE_THROTTLE_MS) {
            this.clearPendingMoveTimer(move);
            this.sendMarkerPosition(name, move, position, now);
            return;
        }

        // Coalesce everything in between into a single trailing update that
        // carries the newest position.
        this.clearPendingMoveTimer(move);
        move.pendingTimer = window.setTimeout(() => {
            move.pendingTimer = null;

            if (this.destroyed || !this.movingMarkers.has(name)) {
                return;
            }

            const sentAt = Date.now();
            this.sendMarkerPosition(name, move, position, sentAt);
        }, MARKER_MOVE_THROTTLE_MS - (now - move.lastSentAt));
    }

    /**
     * Ends a drag, flushing the final position to the game. Safe to call for a
     * marker that was deleted meanwhile.
     */
    public endMarkerMove(name: string, position?: [number, number]): void {
        if (this.destroyed) {
            return;
        }

        const move = this.movingMarkers.get(name);
        const feature = this.getRegisteredFeature(name);
        const geometry = feature?.getGeometry();
        const point = geometry instanceof Point ? geometry : null;

        if (position && point) {
            point.setCoordinates(position);
        }

        if (move) {
            this.clearPendingMoveTimer(move);

            if (point && isEditableMarkerName(name) && (position !== undefined || move.lastSentPosition !== null)) {
                // Flush the final position right away instead of waiting for
                // the throttle window, so the game ends up on the released spot.
                const finalPosition: [number, number] = position ?? point.getCoordinates() as [number, number];
                this.sendMarkerPosition(name, move, finalPosition, Date.now());
            }
        }

        feature?.set('elevated', false);
        this.movingMarkers.delete(name);
    }

    /**
     * Deletes a player-created marker locally and in the game.
     */
    public deleteMarker(name: string): void {
        if (this.destroyed || !isEditableMarkerName(name) || !this.getRegisteredFeature(name)) {
            return;
        }

        // Remove it right away; the round trip must not delay the UI.
        this.removeMarkerFeature(name);

        // A deleted marker cannot be dragged or edited any more.
        if (this.editingPolylineName === name) {
            this.editingPolylineName = null;
        }

        // A deleted marker cannot be dragged any more; drop any pending move.
        const move = this.movingMarkers.get(name);
        if (move) {
            this.clearPendingMoveTimer(move);
            this.movingMarkers.delete(name);
        }

        deleteMarkerRequest(name).catch((error: unknown) => {
            console.error('Failed to delete marker', error);
        });
    }

    /**
     * Applies edited marker properties locally and forwards them to the game.
     * Only fields present in `changes` are touched.
     */
    public updateMarkerProperties(
        name: string,
        changes: {
            label?: string;
            type?: string;
            color?: string;
            dir?: number;
            size?: number | [number, number];
            channel?: number;
        },
    ): void {
        if (this.destroyed || !isEditableMarkerName(name)) {
            return;
        }

        const feature = this.getRegisteredFeature(name);
        if (!feature || !(feature.getGeometry() instanceof Point)) {
            return;
        }

        const label = changes.label ?? (feature.get('label') as string | undefined) ?? '';
        const type = changes.type ?? (feature.get('type') as string | undefined) ?? '';
        const color = changes.color ?? (feature.get('color') as string | undefined) ?? '';
        const dir = changes.dir ?? (feature.get('dir') as number | undefined) ?? 0;
        const size = changes.size !== undefined
            ? parseMarkerSize(changes.size)
            : parseMarkerSize(feature.get('size'));
        const alpha = (feature.get('alpha') as number | undefined) ?? 1;
        const currentChannel = this.resolveChannel(feature.get('channel'));
        const channel = changes.channel !== undefined
            ? this.resolveChannel(changes.channel)
            : currentChannel;

        // Arma has no marker channel setter. Replace the marker instead: create
        // a new marker on the requested channel and delete the old one. The new
        // marker is intentionally created without a name, so the game generates
        // it with the *local* player's id instead of reusing another player's
        // id from the old marker name.
        if (channel !== currentChannel) {
            const geometry = feature.getGeometry();
            if (!(geometry instanceof Point)) {
                return;
            }

            const coordinates = geometry.getCoordinates();
            const shape = (feature.get('shape') as string | undefined) ?? 'ICON';
            const brush = (feature.get('brush') as string | undefined) ?? '';

            createMarker({
                label,
                type,
                color,
                position: [coordinates[0], coordinates[1]],
                dir,
                size,
                shape: shape as MarkerCreationData['shape'],
                brush,
                alpha,
                channel,
            }).then(() => deleteMarkerRequest(name))
                .then(() => {
                    if (!this.destroyed) {
                        this.removeMarkerFeature(name);
                    }
                })
                .catch((error: unknown) => {
                    if (!this.destroyed) {
                        console.error('Failed to replace marker after an edit', error);
                    }
                });
            return;
        }

        // Update locally first so the map reflects the edit immediately; the
        // game echoes a regular Marker.Upsert afterwards.
        feature.set('label', label);
        feature.set('type', type);
        feature.set('color', color);
        feature.set('dir', dir);
        feature.set('size', size);
        feature.set('shadow', this.getMarkerShadow(type));
        feature.set('baseStyle', this.styles.createFeatureStyle(type, 'ICON', color, '', '', alpha, channel));
        const resolvedColor = this.resolveColorFor(type, color);
        feature.set('resolvedColor', resolvedColor);
        feature.set('colorAlpha', colorAlpha(resolvedColor));
        this.channelLayers.get(channel)?.source.changed();

        const { channel: _ignoredChannel, ...updateChanges } = changes;
        updateMarkerRequest(name, updateChanges).catch((error: unknown) => {
            if (this.destroyed) {
                return;
            }

            console.error('Failed to edit marker', error);
        });
    }

    /**
     * Shows or updates the live marker preview at the position the create
     * dialog will use. The preview is a normal feature on its own layer, so it
     * follows the same icon/type/color/direction/scale styling.
     */
    public showMarkerPreview(draft: MarkerPreviewDraft): void {
        if (this.destroyed) {
            return;
        }

        const channel = this.resolveChannel(draft.channel);
        const size = parseMarkerSize(draft.size);
        const revision = ++this.previewStyleRevision;

        let feature = this.previewFeature;
        if (!feature) {
            feature = new Feature<Point>({
                geometry: new Point(draft.position),
                id: '__preview',
            });
            this.previewFeature = feature;
            this.previewSource.addFeature(feature);
        } else {
            const geometry = feature.getGeometry();
            if (geometry instanceof Point) {
                geometry.setCoordinates(draft.position);
            }
        }

        feature.set('label', draft.label);
        feature.set('dir', draft.dir);
        feature.set('alpha', 1);
        feature.set('size', size);
        feature.set('shadow', this.getMarkerShadow(draft.type));
        feature.set('type', draft.type);
        feature.set('color', draft.color);
        feature.set('channel', channel);
        const resolvedColor = this.resolveColorFor(draft.type, draft.color);
        feature.set('resolvedColor', resolvedColor);
        feature.set('colorAlpha', colorAlpha(resolvedColor));

        // Dragging the custom color picker creates a new tinted icon for every
        // step, and OpenLayers only draws an icon once its image finished
        // decoding. Swapping the style right away would blank the preview on
        // every step (the "blinking" marker). Keep the previous, already decoded
        // style visible and swap to the new one when its icon is ready.
        const nextStyle = this.styles.createFeatureStyle(draft.type, 'ICON', draft.color, '', '', 1, channel);
        const applyStyle = (): void => {
            if (this.destroyed || revision !== this.previewStyleRevision || this.previewFeature !== feature) {
                return;
            }

            feature.set('baseStyle', nextStyle);
            this.previewSource.changed();
        };

        const styleImage = nextStyle.getImage();
        const imageState = styleImage?.getImageState();

        if (!feature.get('baseStyle')
            || imageState === undefined
            || imageState === ImageState.LOADED
            || imageState === ImageState.ERROR) {
            applyStyle();
        } else if (styleImage instanceof Icon) {
            const onImageChange = (): void => {
                const state = styleImage.getImageState();
                if (state === ImageState.IDLE || state === ImageState.LOADING) {
                    return;
                }

                styleImage.unlistenImageChange(onImageChange);
                applyStyle();
            };

            styleImage.listenImageChange(onImageChange);
            // The style is not attached to the feature yet, so the renderer will
            // not call load() for it. Start the decode explicitly.
            styleImage.load();
        }

        this.previewSource.changed();
    }

    public updateMarkerPreview(draft: MarkerPreviewDraft): void {
        this.showMarkerPreview(draft);
    }

    public hideMarkerPreview(): void {
        this.previewStyleRevision++;

        if (!this.previewFeature) {
            return;
        }

        this.previewSource.removeFeature(this.previewFeature);
        this.previewFeature = null;
        this.previewSource.changed();
    }

    private clearPendingMoveTimer(move: MarkerMoveState): void {
        if (move.pendingTimer === null) {
            return;
        }

        window.clearTimeout(move.pendingTimer);
        move.pendingTimer = null;
    }

    private sendMarkerPosition(
        name: string,
        move: MarkerMoveState,
        position: [number, number],
        sentAt: number,
    ): void {
        const lastPosition = move.lastSentPosition;
        if (lastPosition && lastPosition[0] === position[0] && lastPosition[1] === position[1]) {
            return;
        }

        move.lastSentAt = sentAt;
        move.lastSentPosition = [position[0], position[1]];

        void updateMarkerPosition(name, position).catch((error: unknown) => {
            if (this.destroyed) {
                return;
            }

            console.error('Failed to move marker', error);
        });
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
                    notifyMarkerUpsert(operation.marker, this.playerId);
                } else {
                    this.removeMarkerFeature(operation.name);
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
        notifyMarkerUpsert(data, this.playerId);
    }

    private applyMarkerProperties(
        feature: Feature<Point | LineString>,
        props: {
            name: string;
            type: string;
            color: string;
            dir: number;
            alpha: number;
            brush: string;
            size: [number, number];
            text: string;
            shape: string;
            shadow: boolean;
            channel: number;
            baseStyle: Style;
        },
    ): void {
        // Every property the game sends is kept on the feature. Shape/brush
        // rendering (rectangle/ellipse pattern textures) is deliberately
        // deferred, but the values are stored so that renderer can use them.
        feature.set('id', props.name);
        feature.set('label', props.text);
        feature.set('type', props.type);
        feature.set('color', props.color);
        feature.set('dir', props.dir);
        feature.set('alpha', props.alpha);
        feature.set('brush', props.brush);
        feature.set('size', props.size);
        feature.set('shape', props.shape);
        feature.set('shadow', props.shadow);
        feature.set('channel', props.channel);
        feature.set('baseStyle', props.baseStyle);
        // The resolved CSS color drives the label text color; storing it here
        // keeps the style function independent of the OpenLayers Icon color type.
        const resolvedColor = this.resolveColorFor(props.type, props.color);
        feature.set('resolvedColor', resolvedColor);
        feature.set('colorAlpha', colorAlpha(resolvedColor));
    }

    private applyUpsert(data: MarkerUpdate): void {
        const [name, type, color, dir, pos, text, shape, alpha, brush, size, channel, polyline] = data;
        const effectiveChannel = this.resolveChannel(channel);
        const registryKey = this.markerKey(name, effectiveChannel);

        // While the user drags this marker, the local geometry wins. Every
        // other field is still applied; only the position/geometry is kept.
        const isMoving = this.movingMarkers.has(name);
        // The polyline editor owns the geometry of its marker for the same
        // reason: an incoming update must not make the vertices jump.
        const isEditing = this.editingPolylineName === name;

        const sizeSplit = parseMarkerSize(size);
        const featureStyle = this.styles.createFeatureStyle(type, shape, color, brush, size, alpha, effectiveChannel);
        const shadow = this.getMarkerShadow(type);
        const featureProps = {
            name,
            type,
            color,
            dir,
            alpha,
            brush,
            size: sizeSplit,
            text,
            shape,
            shadow,
            channel: effectiveChannel,
            baseStyle: featureStyle,
        };

        // Parse polyline if present. Malformed geometry is ignored instead of
        // handing NaN coordinates to OpenLayers.
        const coordinates = parsePolylineCoordinates(polyline);
        if (coordinates) {
            const state = this.ensureChannelLayer(effectiveChannel);
            let existingFeature = this.getRegisteredFeature(name);

            // A channel change means the feature belongs in a different source.
            if (existingFeature && this.resolveChannel(existingFeature.get('channel')) !== effectiveChannel) {
                this.removeFeatureFromLayer(existingFeature);
                this.markerRegistry.delete(this.findRegistryKey(existingFeature));
                existingFeature = null;
            }

            if (existingFeature) {
                const geometry = existingFeature.getGeometry();
                if (geometry instanceof LineString) {
                    if (!isMoving && !isEditing) {
                        geometry.setCoordinates(coordinates);
                    }
                } else if (isMoving || isEditing) {
                    // Do not swap the dragged/edited point for the incoming polyline.
                    this.applyMarkerProperties(existingFeature, featureProps);
                    return;
                } else {
                    // Replace point with polyline.
                    this.removeFeatureFromLayer(existingFeature);
                    this.markerRegistry.delete(this.findRegistryKey(existingFeature));
                    existingFeature = null;
                }
            }

            if (existingFeature) {
                this.applyMarkerProperties(existingFeature, featureProps);
                state.source.changed();
            } else {
                const newFeature = new Feature({
                    geometry: new LineString(coordinates),
                    id: name,
                    label: text,
                });
                this.applyMarkerProperties(newFeature, featureProps);
                state.source.addFeature(newFeature);
                this.markerRegistry.set(registryKey, newFeature);
            }

            if (isPolylineMeasurementsText(text)) {
                // Keep the overlay in step with the geometry the editor owns.
                if (!isEditing) {
                    this.measurementLayer.upsert(
                        name,
                        effectiveChannel,
                        coordinates as Array<[number, number]>,
                    );
                }
            } else {
                this.measurementLayer.remove(name);
            }
            return;
        }

        if (!isFinitePosition(pos)) {
            console.warn(`Skipping marker "${name}" with an invalid position.`);
            return;
        }

        const state = this.ensureChannelLayer(effectiveChannel);
        let existingFeature = this.getRegisteredFeature(name);

        if (existingFeature && this.resolveChannel(existingFeature.get('channel')) !== effectiveChannel) {
            this.removeFeatureFromLayer(existingFeature);
            this.markerRegistry.delete(this.findRegistryKey(existingFeature));
            existingFeature = null;
        }

        if (existingFeature) {
            const geometry = existingFeature.getGeometry();
            if (geometry instanceof Point) {
                if (!isMoving) {
                    geometry.setCoordinates(pos);
                }
            } else if (geometry instanceof LineString && !isMoving) {
                // Switching from polyline to point.
                this.removeFeatureFromLayer(existingFeature);
                this.markerRegistry.delete(this.findRegistryKey(existingFeature));
                existingFeature = null;
            }
        }

        if (existingFeature) {
            this.applyMarkerProperties(existingFeature, featureProps);
            state.source.changed();
        } else {
            const newFeature = new Feature({
                geometry: new Point(pos),
                id: name,
                label: text,
            });
            this.applyMarkerProperties(newFeature, featureProps);
            state.source.addFeature(newFeature);
            this.markerRegistry.set(registryKey, newFeature);
        }

        this.measurementLayer.remove(name);
    }

    private findRegistryKey(feature: Feature<Point | LineString>): string {
        for (const [key, registered] of this.markerRegistry) {
            if (registered === feature) {
                return key;
            }
        }

        return '';
    }

    private removeFeatureFromLayer(feature: Feature<Point | LineString>): void {
        const channel = this.resolveChannel(feature.get('channel'));
        this.channelLayers.get(channel)?.source.removeFeature(feature);
    }

    private removeMarkerFeature(name: string): void {
        const suffix = `:${name}`;
        const channelsToReconcile = new Set<number>();

        // The game sends deletes by name only, so remove every channel entry
        // with that name. Marker names are normally unique anyway.
        [...this.markerRegistry.keys()].forEach((key) => {
            if (key !== name && !key.endsWith(suffix)) {
                return;
            }

            const feature = this.markerRegistry.get(key);
            if (feature) {
                channelsToReconcile.add(this.resolveChannel(feature.get('channel')));
                this.removeFeatureFromLayer(feature);
                this.markerRegistry.delete(key);
            }
        });

        this.measurementLayer.remove(name);
        channelsToReconcile.forEach((channel) => this.removeChannelLayerIfEmpty(channel));
    }

    /**
     * Deletes a marker when it leaves or disconnects. This is the local-only
     * path: a game-pushed delete must never be echoed back to the game.
     */
    public handleDelete(id: string): void {
        if (this.destroyed) {
            return;
        }

        if (!this.initialMarkersLoaded) {
            this.queuePendingMarkerOperation({ kind: 'delete', name: id });
            return;
        }

        this.removeMarkerFeature(id);
    }

    /**
     * Clear all markers at once
     */
    public clearAll(): void {
        if (this.destroyed) {
            return;
        }

        for (const [channel, state] of this.channelLayers) {
            state.source.clear();
            if (!this.isMultiplayerFlag || ALWAYS_VISIBLE_CHANNELS.has(channel)) {
                continue;
            }

            this.map.removeLayer(state.layer);
            this.channelLayers.delete(channel);
        }

        this.markerRegistry.clear();
        this.measurementLayer.clear();
        this.editingPolylineName = null;
        this.hideMarkerPreview();
    }
}