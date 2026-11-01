/**
 * Map service API for inter-app communication.
 *
 * This is the app's public type surface and the entry point of
 * `tacphone-build bundle-api-types`, which emits a self-contained
 * `dist/ace_tacphone_map.d.ts` from it. Keep it free of host imports.
 *
 * Other apps can use this to move the map view or focus a marker. The
 * implementation is built on OpenLayers but the public interface is
 * framework-free: callbacks and methods close over the component instance.
 */

export interface MapViewState {
    /** Map center in map/world coordinates (same units as marker dialog). */
    x: number;
    /** Map center in map/world coordinates. */
    y: number;
    /** View resolution in map units per pixel. */
    resolution: number;
}

/** World-space box: [minX, minY, maxX, maxY]. */
export type MapBoundingBox = [number, number, number, number];

export interface MapFlyToOptions {
    /** Target center X coordinate (map/world units). Ignored when `bbox` is set. */
    x?: number;
    /** Target center Y coordinate (map/world units). Ignored when `bbox` is set. */
    y?: number;
    /**
     * Optional world-space box to fit. The view centers on the box and picks a
     * resolution that shows the whole box with a small screen margin.
     */
    bbox?: MapBoundingBox;
    /** Optional target resolution; when omitted, the current/fit resolution is used. */
    resolution?: number;
    /** If true (default), animate the transition. Set to false for instant. */
    animate?: boolean;
    /**
     * Temporarily draw a glowing box (with `bbox`) or circle (center only)
     * around the flown-to area. `highlightSizePx` shrinks a bbox highlight to a
     * screen-space box around the center (used for marker icons).
     */
    highlight?: boolean;
    /** Screen-space size of the highlight box around the final center. */
    highlightSizePx?: number;
}

/** Options for {@link MapApi.focusMarker}. */
export interface MapFocusMarkerOptions {
    /** Optional world-space box; defaults to a box around the marker. */
    bbox?: MapBoundingBox;
    /** Show the temporary glowing highlight. */
    highlight?: boolean;
    /**
     * Position to show when the marker no longer exists. Used by shared chat
     * objects: the Map opens the stored position and tells the user that the
     * marker itself is gone.
     */
    fallbackPosition?: [number, number];
}

export interface MapApi {
    /** Move the map view to the given center, bounding box and/or resolution. */
    flyTo(options: MapFlyToOptions): void;
    /** Get the current view state, or undefined if the map is not ready. */
    getView(): MapViewState | undefined;
    /** True when the map instance exists and terrain view is ready. */
    isReady(): boolean;
    /**
     * True when a marker with this internal name is currently on the map.
     *
     * Marker names come from the game (`_USER_DEFINED…` for player markers) and
     * are the `data.name` of a shared `map.marker` chat object.
     */
    hasMarker(name: string): boolean;
    /**
     * Move the view to a marker position and zoom so the marker is readable.
     *
     * Resolves `false` when the marker does not exist (for example it was
     * deleted) or the marker layer is not ready yet. It waits for the initial
     * marker snapshot before deciding, so a call shortly after opening the Map
     * panel does not report a false negative.
     */
    focusMarker(name: string, options?: MapFocusMarkerOptions): Promise<boolean>;
}

export const MAP_SERVICE = "map";
export const MAP_SERVICE_VERSION = 1;
