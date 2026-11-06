import "./A3API";
import { SendMessageToApp } from "./AppMessaging";
import { decodeGameText, decodeGameTextDeep } from "./GameText";
import {
    TERRAIN_CHUNK_IDLE_TIMEOUT_MS,
    TERRAIN_INITIAL_TIMEOUT_MS,
    TerrainRequestCache,
    TerrainTransferAssembler,
    encodeTerrainChunks,
    notifyTerrainLayers,
    readTerrainReply,
    splitTerrainSVG,
} from "./TerrainCache";
import type {
    Networking,
    TerrainData,
    TerrainLayerListener,
    TerrainLayerProgress,
} from "./Types";
import { RelayManager } from "./RelayManager";
import { RemoteSession, type RemoteSessionApi, type RemoteSessionTransport } from "./RemoteSession";

export type { RemoteState, RemoteSessionApi } from "./RemoteSession";

/** Short description of a request for error logs; never includes large payloads. */
function describeRequest(data: object): string {
    const record = data as Record<string, unknown>;
    const fields = ["a", "c", "uid", "index", "count", "part", "name"]
        .filter((key) => record[key] !== undefined)
        .map((key) => `${key}=${String(record[key])}`);

    if (typeof record.data === "string") {
        fields.push(`dataChars=${record.data.length}`);
    }

    return fields.length > 0 ? `(${fields.join(", ")})` : "(unknown request)";
}

class NetworkingA3 implements Networking {
    requestCounter: number = 0;
    // The in-game page is recreated when the game terrain changes, so one
    // completed result remains valid for the page's whole lifetime.
    private readonly terrainCache = new TerrainRequestCache(Number.POSITIVE_INFINITY, true);
    private readonly relay: RelayManager;

    constructor() {
        // The hub owns relay state and also intercepts the host's `main`
        // commands (RemoteAccess.*, interests, Debug.RemoteAccess).
        this.relay = new RelayManager(this, () => window.TacPhone?.gameInfo?.isDebug() === true);
        console.log("NetworkStartup A3");
    };
    WhenReady(): Promise<void> {
        // A3API is injected synchronously by the game, so there is nothing to wait for.
        return Promise.resolve();
    }

    GenerateRequestID(): string {
        return `nr${this.requestCounter++}`;
    }

    Request(data:object): Promise<object> {
        // Host-internal commands are handled by the relay hub: panel Remote
        // Access commands, interest aggregation and the debug bridge.
        const intercepted = this.relay.TryHandleLocalRequest(data);
        if (intercepted) return intercepted;

        return this.RequestDirect(data);
    }

    /** Sends a request to SQF without hub interception (used by RelayManager). */
    RequestDirect(data: object): Promise<object> {
        return this.requestToGame(data);
    }

    /**
     * Sends a request to SQF and reports the generated A3API key before the
     * request leaves. The hub uses this to correlate a rewritten remote request
     * with the reply the game sends for its new key.
     */
    RequestTracked(
        data: object,
        onKey: (key: string) => void,
        timeoutMs: number,
    ): Promise<object> {
        return this.requestToGame(data, onKey, timeoutMs);
    }

