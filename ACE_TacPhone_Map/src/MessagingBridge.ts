/**
 * Bridge from the Map app to the TacPhone Messenger app.
 *
 * The Messenger app is optional: its source is never imported here. Everything
 * is reached through the host registry, and the shapes below are local
 * structural copies of the parts of `MessagingApp/src/api.ts` this app uses.
 * Keep them in sync with that contract; do not import it across app folders.
 *
 * Two flows live here:
 * - `shareMarkerToMessenger()` turns an icon marker into a `map.marker` chat
 *   object and hands it to `MessengerApi.shareObject()`.
 * - `registerMarkerObjectRenderer()` registers a renderer for `map.marker`
 *   while a Messenger panel is mounted, so clicking such a card focuses the
 *   marker through `MapApi.focusMarker()`.
 */

import { GPS_SERVICE, type GpsApi, type MapFocusMarkerOptions } from './api';
import { t } from './i18n';
import { formatSharedSummary } from './MapGps/GpsFormat';

/** App name in `ace_tacphone_apps`; key of `window.TacPhone.apps.knownApps`. */
export const MESSENGER_APP_NAME = 'Messaging';

/** Panel id of the Messenger panel, persisted in saved layouts. */
export const MESSENGER_PANEL_ID = 'Messaging';

/** Service name registered by the Messenger panel. */
export const MESSENGER_SERVICE = 'messenger';

/** App name of this app, used for notification icons. */
export const MAP_APP_NAME = 'ACE_TacPhone_Map';

/** Panel id of this app, used as the routing target of a marker action. */
export const MAP_PANEL_ID = 'ACE_TacPhone_Map';

/** Service name registered by a Map panel. */
const MAP_SERVICE_NAME = 'map';

/** Chat object kind of a shared map marker. */
export const MARKER_OBJECT_KIND = 'map.marker';

/** Version of the `map.marker` payload produced here. */
export const MARKER_OBJECT_VERSION = 1;

// ---------------------------------------------------------------------------
// Local structural copy of the Messenger contract
// ---------------------------------------------------------------------------

/** Persisted display snapshot of a chat object. */
export interface ChatObjectPreview {
    title: string;
    subtitle?: string;
    /** Game texture path or data URL. */
    icon?: string;
    color?: string;
}

/** Generic click action of a chat object, routed through the host. */
export interface ChatObjectAction {
    service: string;
    panelId?: string;
    method: string;
    args?: unknown[];
    policy?: 'auto' | 'focused' | 'largest' | 'first' | 'ask';
}

/** Serializable object carried by a message. */
export interface ChatObject {
    kind: string;
    version: number;
    data: unknown;
    preview?: ChatObjectPreview;
    action?: ChatObjectAction;
}

/** Renderer of one chat object kind, registered with Messenger. */
export interface MessengerObjectRenderer {
    kind: string;
    describe(
        data: unknown,
        storedPreview: ChatObjectPreview | undefined,
    ): ChatObjectPreview | Promise<ChatObjectPreview> | undefined;
    activate?(data: unknown): void | Promise<void>;
}

/** Result of `MessengerApi.shareObject()`. */
export interface ShareResult {
    /** False when the user cancelled or nothing was sent. */
    ok: boolean;
    cancelled?: boolean;
    roomId?: string;
    error?: string;
}

/** The parts of the Messenger API used by the Map app. */
export interface MessengerApi {
    shareObject(object: ChatObject): Promise<ShareResult>;
    registerObjectRenderer(renderer: MessengerObjectRenderer): () => void;
}

// ---------------------------------------------------------------------------
// map.marker payload
// ---------------------------------------------------------------------------

/** Marker data the Map layer hands to {@link shareMarkerToMessenger}. */
export interface MarkerChatPayload {
    name: string;
    type: string;
    color: string;
    text: string;
    label: string;
    position: [number, number];
    typeIcon: string;
    resolvedColor: string;
}

/** Marker data as stored in a `map.marker` chat object. */
interface MarkerObjectData {
    name: string;
    type: string;
    color: string;
    text: string;
    label: string;
    position: [number, number];
}

/** Survives a game reconnect: the card renders without the Map being mounted. */
function buildMarkerPreview(data: MarkerChatPayload): ChatObjectPreview {
    return {
        title: data.text || data.label || t('STR_3DEN_Marker_textSingular'),
        subtitle: t('STR_ACE_Tacphone_Map_Marker_ObjectSubtitle'),
        icon: data.typeIcon || undefined,
        color: data.resolvedColor || undefined,
    };
}

