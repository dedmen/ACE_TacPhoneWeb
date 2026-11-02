// Debug-only hooks for the browser test suite.
//
// Canvas-rendered values (the marker label text color) cannot be asserted from
// the DOM, so the pure helpers that produce them are exposed on the page. The
// hook is installed only in the Vite dev server or when the game reports debug
// mode; release pages do not have it.

import type {
    AdvisorPrompt,
    GpsStatus,
    RouteLegKind,
    TravelMode,
} from '../MapGps/GpsTypes';
import {
    DEFAULT_MARKER_COLOR,
    MAX_MARKER_TEXT_LENGTH,
    MIN_MARKER_COLOR_ALPHA,
    clampMarkerAlpha,
    clampMarkerText,
    isBlackMarkerColor,
    isDefaultMarkerColor,
    markerColorToCss,
    markerColorToHex,
    markerColorToOpaqueCss,
    markerLabelColor,
    parseMarkerColor,
    resolveMarkerColor,
    rgbToMarkerColor,
    hexToMarkerColor,
} from './MarkerColorUtils';

/** One rendered marker as the browser tests see it. */
export interface MapDebugMarker {
    name: string;
    /** Marker channel id. */
    channel: number;
    type: string;
    /** Color as received from the game: a CfgMarkerColors class or `#(r,g,b,a)`. */
    color: string;
    shape: string;
    /** Marker alpha from the game. */
    alpha: number;
    /** Channel layer visibility from the layer switcher. */
    layerVisible: boolean;
    /** Channel dimming: 1 for the active channel, 0.45 for inactive channels. */
    dim: number;
    /** Effective opacity: `alpha * dim`, as used for the icon and the polyline stroke. */
    opacity: number;
    /** Opacity actually set on the rendered icon style (includes color alpha). */
    iconOpacity: number;
    /** Resolved CSS color, including custom `#(r,g,b,a)` colors. */
    resolvedColor: string;
    /** Text color used for the marker label. */
    labelColor: string;
    /** Polyline stroke color including alpha, or '' for points. */
    strokeColor: string;
    geometry: 'Point' | 'LineString' | 'Other';
    position: [number, number] | null;
}

export interface MapDebugChannel {
    id: number;
    label: string;
    available: boolean;
    visible: boolean;
}

export interface MapDebugPolylineState {
    isActive: boolean;
    color: string;
    vertexCount: number;
    clickPerPoint: boolean;
    /** True while the vertices of an existing polyline are being edited. */
    isEditing: boolean;
    /** Marker name of the polyline being edited, or '' when not editing. */
    editingName: string;
    /** Flat edit-preview coordinates: [x1, y1, x2, y2, ...]. */
    points: number[];
    /** CSS color of the in-progress preview line. */
    previewLineColor: string;
    /** CSS color of the preview halo; its alpha must match the line. */
    previewHaloColor: string;
}

/** One terrain tile layer's load counters (debug tests only). */
export interface MapViewTileStats {
    name: string;
    started: number;
    finished: number;
    errored: number;
    loading: number;
}

/** Temporary fly-to highlight overlay state. */
export interface MapHighlightState {
    active: boolean;
    kind: 'box' | 'circle';
    bbox: [number, number, number, number] | null;
}

/** Terrain view readiness and tile loading, used to wait for a fully drawn map. */
export interface MapViewDebugState {
    ready: boolean;
    tiles: MapViewTileStats[];
    started: number;
    finished: number;
    errored: number;
    loading: number;
    /** Milliseconds since the last tile start/end/error. */
    quietForMs: number;
    /** True once at least one tile started and no tile is still loading. */
    settled: boolean;
    /** Active fly-to highlight, or null when none is shown. */
    highlight: MapHighlightState | null;
}

export interface MapDebugState {
    multiplayer: boolean;
    activeChannel: number;
    channels: MapDebugChannel[];
    markers: MapDebugMarker[];
    polyline: MapDebugPolylineState;
    /** Live create-dialog preview; used to ensure the icon never blanks. */
    preview: MapDebugPreviewState;
}

