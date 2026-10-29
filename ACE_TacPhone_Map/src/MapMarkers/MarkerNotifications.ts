// Map marker notifications.
//
// The game pushes `Marker.Upsert` for every new or moved marker. Two paths raise
// the notification, and exactly one of them runs per update:
//
// - A mounted MarkerLayerManager owns the marker features and knows that an
//   update created a marker (the initial `GetAllMarkers` snapshot seeds the
//   known names), so it calls notifyMarkerUpsert() itself.
// - When no marker layer is mounted (Map panel closed), the module-scope backup
//   handler below raises the notification. It only checks for an active layer
//   and notifies; it never creates marker features or loads icons.
//
// Tapping a notification routes to the Map service and calls MapApi.flyTo(), so
// the marker is focused in an already open, or newly opened, Map panel.

import { mapCommandRegistry } from '../CommandRegistry';
import type { MapApi } from '../MapApi';
import type { TacPhoneNotification } from '../TacPhoneMain';
import type { MarkerUpdate } from './MarkerLayer';

/** Marker names the app already knows about; a repeat upsert is only a move. */
const knownMarkerNames = new Set<string>();

/** Number of mounted MarkerLayerManager instances. */
let activeMarkerLayers = 0;

/**
 * Registers a mounted marker layer, which suppresses the backup handler.
 *
 * @returns An idempotent release function for destroy().
 */
export function registerMarkerLayer(): () => void {
    activeMarkerLayers++;

    let released = false;
    return () => {
        if (released) {
            return;
        }

        released = true;
        activeMarkerLayers = Math.max(0, activeMarkerLayers - 1);
    };
}

/** True while a mounted marker layer handles marker updates itself. */
export function hasActiveMarkerLayer(): boolean {
    return activeMarkerLayers > 0;
}

/**
 * Seeds the known marker names, e.g. from the initial `GetAllMarkers` snapshot,
 * so markers that already exist never raise a notification.
 */
export function markKnownMarkerNames(names: Iterable<string>): void {
    for (const name of names) {
        if (typeof name === 'string' && name !== '') {
            knownMarkerNames.add(name);
        }
    }
}

/**
 * Markers created by the local player must not notify that same player.
 */
function isLocalPlayerMarker(_name: string): boolean {
    // #TODO Player-created markers are named `_USER_DEFINED #<playerId>/...`.
    // Once the local player id is available through the host API, parse the id
    // out of the name and compare it with the local one instead of returning
    // false unconditionally.
    return false;
}

/** Notification body: the marker text, else its type, else a generic label. */
function markerLabel(type: unknown, text: unknown): string {
    if (typeof text === 'string' && text !== '') {
        return text;
    }

    if (typeof type === 'string' && type !== '') {
        return type;
    }

    return 'Marker';
}

/**
 * Shows a notification for a newly created marker. Repeated upserts of a marker
 * that is already known (position updates) are ignored.
 */
export function notifyMarkerUpsert(marker: MarkerUpdate): void {
    if (!marker) {
        return;
    }

    // [name, type, color, dir, pos, text, shape, alpha, brush, size, channel, polyline]
    const [name, type, , , position, text] = marker;

    if (typeof name !== 'string' || name === '') {
        return;
    }

    if (knownMarkerNames.has(name)) {
        return;
    }

    // The name is recorded even for own markers, so their updates stay quiet.
    knownMarkerNames.add(name);

    if (isLocalPlayerMarker(name)) {
        return;
    }

    if (!position || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
        return;
    }

    const [x, y] = position;
    const label = markerLabel(type, text);

    window.Notifications.show({
        title: "New map marker",
        body: label,
        app: "ACE_TacPhone_Map",
        data: { position: [x, y] },
        action: async (notification: TacPhoneNotification) => {
            const data = notification.data as { position?: [number, number] } | undefined;
            const position = data?.position;
            if (!position) return;

            try {
                // "ask" lets the host chooser pick between several open Map panels;
                // openIfMissing covers a notification tapped with the Map closed.
                const target = await window.AppApi.resolveAsync(
                    {
                        service: "map",
                        panelId: "ACE_TacPhone_Map",
                        openIfMissing: true,
                        policy: "ask",
                    },
                    "Focus map marker",
                );

                const api = target?.api as Partial<MapApi> | undefined;
                if (typeof api?.flyTo !== "function") return;

                api.flyTo({ x: position[0], y: position[1] });
            } catch (error) {
                console.error("TacPhone failed to focus the map marker:", error);
            }
        },
    });
}

// Backup path: runs when no marker layer is mounted, so a marker still notifies
// with the Map panel closed. Registered at import time for that reason; it must
// stay free of marker features, icon loading and marker type requests.
mapCommandRegistry.register("Marker.Upsert", payload => {
    if (hasActiveMarkerLayer()) return;

    notifyMarkerUpsert((payload as { marker: MarkerUpdate }).marker);
});