/** Builds the chat object of one marker. Coordinates stay in `data` only. */
export function buildMarkerChatObject(marker: MarkerChatPayload): ChatObject {
    const data: MarkerObjectData = {
        name: marker.name,
        type: marker.type,
        color: marker.color,
        text: marker.text,
        label: marker.label,
        position: [marker.position[0], marker.position[1]],
    };

    return {
        kind: MARKER_OBJECT_KIND,
        version: MARKER_OBJECT_VERSION,
        data,
        preview: buildMarkerPreview(marker),
        action: {
            service: MAP_SERVICE_NAME,
            panelId: MAP_PANEL_ID,
            method: 'focusMarker',
            args: [
                marker.name,
                {
                    highlight: true,
                    fallbackPosition: data.position,
                },
            ],
            // Several Map panels: let the host target chooser pick the instance.
            policy: 'ask',
        },
    };
}

/** Validates the `data` of an incoming `map.marker` object. */
function readMarkerObjectData(value: unknown): MarkerObjectData | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const candidate = value as Partial<MarkerObjectData>;
    const position = candidate.position;

    if (typeof candidate.name !== 'string' || candidate.name === '') {
        return null;
    }

    if (
        !Array.isArray(position) ||
        position.length < 2 ||
        !Number.isFinite(position[0]) ||
        !Number.isFinite(position[1])
    ) {
        return null;
    }

    return {
        name: candidate.name,
        type: typeof candidate.type === 'string' ? candidate.type : '',
        color: typeof candidate.color === 'string' ? candidate.color : '',
        text: typeof candidate.text === 'string' ? candidate.text : '',
        label: typeof candidate.label === 'string' ? candidate.label : '',
        position: [position[0], position[1]],
    };
}

// ---------------------------------------------------------------------------
// Messenger access
// ---------------------------------------------------------------------------

/** True when the Messenger app is installed (loaded into this page). */
export function isMessengerInstalled(): boolean {
    try {
        return window.TacPhone.apps.knownApps.has(MESSENGER_APP_NAME);
    } catch {
        return false;
    }
}

/**
 * Synchronous lookup of an already mounted Messenger panel. A background tab is
 * not mounted, so this is only used for renderer registration.
 */
export function getMessengerApi(): MessengerApi | undefined {
    try {
        // `list()` does not warn when no Messenger panel is mounted; Map panels
        // commonly exist while Messenger is closed or in the background.
        const info = window.TacPhone.interApp.list(MESSENGER_SERVICE)[0];
        return info?.api as MessengerApi | undefined;
    } catch (error) {
        console.warn('Could not resolve the messenger service', error);
        return undefined;
    }
}

/**
 * Routes to a mounted Messenger panel (opening it when needed) and returns its
 * API. Resolves undefined when the app is missing or never registers.
 */
async function resolveMessengerForShare(): Promise<MessengerApi | undefined> {
    const info = await window.TacPhone.interApp.resolveAsync({
        service: MESSENGER_SERVICE,
        panelId: MESSENGER_PANEL_ID,
        openIfMissing: true,
    });

    return info?.api as MessengerApi | undefined;
}

/**
 * Shares one icon marker through Messenger. Messenger opens its target
 * selector and this resolves when the user sends or cancels.
 *
 * Throws when Messenger is unavailable, so the caller can notify the user.
 */
export async function shareMarkerToMessenger(marker: MarkerChatPayload): Promise<ShareResult> {
    const api = await resolveMessengerForShare();

    if (!api || typeof api.shareObject !== 'function') {
        throw new Error('Messenger is not available.');
    }

    return api.shareObject(buildMarkerChatObject(marker));
}

// ---------------------------------------------------------------------------
// map.marker renderer
// ---------------------------------------------------------------------------

const markerObjectRenderer: MessengerObjectRenderer = {
    kind: MARKER_OBJECT_KIND,
    describe(data, storedPreview): ChatObjectPreview | undefined {
        const marker = readMarkerObjectData(data);
        if (!marker) {
            // Fall back to the preview stored in the message.
            return storedPreview;
        }

        return {
            title: marker.text || marker.label || t('STR_3DEN_Marker_textSingular'),
            subtitle: t('STR_ACE_Tacphone_Map_Marker_ObjectSubtitle'),
            // The icon and color are not stored in `data`; the persisted preview
            // keeps them and is the best source once the sending Map is gone.
            icon: storedPreview?.icon,
            color: storedPreview?.color,
        };
    },
    /**
     * The Map app owns how a `map.marker` object is opened. Messenger only
     * invokes this callback; it never contains map-specific routing.
     */
    async activate(data): Promise<void> {
        const marker = readMarkerObjectData(data);
        if (!marker) {
            throw new Error('This marker object has no usable data.');
        }

        const info = await window.TacPhone.interApp.resolveAsync({
            service: MAP_SERVICE_NAME,
            panelId: MAP_PANEL_ID,
            openIfMissing: true,
        });

        const api = info?.api as {
            focusMarker?: (name: string, options?: MapFocusMarkerOptions) => Promise<boolean>;
        } | undefined;

        if (!api || typeof api.focusMarker !== 'function') {
            throw new Error('The Map app is not available.');
        }

        const focused = await api.focusMarker(marker.name, {
            highlight: true,
            fallbackPosition: marker.position,
        });

        if (focused === false) {
            throw new Error('This marker was deleted.');
        }
    },
};