export interface MapDebugPreviewState {
    visible: boolean;
    /** Marker color value stored on the preview feature. */
    color: string;
    /** OpenLayers image state of the style currently drawn (2 = loaded). */
    iconState: number;
    iconLoaded: boolean;
    /** Opacity applied to the preview icon, including the custom color alpha. */
    iconOpacity: number;
}

/** One GPS vector layer as the browser tests see it. */
export interface MapGpsLayerDebugState {
    features: number;
    /** Dash pattern of the first stroke, empty when the line is solid. */
    lineDash: number[];
    /** Stroke colors of the rendered features, as CSS strings. */
    colors: string[];
}

/** GPS layer state: feature counts and the styles actually drawn. */
export interface MapGpsLayersDebugState {
    route: MapGpsLayerDebugState;
    shared: MapGpsLayerDebugState;
    advisor: MapGpsLayerDebugState;
    waypoints: { features: number };
    /** `rotation` is the icon rotation in radians, as OpenLayers stores it. */
    playerIcon: { visible: boolean; rotation: number };
}

/** One route leg as the browser tests see it. */
export interface MapGpsLegDebugState {
    mode: TravelMode;
    kind: RouteLegKind;
    distance: number;
    eta: number;
    pointCount: number;
    source?: string;
}

/** Live GPS module state for the browser tests. */
export interface MapGpsDebugState {
    hasFix: boolean;
    heading: number | null;
    position: [number, number] | null;
    speed: number;
    mode: TravelMode;
    detectedMode: TravelMode;
    waterCapable: boolean;
    planning: boolean;
    navigating: boolean;
    calculating: boolean;
    rotating: boolean;
    mapRotation: number;
    turn: 'left' | 'right' | 'straight' | null;
    turnDistance: number | null;
    offRoute: boolean;
    stale: boolean;
    arrived: boolean;
    waypoints: Array<[number, number]>;
    route: null | {
        source: 'planned' | 'shared';
        distance: number;
        eta: number | null;
        remaining: number;
        remainingEta: number | null;
        walkDistance: number;
        legs: MapGpsLegDebugState[];
    };
    shared: null | {
        author: string;
        mode: TravelMode;
        distance: number;
        eta: number | null;
        waypointCount: number;
        walkDistance: number;
        label?: string;
    };
    advisor: AdvisorPrompt | null;
    status: GpsStatus | null;
    /** Debug counters, for determinism assertions. */
    fixCount: number;
    vehicleChangesApplied: number;
    /** Auto-repaths that replaced the route after a deviation. */
    repathCount: number;
    /** False while `setLiveUpdates(false)` suppresses game pushes. */
    liveUpdates: boolean;
    road: { polylines: number; nodes: number; segments: number } | null;
    heights: {
        lru: number;
        peaks: number;
        ring: number;
        coarseRequests: number;
        fineRequests: number;
    };
    /** Debug-only route overlay state. */
    debug: {
        enabled: boolean;
        overlay: 'none' | 'cost' | 'height' | 'both';
        alpha: number;
        hasGrid: boolean;
        costLayer: boolean;
        heightLayer: boolean;
        slopeInfluence: boolean;
    };
    layers: MapGpsLayersDebugState;
}

