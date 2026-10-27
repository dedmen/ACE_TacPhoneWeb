/**
 * Everything the Web UI knows about a marker that should be created.
 *
 * `position` is in the map projection (the same coordinate system the marker
 * layer uses for its features).
 */
export interface MarkerCreationData {
    /** User-visible marker name/label. */
    label: string;
    /** CfgMarkers class name. */
    type: string;
    /** CfgMarkerColors class name. */
    color: string;
    /** Map position as [x, y]. */
    position: [number, number];
}

/**
 * Sends a newly created marker to the game.
 *
 * TODO: Implement the actual game request.
 */
export function createMarker(marker: MarkerCreationData): void {
    void marker;
}