/** Mounted Messenger API the renderer is currently registered with. */
let registeredApi: MessengerApi | undefined;
let unregisterRenderer: (() => void) | undefined;

/** Registers the renderer with a mounted Messenger panel, if there is one. */
function attachRenderer(): void {
    const api = getMessengerApi();

    if (registeredApi === api && unregisterRenderer) {
        return;
    }

    detachRenderer();

    if (!api || typeof api.registerObjectRenderer !== 'function') {
        return;
    }

    registeredApi = api;
    unregisterRenderer = api.registerObjectRenderer(markerObjectRenderer);
}

/** Removes the renderer from the Messenger panel it was registered with. */
function detachRenderer(): void {
    const unregister = unregisterRenderer;
    unregisterRenderer = undefined;
    registeredApi = undefined;

    if (!unregister) {
        return;
    }

    try {
        unregister();
    } catch (error) {
        console.warn('Could not unregister the map marker object renderer', error);
    }
}

/** Reference count so several Map panels share one registration. */
let rendererUsers = 0;
let stopWatching: (() => void) | undefined;

/**
 * Registers the `map.marker` renderer while at least one Map panel is mounted.
 *
 * A Messenger panel may mount later (or be closed and reopened), so the
 * registration follows `interApp.onDidChange` instead of running once. Returns
 * the release function; call it on unmount.
 */
export function registerMarkerObjectRenderer(): () => void {
    rendererUsers += 1;

    if (rendererUsers === 1) {
        try {
            stopWatching = window.TacPhone.interApp.onDidChange(() => {
                attachRenderer();
            });
        } catch (error) {
            console.warn('Could not watch the inter-app registry', error);
        }

        attachRenderer();
    }

    let active = true;

    return () => {
        if (!active) {
            return;
        }

        active = false;
        rendererUsers -= 1;

        if (rendererUsers > 0) {
            return;
        }

        rendererUsers = 0;
        stopWatching?.();
        stopWatching = undefined;
        detachRenderer();
    };
}

// ---------------------------------------------------------------------------
// map.gps_route
// ---------------------------------------------------------------------------

export const GPS_ROUTE_OBJECT_KIND = 'map.gps_route';
export const GPS_ROUTE_OBJECT_VERSION = 1;

interface GpsRouteObjectLeg {
    mode: string;
    kind: string;
    points: number[];
    eta: number;
}

export interface GpsRouteObjectData {
    v: number;
    origin: [number, number];
    waypoints: number[];
    legs: GpsRouteObjectLeg[];
    distance: number;
    eta: number | null;
    author: string;
    createdAt: number;
    label?: string;
    vehicle?: unknown;
}

function modeLabel(mode: string): string {
    if (mode === 'foot') return t('STR_ACE_Tacphone_Map_Gps_Mode_Foot');
    if (mode === 'boat') return t('STR_ACE_Tacphone_Map_Gps_Mode_Boat');
    if (mode === 'air') return t('str_dn_aircraft');
    return t('STR_ACE_Tacphone_Map_Gps_Mode_Ground');
}