/** Implemented by GpsModule. Everything returns plain JSON-serializable values. */
export interface MapGpsTestProbe {
    getGpsDebugState(): MapGpsDebugState;
    setWaypoints(points: Array<[number, number]>): void;
    addWaypoint(point: [number, number]): void;
    clearWaypoints(): void;
    /** Resolves true when a route exists after planning settles. */
    calculateRoute(): Promise<boolean>;
    recalculate(): Promise<void>;
    startNavigation(): void;
    stopNavigation(): void;
    setMode(mode: TravelMode): void;
    setPlanning(active: boolean): void;
    openSharedRoute(data: unknown): Promise<boolean>;
    startSharedRoute(): Promise<boolean>;
    discardSharedRoute(): void;
    acceptAdvisor(): void;
    dismissAdvisor(): void;
    /** Debug only: stops `GPS.Update` pushes from changing state. */
    setLiveUpdates(enabled: boolean): void;
    /** Debug only: scans the current view for the cost/height overlay. */
    scanDebugViewport?(): Promise<boolean>;
    /** Debug only: full planner result with leg points and geometry. */
    getRouteDebugSnapshot?(): unknown;
    /** Debug only: sampled grid values at a point. */
    getDebugSampleAt?(position: [number, number]): unknown;
    /** Debug only: a nearby water-only boat destination. */
    findBoatTarget?(start: [number, number]): Promise<[number, number] | null>;
    /** Debug only: road/water/road waypoints for a water-capable route. */
    findWaterRouteWaypoints?(start: [number, number]): Promise<{
        playerStart: [number, number];
        roadStart: [number, number];
        waterPoint: [number, number];
        roadEnd: [number, number];
    } | null>;
    /** Debug only: feeds a synthetic `GPS.Update` payload through the real handler. */
    applyFix(payload: unknown): void;
    /** Debug only: applies a `GPS.VehicleChanged` payload without the debounce. */
    applyVehicle(payload: unknown): void;
    getTerrainBounds(): { width: number; height: number } | null;
    /** Viewport pixels of a world coordinate (null outside the viewport). */
    getPixel(coordinate: [number, number]): [number, number] | null;
    /** Terrain-only water lookup plus the nearest water point within `radiusM`. */
    queryWater?(
        point: [number, number],
        radiusM: number,
    ): Promise<{ water: boolean; nearestWater: [number, number] | null; hasTerrain: boolean }>;
    /** Debug/test only: nearest road nodes and a road path. */
    debugRoadQuery?(
        start: [number, number],
        goal: [number, number],
    ): {
        startNode: number | null;
        goalNode: number | null;
        startPoint: [number, number] | null;
        goalPoint: [number, number] | null;
        pathLength: number | null;
    };
}

/** Result of `gps.queryWater`; also returned when no GPS panel is mounted. */
export interface MapGpsWaterDebugState {
    water: boolean;
    nearestWater: [number, number] | null;
    hasTerrain: boolean;
}

/** Implemented by MarkerModule so the debug hook can read live map state. */
export interface MapTestManager {
    getMapDebugState(): MapDebugState;
    /** Viewport pixels of a marker's vertices, for context-menu/drag tests. */
    getMarkerPixels?(name: string): [number, number][] | null;
}

/** Implemented by Map.tsx so the debug hook can report terrain tile loading. */
export interface MapViewTestProbe {
    getMapViewDebugState(): MapViewDebugState;
}

let debugManager: MapTestManager | null = null;
let debugViewProbe: MapViewTestProbe | null = null;
let debugGpsProbe: MapGpsTestProbe | null = null;

const NO_WATER: MapGpsWaterDebugState = { water: false, nearestWater: null, hasTerrain: false };

/** Registers the mounted MarkerModule for the browser tests. */
export function registerMapTestManager(manager: MapTestManager): void {
    debugManager = manager;
}

/** Clears the registration only when `manager` is still the current one. */
export function unregisterMapTestManager(manager: MapTestManager): void {
    if (debugManager === manager) {
        debugManager = null;
    }
}

/** Registers the mounted Map panel's terrain tile probe. */
export function registerMapViewTestProbe(probe: MapViewTestProbe): void {
    debugViewProbe = probe;
}

/** Clears the view probe only when `probe` is still the current one. */
export function unregisterMapViewTestProbe(probe: MapViewTestProbe): void {
    if (debugViewProbe === probe) {
        debugViewProbe = null;
    }
}

/** Registers the mounted GPS module for the browser tests. */
export function registerGpsTestProbe(probe: MapGpsTestProbe): void {
    debugGpsProbe = probe;
}

/** Clears the GPS probe only when `probe` is still the current one. */
export function unregisterGpsTestProbe(probe: MapGpsTestProbe): void {
    if (debugGpsProbe === probe) {
        debugGpsProbe = null;
    }
}