    private requestToGame(
        data: object,
        onKey?: (key: string) => void,
        timeoutMs?: number,
    ): Promise<object> {
        // We are reusing the existing A3API for request/response

        return new Promise((resolve, reject) => {
            let reqKey = this.GenerateRequestID();
            let settled = false;
            let timeout: ReturnType<typeof setTimeout> | undefined;

            const settle = (finish: () => void): void => {
                if (settled) return;
                settled = true;
                if (timeout !== undefined) clearTimeout(timeout);
                finish();
            };

            if (timeoutMs !== undefined) {
                timeout = setTimeout(() => {
                    settle(() => reject(new Error(
                        `TacPhone request "${reqKey}" timed out after ${timeoutMs}ms`
                        + ` for ${describeRequest(data)}`,
                    )));
                }, timeoutMs);
            }

            onKey?.(reqKey);

            if (window.A3API._push(reqKey, 
                {
                    // The engine base64-encodes SQF replies and we decode them with atob,
                    // which gives a byte string. Repair the UTF-8 before parsing so string
                    // values are not mojibake; ASCII payloads take the no-copy fast path.
                    resolve: (resultData): void => {
                        if (settled) return;

                        let text: string;

                        try {
                            text = decodeGameText(atob(resultData));
                        } catch (error) {
                            // Do not let a decode failure escape into the game's ExecJS
                            // callback: it would be an uncaught error and the promise
                            // would hang forever. A timed-out request has already settled.
                            settle(() => {
                                console.error(
                                    `[TacPhone] Could not base64-decode the game reply for "${reqKey}"`
                                    + ` (${typeof resultData === "string" ? resultData.length : -1} chars)`
                                    + ` to request ${describeRequest(data)}:`,
                                    error,
                                );
                                reject(error);
                            });
                            return;
                        }

                        try {
                            const parsed = JSON.parse(text);
                            settle(() => resolve(parsed));
                        } catch (error) {
                            // Keep the payload: a malformed/truncated reply is otherwise
                            // impossible to diagnose from the console alone.
                            settle(() => {
                                console.error(
                                    `[TacPhone] Invalid JSON reply from the game for "${reqKey}"`
                                    + ` to request ${describeRequest(data)}:`
                                    + ` ${text.length} chars, head="${text.slice(0, 200)}",`
                                    + ` tail="${text.slice(-200).replace(/\s+/g, " ")}"`,
                                    error,
                                );
                                reject(new Error(
                                    `The game sent an invalid JSON reply for request "${reqKey}".`,
                                ));
                            });
                        }
                    },
                    reject: (reason?: unknown): void => {
                        settle(() => reject(reason));
                    },
                }
                ))
                window.A3API.SendAlert(JSON.stringify({k: reqKey, d:data}))
        });
    }

    LoadGameFileText(path: string): Promise<string> {
        path = path.replaceAll("/", "\\");
        return window.A3API.RequestFile(path).then(decodeGameText);
    }

    OnConnectionChange(listener: (connected: boolean) => void): () => void {
        // The in-game transport is injected synchronously by the game and never
        // disconnects while the page lives, so it is connected from the start.
        try {
            listener(true);
        } catch (error) {
            console.error("TacPhone in-game connection listener failed:", error);
        }

        // The in-game transport never disconnects; there is nothing to unsubscribe from.
        return () => undefined;
    }

    LoadGameFileTexture(path: string, maxSize: number): Promise<string> {
        if (path.startsWith("\\"))
            path = path.substring(1);

        // Texture content is raw bytes, not text. Never run it through decodeGameText.
        return window.A3API.RequestTexture(path, maxSize);
    }

    LoadGameTerrain(config: object, onLayer?: TerrainLayerListener): Promise<TerrainData> {
        return this.terrainCache.load(
            config,
            (notify) => this.loadGameTerrainUncached(config, notify),
            onLayer,
        );
    }

    private loadGameTerrainUncached(
        config: object,
        notify: (progress: TerrainLayerProgress) => void,
    ): Promise<TerrainData> {
        // The SVG is text (including location names), so it needs the UTF-8 repair.
        return window.A3API.RequestTerrainSVG(config)
            .then(decodeGameText)
            .then((svgText) => {
                const terrain = splitTerrainSVG(svgText);
                // The in-game transport receives one document; hand over every
                // layer now so the caller has a single code path for both
                // transports (the remote one notifies layer by layer).
                notifyTerrainLayers(terrain, notify);
                return terrain;
            });
    }

    async ReplyTerrainSVG(uid: string | number, config: object): Promise<void> {
        // Producer path for the built-in main app: split, compress and send one
        // chunk per layer part. `encodeTerrainChunks` bounds peak memory to one
        // layer at a time; the diagnostic follows the runtime game debug flag.
        try {
            const terrain = await this.LoadGameTerrain(config);
            const debug = window.TacPhone?.gameInfo?.isDebug() === true;

            for await (const chunk of encodeTerrainChunks(terrain, debug)) {
                await this.Request({
                    a: "main",
                    c: "ReplyRequestTerrainSVG",
                    uid,
                    ...chunk,
                });
            }
        } catch (error) {
            // Tell the requester instead of leaving it waiting for the timeout.
            try {
                await this.Request({
                    a: "main",
                    c: "ReplyRequestTerrainSVG",
                    uid,
                    error: String(error),
                });
            } catch (sendError) {
                console.error("Could not send the terrain error chunk:", sendError);
            }
        }
    }

