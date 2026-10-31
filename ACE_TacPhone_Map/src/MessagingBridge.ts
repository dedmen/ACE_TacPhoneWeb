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
        title: data.text || data.label || 'Marker',
        subtitle: 'Map marker',
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
            args: [marker.name],
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
            title: marker.text || marker.label || 'Marker',
            subtitle: 'Map marker',
            // The icon and color are not stored in `data`; the persisted preview
            // keeps them and is the best source once the sending Map is gone.
            icon: storedPreview?.icon,
            color: storedPreview?.color,
        };
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