export interface MapTestHooks {
    readonly DEFAULT_MARKER_COLOR: string;
    readonly MAX_MARKER_TEXT_LENGTH: number;
    readonly MIN_MARKER_COLOR_ALPHA: number;
    /** `resolveMarkerColor(colorClassName, colorColor, typeColor)`. */
    resolveMarkerColor: typeof resolveMarkerColor;
    /** `markerLabelColor(resolvedColor)`; the color of the marker text. */
    markerLabelColor: typeof markerLabelColor;
    isDefaultMarkerColor: typeof isDefaultMarkerColor;
    /** True when a CSS color is black; the dialog hides its duplicate default. */
    isBlackMarkerColor: typeof isBlackMarkerColor;
    /** Clamps a custom color alpha to the non-invisible minimum. */
    clampMarkerAlpha: typeof clampMarkerAlpha;
    /** Parses Arma's `#(r,g,b,a)` custom marker color. */
    parseMarkerColor: typeof parseMarkerColor;
    markerColorToCss: typeof markerColorToCss;
    markerColorToHex: typeof markerColorToHex;
    /** Strips alpha from a CSS color, for the opaque icon tint. */
    markerColorToOpaqueCss: typeof markerColorToOpaqueCss;
    rgbToMarkerColor: typeof rgbToMarkerColor;
    hexToMarkerColor: typeof hexToMarkerColor;
    clampMarkerText: typeof clampMarkerText;
    /** Live marker/channel/polyline state, or null while no Map panel is mounted. */
    getMapState: () => MapDebugState | null;
    /** Viewport pixels of a marker's vertices, or null when it is not rendered. */
    getMarkerPixels: (name: string) => [number, number][] | null;
    /** Terrain readiness and tile loading, or null while no Map panel is mounted. */
    getViewState: () => MapViewDebugState | null;
    /** Live GPS state, or null while no GPS panel is mounted. */
    getGpsDebugState: () => MapGpsDebugState | null;
    /** GPS test controls; every forwarder no-ops while no GPS panel is mounted. */
    gps: MapGpsTestControls;
}

/** Thin, no-op-when-unmounted forwarders to the mounted GPS module. */
export interface MapGpsTestControls {
    setWaypoints: (points: Array<[number, number]>) => void;
    addWaypoint: (point: [number, number]) => void;
    clearWaypoints: () => void;
    calculateRoute: () => Promise<boolean>;
    recalculate: () => Promise<void>;
    startNavigation: () => void;
    stopNavigation: () => void;
    setMode: (mode: TravelMode) => void;
    setPlanning: (active: boolean) => void;
    openSharedRoute: (data: unknown) => Promise<boolean>;
    startSharedRoute: () => Promise<boolean>;
    discardSharedRoute: () => void;
    acceptAdvisor: () => void;
    dismissAdvisor: () => void;
    setLiveUpdates: (enabled: boolean) => void;
    scanDebugViewport: () => Promise<boolean>;
    getRouteDebugSnapshot: () => unknown;
    debugSampleAt: (position: [number, number]) => unknown;
    findBoatTarget: (start: [number, number]) => Promise<[number, number] | null>;
    findWaterRouteWaypoints: (start: [number, number]) => Promise<{
        playerStart: [number, number];
        roadStart: [number, number];
        waterPoint: [number, number];
        roadEnd: [number, number];
    } | null>;
    applyFix: (payload: unknown) => void;
    applyVehicle: (payload: unknown) => void;
    getTerrainBounds: () => { width: number; height: number } | null;
    getPixel: (coordinate: [number, number]) => [number, number] | null;
    queryWater: (point: [number, number], radiusM: number) => Promise<MapGpsWaterDebugState>;
    debugRoadQuery: (start: [number, number], goal: [number, number]) => {
        startNode: number | null;
        goalNode: number | null;
        startPoint: [number, number] | null;
        goalPoint: [number, number] | null;
        pathLength: number | null;
    } | null;
}

declare global {
    interface Window {
        /** Present only in debug builds. */
        __TACPHONE_MAP_TEST__?: MapTestHooks;
    }
}

