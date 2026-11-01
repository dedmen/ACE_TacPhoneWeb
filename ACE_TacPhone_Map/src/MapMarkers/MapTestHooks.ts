// Debug-only hooks for the browser test suite.
//
// Canvas-rendered values (the marker label text color) cannot be asserted from
// the DOM, so the pure helpers that produce them are exposed on the page. The
// hook is installed only in the Vite dev server or when the game reports debug
// mode; release pages do not have it.

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

/** Implemented by MarkerModule so the debug hook can read live map state. */
export interface MapTestManager {
    getMapDebugState(): MapDebugState;
}

/** Implemented by Map.tsx so the debug hook can report terrain tile loading. */
export interface MapViewTestProbe {
    getMapViewDebugState(): MapViewDebugState;
}

let debugManager: MapTestManager | null = null;
let debugViewProbe: MapViewTestProbe | null = null;

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
    /** Terrain readiness and tile loading, or null while no Map panel is mounted. */
    getViewState: () => MapViewDebugState | null;
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
        getViewState: () => debugViewProbe?.getMapViewDebugState() ?? null,
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