    OnMessageFromGame(message: object): void {
        // The game sent us a message, probably a notification about something
        // Pushes arrive through JSON.parse(atob(...)) with the same byte-string text.
        // Marker payloads are small, so walking them once stays cheap.
        const decoded = decodeGameTextDeep(message);
        console.log("Message from game", decoded);
        SendMessageToApp(decoded);

        // Every game push is a broadcast: the hub does not filter by target.
        this.relay.BroadcastGameMessage(decoded);
    }

    /** Raw transport string forwarded by SQF (`RELAY:` / `WEBHOST:`). */
    OnTransportMessage(raw: string): void {
        this.relay.OnTransportMessage(raw);
    }

    /** Relay lifecycle event reported by SQF (`established` / `lost`). */
    OnRelayEvent(event: string, detail?: unknown): void {
        this.relay.OnRelayEvent(event, detail);
    }

};

type PendingRequest = {
    resolve: (_: object) => void;
    reject: (reason?: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
};

type TransportMode = "direct" | "remote";

class NetworkingWebsocket implements Networking, RemoteSessionTransport {
    requestCounter: number = 0;
    // A relay host can change without this socket reconnecting, and the new host
    // can serve a different terrain. Completed results are therefore never
    // reused; only a request that is still in flight is shared (StrictMode).
    private readonly terrainCache = new TerrainRequestCache(0);
    socket!: WebSocket;
    readonly remoteApi: RemoteSessionApi | null = null;

    private static readonly RequestTimeoutMs = 30_000;

    private readonly mode: TransportMode;
    // Owns the relay pairing state machine; dormant in "direct" mode.
    private readonly session: RemoteSession;

    private readyPromise!: Promise<void>;
    private resolveReady: (() => void) | undefined;
    private rejectReady: ((reason?: unknown) => void) | undefined;
    private isReady = false;

    // Requests made before the connection opens are queued instead of being sent on a CONNECTING socket.
    private preOpenQueue: Array<{ key: string; data: object }> = [];

    // Connectivity listeners; they survive reconnect attempts, because connect()
    // replaces the socket, not the manager.
    private connectionListeners = new Set<(connected: boolean) => void>();

    // We cannot use A3API's pendingRequests implementation, so we ship our own
    private pendingRequests: { [key: string]: PendingRequest[] } = {};

    // Buffers the ReplyRequestTerrainSVG frames and decodes each layer as soon
    // as its last part arrives.
    private readonly terrainAssembler = new TerrainTransferAssembler({
        isPending: (key) => Boolean(this.pendingRequests[key]),
        onProgress: (key) => this.refreshRequestTimeout(key, TERRAIN_CHUNK_IDLE_TIMEOUT_MS),
        onError: (key, error) => this.rejectRequest(key, error),
        onComplete: (key, terrain) => this._response(key, terrain),
    });

    private rejectRequest(key: string, reason: unknown): void {
        this.terrainAssembler.forget(key);

        const waiters = this.pendingRequests[key];
        if (!waiters) return;

        delete this.pendingRequests[key];
        this.preOpenQueue = this.preOpenQueue.filter(request => request.key !== key);

        for (const waiter of waiters) {
            clearTimeout(waiter.timeout);
            waiter.reject(reason);
        }
    }

    /**
     * Restarts the timeout of a pending request. Used for a streamed reply: as
     * long as frames keep arriving, the transfer is alive even if it takes
     * longer than the initial timeout.
     */
    private refreshRequestTimeout(key: string, timeoutMs: number): void {
        const waiters = this.pendingRequests[key];
        if (!waiters) return;

        for (const waiter of waiters) {
            clearTimeout(waiter.timeout);
            waiter.timeout = setTimeout(() => {
                this.rejectRequest(
                    key,
                    new Error(`TacPhone websocket request "${key}" timed out after ${timeoutMs}ms without a reply`),
                );
            }, timeoutMs);
        }
    }

    private rejectAllPendingRequests(reason: unknown): void {
        for (const key of Object.keys(this.pendingRequests)) {
            this.rejectRequest(key, reason);
        }
    }

    /** Tells every listener whether the socket is usable; listener failures are contained. */
    notifyConnectionChange(connected: boolean): void {
        for (const listener of [...this.connectionListeners]) {
            try {
                listener(connected);
            } catch (error) {
                console.error("TacPhone connection listener failed:", error);
            }
        }
    }

    private sendRequest(key: string, data: object): void {
        try {
            console.log("send", {k: key, d:data});
            const payload = JSON.stringify({k: key, d:data});
            // Relay application frames are binary; the LAN server expects text.
            this.socket.send(this.mode === "remote" ? new TextEncoder().encode(payload) : payload);
        } catch (error) {
            console.error(error);
            this.rejectRequest(key, error);
        }
    }

    private flushPreOpenQueue(): void {
        const queuedRequests = this.preOpenQueue;
        this.preOpenQueue = [];

        for (const request of queuedRequests) {
            // A request may have timed out or been rejected while waiting for the connection.
            if (!(request.key in this.pendingRequests)) continue;
            this.sendRequest(request.key, request.data);
        }
    }

    _response(key: string, content: object) {
        this.terrainAssembler.forget(key);

        const waiters = this.pendingRequests[key];
        if (!waiters) return; // Request doesn't exist

        delete this.pendingRequests[key];
        for (const waiter of waiters) {
            clearTimeout(waiter.timeout);
            waiter.resolve(content);
        }
    }

    _push(key: string, d: PendingRequest) : boolean
    {
        const waiterList = (this.pendingRequests[key] = this.pendingRequests[key] || []);
        waiterList.push(d);
        return waiterList.length == 1; // First insert
    }

        constructor(mode: TransportMode = "direct") {
        this.mode = mode;
        this.session = new RemoteSession(this);
        console.log(`NetworkStartup ${mode === "remote" ? "Relay" : "WebSocket"}`);

        if (mode === "remote") {
            this.remoteApi = this.session.api;

            this.resetReadyPromise();
            this.session.prepareRemote();
            return;
        }

        this.connect();
    };

    private resetReadyPromise(): void {
        this.readyPromise = new Promise<void>((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });

        // Callers that don't need networking may never await this promise; don't report it as unhandled.
        this.readyPromise.catch(() => {});
    }

    // -- RemoteSessionTransport --------------------------------------------

    markNotReady(): void {
        this.isReady = false;
    }

    markReady(): void {
        this.isReady = true;
    }

    settleReady(): void {
        this.resolveReady?.();
        this.resolveReady = this.rejectReady = undefined;
    }

    clearTerrain(): void {
        this.terrainCache.clear();
        this.terrainAssembler.clear();
    }

    flushQueue(): void {
        this.flushPreOpenQueue();
    }

    deliverMessage(data: unknown): void {
        this.handleSocketMessage(data);
    }

    // ---------------------------------------------------------------------

    private connect(): void {
        this.isReady = false;
        this.resetReadyPromise();

        // Establish websocket connection to our server

        let wsURL = IsLocalDev() ? `wss://localhost:8001/ws` : `wss://${window.location.host}/ws`;

        console.log(wsURL);
        this.socket = new WebSocket(wsURL);
        this.socket.onopen = () => {
            console.log("[open] Connection established");
            this.isReady = true;
            this.resolveReady?.();
            this.resolveReady = this.rejectReady = undefined;
            this.flushPreOpenQueue();
            // After the queue flush, so queued requests keep their send order.
            this.notifyConnectionChange(true);
        };

        this.socket.onmessage = (event) => {
            this.handleSocketMessage(event.data);
        };

        this.socket.onclose = (event) => {
            this.terrainCache.clear();
            this.terrainAssembler.clear();
            if (event.wasClean) {
                console.log(`[close] Connection closed cleanly, code=${event.code} reason=${event.reason}`);
            } else {
                // e.g. server process killed or network down
                // event.code is usually 1006 in this case
                console.log('[close] Connection died');
            }

            this.isReady = false;
            this.rejectAllPendingRequests(new Error(`TacPhone websocket closed (code=${event.code})`));

            if (this.rejectReady) {
                this.rejectReady(new Error(`TacPhone websocket closed before connecting (code=${event.code})`));
                this.resolveReady = this.rejectReady = undefined;
            }

            this.notifyConnectionChange(false);
        };

        this.socket.onerror = (error) => {
            console.log(`[error] ${JSON.stringify(error)}`);
            this.rejectAllPendingRequests(new Error("Could not communicate with the TacPhone websocket"));

            if (!this.isReady && this.rejectReady) {
                this.rejectReady(new Error("Could not connect to the TacPhone websocket"));
                this.resolveReady = this.rejectReady = undefined;
            }

            this.notifyConnectionChange(false);
        };
    };

    private handleSocketMessage(data: unknown): void {
        // Never log the payload itself: a terrain chunk is several megabytes and
        // the dev console would copy it on every message.
        console.log(`[message] Data received from server (${String(data).length} chars)`);

        let text: string;
        if (typeof data === "string") {
            text = data;
        } else if (data instanceof ArrayBuffer) {
            text = new TextDecoder().decode(data);
        } else if (typeof Blob !== "undefined" && data instanceof Blob) {
            void data.text().then(chunk => this.handleSocketMessage(chunk));
            return;
        } else {
            console.error("TacPhone websocket sent an unsupported message type:", data);
            return;
        }

        let jsonData: any;
        try {
            jsonData = JSON.parse(text);
        } catch (error) {
            console.error("TacPhone websocket sent invalid JSON:", error, text);
            return;
        }

        if (this.mode === "remote" && typeof jsonData?.t === "string") {
            this.session.handleRemoteControl(jsonData);
            return;
        }

        console.log("recv", { k: jsonData?.k, c: jsonData?.d?.c });

        if (jsonData.k == "command") {
            // The game sent a command to us, not a reply
            this.OnMessageFromGame(jsonData.d);
        }

        // Multi-frame terrain replies are buffered until complete.
        if (this.terrainAssembler.handleChunk(jsonData.k, jsonData.d)) return;

        this._response(jsonData.k, jsonData.d);
    }

    WhenReady(): Promise<void> {
        if (this.mode === "remote")
            return this.readyPromise;

        // Retry the connection if the previous attempt failed or the connection has since closed.
        if (!this.isReady && this.resolveReady === undefined)
            this.connect();

        return this.readyPromise;
    }

    OnConnectionChange(listener: (connected: boolean) => void): () => void {
        this.connectionListeners.add(listener);

        // Catch-up for a subscriber that arrives after the socket already opened;
        // onopen covers everyone who subscribed before that.
        if (this.isReady) {
            try {
                listener(true);
            } catch (error) {
                console.error("TacPhone connection listener failed:", error);
            }
        }

        return () => {
            this.connectionListeners.delete(listener);
        };
    }

    GenerateRequestID(): string {
        return `nr${this.requestCounter++}`;
    }

    Request(data:object): Promise<object> {
        return this.RequestWithTimeout(data, NetworkingWebsocket.RequestTimeoutMs);
    }

    private RequestWithTimeout(
        data: object,
        timeoutMs: number,
        onKey?: (key: string) => void,
    ): Promise<object> {
        return new Promise((resolve, reject) => {
            const reqKey = this.GenerateRequestID();
            onKey?.(reqKey);
            const timeout = setTimeout(() => {
                this.rejectRequest(reqKey, new Error(`TacPhone websocket request "${reqKey}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            if (this._push(reqKey, 
                {
                    resolve, // resultData is already an object
                    reject,
                    timeout
                }
                ))
            {
                if (this.socket?.readyState === WebSocket.OPEN) {
                    this.sendRequest(reqKey, data);
                    return;
                }

                // The socket is still connecting (or reconnecting); send once it is open.
                this.preOpenQueue.push({ key: reqKey, data });
                this.WhenReady().catch(error => {
                    this.rejectRequest(reqKey, error);
                });
            }
        });
    }

    async LoadGameFileText(path: string): Promise<string> {
        if (this.mode === "remote") {
            // The app bundle lives in the game's VFS, not on the relay's static host.
            const result = await this.Request({ a: "main", c: "GetFile", path });
            if (typeof result !== "string")
                throw new Error(`GetFile("${path}") returned ${typeof result} instead of text.`);
            return result;
        }

        let fetchURL = IsLocalDev() ? `https://localhost:8001/${path}` : path;
        var fetchRes = await fetch(fetchURL);
        if (!fetchRes.ok) {
            throw new Error(`Failed to load "${path}" from "${fetchURL}": HTTP ${fetchRes.status} ${fetchRes.statusText}`);
        }
        return fetchRes.text();
    }

    LoadGameFileTexture(path: string, maxSize: number): Promise<string> {

        if (path.startsWith("\\"))
            path = path.substring(1);

        // currently only a in-game webbrowser can load textures, so we need to proxy the request into the game and back out

        // Ask the webhost (the connected Arma client), to send us the terrain back
        return this.Request({a: "main", c: "RequestTexture", path: path, maxSize: maxSize})
            .then(result => {
                // Textures are WebP data URLs and already compressed. The in-game
                // page sends them unchanged; do not gzip them again.
                return result as unknown as string;
            });
    }

    LoadGameTerrain(config: object, onLayer?: TerrainLayerListener): Promise<TerrainData> {
        return this.terrainCache.load(
            config,
            (notify) => this.loadGameTerrainUncached(config, notify),
            onLayer,
        );
    }

    private async loadGameTerrainUncached(
        config: object,
        notify: (progress: TerrainLayerProgress) => void,
    ): Promise<TerrainData> {
        // Terrain is the only request that may need more than the default timeout:
        // the game splits and compresses every layer before replying.
        const result: unknown = await this.RequestWithTimeout(
            { a: "main", c: "RequestTerrainSVG", config },
            TERRAIN_INITIAL_TIMEOUT_MS,
            (key) => {
                // Registered before the request is sent, so the first layer can
                // be delivered as soon as its chunks arrive.
                this.terrainAssembler.register(key, notify);
            },
        );

        return readTerrainReply(result, notify);
    }

    ReplyTerrainSVG(_uid: string | number, _config: object): Promise<void> {
        return Promise.reject(new Error(
            "ReplyTerrainSVG is only available in the in-game transport.",
        ));
    }

    OnMessageFromGame(message: object): void {
        // The game sent us a message, probably a notification about something
        // Forward it to the App its destined for
        console.log("Message from game", message);
        SendMessageToApp(message);
    }

};

// Are we running inside Arma game, or are we standalone browser page
export function IsArma()
{
    // Arma loads content into a sandbox iframe with blob: url
    return window.location.href.startsWith("blob:");
}

// Are we running inside the local dev server, or are we a standalone browser page
export function IsLocalDev()
{
    // Arma loads content into a sandbox iframe with blob: url
    return window.location.href.startsWith("http://localhost"); // non-dev webbrowser will be https (for now..)
}

/** True for loopback, LAN IPs and mDNS names, which are served by the game's own webhost. */
function IsDirectLanHost(): boolean {
    const host = window.location.hostname;
    if (host === "localhost" || host.endsWith(".local")) return true;

    // IPv6 literals are always the direct host in our setup.
    if (host.startsWith("[")) return true;

    const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return false;

    const a = Number(match[1]);
    const b = Number(match[2]);

    return a === 10
        || a === 127
        || (a === 192 && b === 168)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 169 && b === 254);
}

/** True when the page is served by the public relay, not by the game's own webhost. */
export function IsRemoteHosted()
{
    return !IsArma() && !IsLocalDev() && !IsDirectLanHost();
}

const webTransport = IsArma() ? null : new NetworkingWebsocket(IsRemoteHosted() ? "remote" : "direct");

/**
 * The one transport of this page, in-game or websocket.
 *
 * Apps reach it through `window.TacPhone.networking`; host modules import it.
 */
export const networking: Networking = IsArma() ? new NetworkingA3() : webTransport!;

/** Pairing state for the hosted page; `null` in-game and on the direct LAN page. */
export const remoteSession: RemoteSessionApi | null = webTransport?.remoteApi ?? null;