function readGpsRouteObjectData(value: unknown): GpsRouteObjectData | null {
    if (!value || typeof value !== 'object') return null;
    const data = value as Partial<GpsRouteObjectData>;
    if (data.v !== 1) return null;
    if (!Array.isArray(data.origin) || data.origin.length < 2) return null;
    if (!Number.isFinite(data.origin[0]) || !Number.isFinite(data.origin[1])) return null;
    if (!Array.isArray(data.waypoints) || data.waypoints.length < 2) return null;
    if (!data.waypoints.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    if (!Array.isArray(data.legs) || data.legs.length === 0) return null;
    for (const leg of data.legs) {
        if (!leg || typeof leg !== 'object') return null;
        if (!Array.isArray(leg.points) || leg.points.length < 4) return null;
        if (!leg.points.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    }
    if (typeof data.distance !== 'number' || !Number.isFinite(data.distance)) return null;
    if (typeof data.author !== 'string') return null;
    if (typeof data.createdAt !== 'number' || !Number.isFinite(data.createdAt)) return null;
    return data as GpsRouteObjectData;
}

function buildGpsRoutePreview(data: GpsRouteObjectData): ChatObjectPreview {
    const waypointCount = Math.floor(data.waypoints.length / 2);
    const waypoints = waypointCount === 1
        ? t('STR_ACE_Tacphone_Map_Gps_Shared_Waypoints_One', waypointCount)
        : t('STR_ACE_Tacphone_Map_Gps_Shared_Waypoints_Other', waypointCount);
    const mode = modeLabel(data.legs[0]?.mode ?? 'ground');
    return {
        title: data.label || t('STR_ACE_Tacphone_Map_Gps_Shared_Title'),
        subtitle: formatSharedSummary(mode, data.distance, waypoints),
        color: '#22d3ee',
    };
}

export function buildGpsRouteChatObject(data: unknown, author: string): ChatObject {
    const route = readGpsRouteObjectData(data);
    const payload: GpsRouteObjectData = route ?? {
        v: 1,
        origin: [0, 0],
        waypoints: [],
        legs: [],
        distance: 0,
        eta: null,
        author,
        createdAt: 0,
    };
    const preview = route ? buildGpsRoutePreview(route) : {
        title: t('STR_ACE_Tacphone_Map_Gps_Shared_Unavailable'),
    };

    return {
        kind: GPS_ROUTE_OBJECT_KIND,
        version: GPS_ROUTE_OBJECT_VERSION,
        data: payload,
        preview,
        action: {
            service: GPS_SERVICE,
            panelId: 'ACE_TacPhone_Map_GPS',
            method: 'openSharedRoute',
            args: [payload],
            policy: 'ask',
        },
    };
}

export async function shareGpsRouteToMessenger(data: unknown, author: string): Promise<ShareResult> {
    // A route that does not validate here would be stored as an empty card, so
    // the share fails instead of sending a broken object.
    if (!readGpsRouteObjectData(data)) {
        throw new Error('This route cannot be shared.');
    }

    const api = await resolveMessengerForShare();
    if (!api || typeof api.shareObject !== 'function') {
        throw new Error('Messenger is not available.');
    }

    return api.shareObject(buildGpsRouteChatObject(data, author));
}

const gpsRouteObjectRenderer: MessengerObjectRenderer = {
    kind: GPS_ROUTE_OBJECT_KIND,
    describe(data, storedPreview): ChatObjectPreview | undefined {
        const route = readGpsRouteObjectData(data);
        return route ? buildGpsRoutePreview(route) : storedPreview;
    },
    async activate(data): Promise<void> {
        const route = readGpsRouteObjectData(data);
        if (!route) throw new Error('This GPS route object has no usable data.');

        const info = await window.TacPhone.interApp.resolveAsync({
            service: GPS_SERVICE,
            panelId: 'ACE_TacPhone_Map_GPS',
            openIfMissing: true,
        });

        const api = info?.api as GpsApi | undefined;
        if (!api || typeof api.openSharedRoute !== 'function') {
            throw new Error('The GPS panel is not available.');
        }

        if ((await api.openSharedRoute(route)) === false) {
            throw new Error('The GPS panel could not open this route.');
        }
    },
};

let gpsRegisteredApi: MessengerApi | undefined;
let gpsUnregisterRenderer: (() => void) | undefined;

function attachGpsRenderer(): void {
    const api = getMessengerApi();
    if (gpsRegisteredApi === api && gpsUnregisterRenderer) return;

    detachGpsRenderer();
    if (!api || typeof api.registerObjectRenderer !== 'function') return;

    gpsRegisteredApi = api;
    gpsUnregisterRenderer = api.registerObjectRenderer(gpsRouteObjectRenderer);
}

function detachGpsRenderer(): void {
    const unregister = gpsUnregisterRenderer;
    gpsUnregisterRenderer = undefined;
    gpsRegisteredApi = undefined;
    if (!unregister) return;

    try {
        unregister();
    } catch (error) {
        console.warn('Could not unregister the GPS route object renderer', error);
    }
}

let gpsRendererUsers = 0;
let gpsStopWatching: (() => void) | undefined;

export function registerGpsRouteObjectRenderer(): () => void {
    gpsRendererUsers += 1;

    if (gpsRendererUsers === 1) {
        try {
            gpsStopWatching = window.TacPhone.interApp.onDidChange(() => {
                attachGpsRenderer();
            });
        } catch (error) {
            console.warn('Could not watch the inter-app registry', error);
        }

        attachGpsRenderer();
    }

    let active = true;
    return () => {
        if (!active) return;
        active = false;
        gpsRendererUsers -= 1;
        if (gpsRendererUsers > 0) return;

        gpsRendererUsers = 0;
        gpsStopWatching?.();
        gpsStopWatching = undefined;
        detachGpsRenderer();
    };
}