function install(): void {
    if (window.__TACPHONE_MAP_TEST__) {
        return;
    }

    window.__TACPHONE_MAP_TEST__ = {
        DEFAULT_MARKER_COLOR,
        MAX_MARKER_TEXT_LENGTH,
        MIN_MARKER_COLOR_ALPHA,
        resolveMarkerColor,
        markerLabelColor,
        isDefaultMarkerColor,
        isBlackMarkerColor,
        clampMarkerAlpha,
        parseMarkerColor,
        markerColorToCss,
        markerColorToHex,
        markerColorToOpaqueCss,
        rgbToMarkerColor,
        hexToMarkerColor,
        clampMarkerText,
        getMapState: () => debugManager?.getMapDebugState() ?? null,
        getMarkerPixels: (name: string) => debugManager?.getMarkerPixels?.(name) ?? null,
        getViewState: () => debugViewProbe?.getMapViewDebugState() ?? null,
        getGpsDebugState: () => debugGpsProbe?.getGpsDebugState() ?? null,
        gps: {
            setWaypoints: (points) => debugGpsProbe?.setWaypoints(points),
            addWaypoint: (point) => debugGpsProbe?.addWaypoint(point),
            clearWaypoints: () => debugGpsProbe?.clearWaypoints(),
            calculateRoute: () => debugGpsProbe?.calculateRoute() ?? Promise.resolve(false),
            recalculate: () => debugGpsProbe?.recalculate() ?? Promise.resolve(),
            startNavigation: () => debugGpsProbe?.startNavigation(),
            stopNavigation: () => debugGpsProbe?.stopNavigation(),
            setMode: (mode) => debugGpsProbe?.setMode(mode),
            setPlanning: (active) => debugGpsProbe?.setPlanning(active),
            openSharedRoute: (data) => debugGpsProbe?.openSharedRoute(data) ?? Promise.resolve(false),
            startSharedRoute: () => debugGpsProbe?.startSharedRoute() ?? Promise.resolve(false),
            discardSharedRoute: () => debugGpsProbe?.discardSharedRoute(),
            acceptAdvisor: () => debugGpsProbe?.acceptAdvisor(),
            dismissAdvisor: () => debugGpsProbe?.dismissAdvisor(),
            setLiveUpdates: (enabled) => debugGpsProbe?.setLiveUpdates(enabled),
            scanDebugViewport: () => debugGpsProbe?.scanDebugViewport?.() ?? Promise.resolve(false),
            getRouteDebugSnapshot: () => debugGpsProbe?.getRouteDebugSnapshot?.() ?? null,
            debugSampleAt: (position) => debugGpsProbe?.getDebugSampleAt?.(position) ?? null,
            findBoatTarget: (start) => debugGpsProbe?.findBoatTarget?.(start)
                ?? Promise.resolve(null),
            findWaterRouteWaypoints: (start) => debugGpsProbe?.findWaterRouteWaypoints?.(start)
                ?? Promise.resolve(null),
            applyFix: (payload) => debugGpsProbe?.applyFix(payload),
            applyVehicle: (payload) => debugGpsProbe?.applyVehicle(payload),
            getTerrainBounds: () => debugGpsProbe?.getTerrainBounds() ?? null,
            getPixel: (coordinate) => debugGpsProbe?.getPixel(coordinate) ?? null,
            queryWater: (point, radiusM) => debugGpsProbe?.queryWater?.(point, radiusM)
                ?? Promise.resolve(NO_WATER),
            debugRoadQuery: (start, goal) => debugGpsProbe?.debugRoadQuery?.(start, goal) ?? null,
        },
    };
}

export function installMapTestHooks(): void {
    if (window.__TACPHONE_MAP_TEST__) {
        return;
    }

    if (import.meta.env.DEV) {
        install();
        return;
    }

    // The game-side debug flag is the released-build equivalent of a debug web
    // build; it is false for normal players.
    window.TacPhone.gameInfo.whenReady()
        .then((info) => {
            if (info.debug) {
                install();
            }
        })
        .catch(() => {
            // No game info means no debug hook; nothing to do.
        });
}
