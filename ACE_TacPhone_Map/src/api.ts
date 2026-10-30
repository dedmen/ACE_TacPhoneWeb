/**
 * Map service API for inter-app communication.
 *
 * This is the app's public type surface and the entry point of
 * `tacphone-build bundle-api-types`, which emits a self-contained
 * `dist/ace_tacphone_map.d.ts` from it. Keep it free of host imports.
 *
 * Other apps can use this to move the map view. The implementation is built
 * on OpenLayers but the public interface is framework-free: callbacks and
 * methods close over the component instance.
 */

export interface MapViewState {
    /** Map center in map/world coordinates (same units as marker dialog). */
    x: number;
    /** Map center in map/world coordinates. */
    y: number;
    /** View resolution in map units per pixel. */
    resolution: number;
}

export interface MapFlyToOptions {
    /** Target center X coordinate (map/world units). */
    x: number;
    /** Target center Y coordinate (map/world units). */
    y: number;
    /** Optional target resolution; if omitted, current resolution is kept. */
    resolution?: number;
    /** If true (default), animate the transition. Set to false for instant. */
    animate?: boolean;
}

export interface MapApi {
    /** Move the map view to the given center and resolution. */
    flyTo(options: MapFlyToOptions): void;
    /** Get the current view state, or undefined if the map is not ready. */
    getView(): MapViewState | undefined;
    /** True when the map instance exists and terrain view is ready. */
    isReady(): boolean;
}

export const MAP_SERVICE = "map";
export const MAP_SERVICE_VERSION = 1;
