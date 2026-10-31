import "./A3API";
import { SendMessageToApp } from "./AppMessaging";
import { compressAndToBase64, decompressFromBase64 } from "./Compression";
import { decodeGameText, decodeGameTextDeep } from "./GameText";
import type { Networking, TerrainData, TerrainLayer } from "./Types";

/** Target maximum size of one terrain chunk's base64 payload. */
const MAX_TERRAIN_CHUNK_CHARS = 6 * 1024 * 1024;

/**
 * Splits a whole terrain SVG into standalone per-layer SVG documents.
 *
 * Host-internal producer helper: the game response is the only place that has
 * the DOM, so the layer split happens here instead of in an app.
 */
function splitTerrainSVG(svgText: string): TerrainData {
    const svgDoc = (new DOMParser()).parseFromString(svgText, "image/svg+xml");
    const rootSvg = svgDoc.documentElement;

    if (rootSvg.tagName.toLowerCase() !== "svg")
        throw new Error("The terrain response is not a valid SVG document.");

    // The terrain size lives on the root <svg>; the Map uses it for tiling/scaling.
    const widthAttribute = rootSvg.getAttribute("width");
    const heightAttribute = rootSvg.getAttribute("height");
    const width = Number(widthAttribute);
    const height = Number(heightAttribute);

    if (
        widthAttribute === null ||
        heightAttribute === null ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
    ) {
        throw new Error("The terrain SVG is missing a valid width or height.");
    }

    // <defs> is shared by every layer, so each standalone document gets its own copy.
    const originalDefs = rootSvg.querySelector("defs");
    if (!originalDefs)
        throw new Error("The terrain SVG is missing its <defs> section.");

    const layerElements = rootSvg.querySelectorAll("svg > g");
    if (layerElements.length === 0)
        throw new Error("The terrain SVG does not contain any layers.");

    const serializer = new XMLSerializer();
    const layers: TerrainLayer[] = [];

    layerElements.forEach((layer, index) => {
        // Shallow-clone the root so every document keeps the same attributes.
        const newSvg = rootSvg.cloneNode(false);
        newSvg.appendChild(originalDefs.cloneNode(true));
        newSvg.appendChild(layer.cloneNode(true));

        layers.push({
            name: layer.id || `Layer ${index + 1}`,
            svg: serializer.serializeToString(newSvg),
        });
    });

    return { width, height, layers };
}

/** Splits a base64 string into fragments of at most `maxChars` characters. */
function splitBase64(data: string, maxChars: number): string[] {
    if (maxChars <= 0) throw new Error("The terrain chunk size must be positive.");

    const parts: string[] = [];
    for (let offset = 0; offset < data.length; offset += maxChars)
        parts.push(data.slice(offset, offset + maxChars));

    return parts;
}

class NetworkingA3 implements Networking {
    requestCounter: number = 0;
    constructor() {
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
        // We are reusing the existing A3API for request/response

        return new Promise((resolve, reject) => {
            let reqKey = this.GenerateRequestID();

            if (window.A3API._push(reqKey, 
                {
                    // The engine base64-encodes SQF replies and we decode them with atob,
                    // which gives a byte string. Repair the UTF-8 before parsing so string
                    // values are not mojibake; ASCII payloads take the no-copy fast path.
                    resolve: (resultData): void => { resolve(JSON.parse(decodeGameText(atob(resultData))))},
                    reject 
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

    LoadGameTerrain(config: object): Promise<TerrainData> {
        // The SVG is text (including location names), so it needs the UTF-8 repair.
        return window.A3API.RequestTerrainSVG(config)
            .then(decodeGameText)
            .then(splitTerrainSVG);
    }

    async ReplyTerrainSVG(uid: string | number, config: object): Promise<void> {
        // Producer path for the built-in main app: split, compress and send one
        // chunk per layer part. All chunk logic stays private to this module.
        // The diagnostic follows the runtime game debug flag; the bundled
        // in-game page is normally a release web build, so console.warn is used.
        try {
            const debug = window.TacPhone?.gameInfo?.isDebug() === true;
            const terrain = await this.LoadGameTerrain(config);
            const count = terrain.layers.length;

            // Sequential to bound peak memory: one compressed layer at a time.
            for (let index = 0; index < count; index++) {
                const layer = terrain.layers[index];
                const data = await compressAndToBase64(layer.svg);
                const parts = splitBase64(data, MAX_TERRAIN_CHUNK_CHARS);

                if (debug) {
                    // Release builds strip console.log, so use console.warn for
                    // the runtime diagnostic.
                    const rawBytes = new TextEncoder().encode(layer.svg).byteLength;
                    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
                    const compressedBytes = Math.max(
                        0,
                        Math.floor((data.length * 3) / 4) - padding,
                    );
                    const ratio = compressedBytes > 0 ? rawBytes / compressedBytes : 0;
                    const saved = rawBytes > 0 ? (1 - compressedBytes / rawBytes) * 100 : 0;
                    const message =
                        `[TacPhone] Terrain layer ${index + 1}/${count} "${layer.name}": ` +
                        `${rawBytes} B SVG -> ${compressedBytes} B gzip ` +
                        `(${data.length} base64 chars, ${parts.length} chunk(s)), ` +
                        `ratio ${ratio.toFixed(2)}x, ${saved.toFixed(1)}% saved`;

                    console.warn(message);
                }

                for (let part = 0; part < parts.length; part++) {
                    const last = index === count - 1 && part === parts.length - 1;

                    await this.Request({
                        a: "main",
                        c: "ReplyRequestTerrainSVG",
                        uid,
                        index,
                        count,
                        part,
                        parts: parts.length,
                        name: layer.name,
                        width: terrain.width,
                        height: terrain.height,
                        data: parts[part],
                        last,
                    });
                }
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
    }

};

type PendingRequest = {
    resolve: (_: object) => void;
    reject: (reason?: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
};

/** Layers of one in-flight multi-frame terrain reply, keyed by request key. */
type TerrainTransferLayer = {
    name: string;
    expectedParts: number;
    parts: string[];
};

type TerrainTransfer = {
    count: number;
    width: number;
    height: number;
    layers: TerrainTransferLayer[];
};

/** Pairing/connection state of the public relay page. */
export type RemoteState = "need-pairing" | "attaching" | "connected" | "host-offline" | "rejected";

/** UI-facing handle for the relay session; `null` outside the hosted page. */
export interface RemoteSessionApi {
    getState(): RemoteState;
    getError(): string;
    subscribe(listener: () => void): () => void;
    attachCode(code: string): void;
    retry(): void;
}

type RemoteAttach =
    | { kind: "token"; value: string; hostId?: string }
    | { kind: "code"; value: string }
    | { kind: "share"; value: string };

type TransportMode = "direct" | "remote";

const DEVICE_STORAGE_PREFIX = "tacphone.device.";

class NetworkingWebsocket implements Networking {
    requestCounter: number = 0;
    socket!: WebSocket;
    readonly remoteApi: RemoteSessionApi | null = null;

    private static readonly RequestTimeoutMs = 30_000;
    private static readonly RemoteRetryMs = 15_000;

    private readonly mode: TransportMode;

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

    // Terrain replies arrive as several frames with the same request key; buffer them here.
    private terrainTransfers: { [key: string]: TerrainTransfer } = {};

    private remoteState: RemoteState = "need-pairing";
    private remoteError = "";
    private remoteListeners = new Set<() => void>();
    private pendingAttach: RemoteAttach | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private hostId = "";

    private rejectRequest(key: string, reason: unknown): void {
        delete this.terrainTransfers[key];

        const waiters = this.pendingRequests[key];
        if (!waiters) return;

        delete this.pendingRequests[key];
        this.preOpenQueue = this.preOpenQueue.filter(request => request.key !== key);

        for (const waiter of waiters) {
            clearTimeout(waiter.timeout);
            waiter.reject(reason);
        }
    }

    private rejectAllPendingRequests(reason: unknown): void {
        for (const key of Object.keys(this.pendingRequests)) {
            this.rejectRequest(key, reason);
        }
    }

    /** Tells every listener whether the socket is usable; listener failures are contained. */
    private notifyConnectionChange(connected: boolean): void {
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
        delete this.terrainTransfers[key];

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

    /**
     * Buffers one terrain reply frame. Returns true when `data` was a terrain
     * frame (consumed or rejected) so the caller does not treat it as a reply.
     */
    private handleTerrainChunk(key: unknown, data: unknown): boolean {
        if (typeof key !== "string" || !data || typeof data !== "object") return false;

        const d = data as Record<string, unknown>;
        if (d.c !== "ReplyRequestTerrainSVG") return false;

        // A transfer for a request that is no longer pending can never be consumed.
        if (!this.pendingRequests[key]) return true;

        if (typeof d.error === "string") {
            delete this.terrainTransfers[key];
            this.rejectRequest(key, new Error(d.error));
            return true;
        }

        const fail = (message: string): true => {
            delete this.terrainTransfers[key];
            this.rejectRequest(key, new Error(message));
            return true;
        };

        const { count, index, parts, part, name, width, height, data: chunk } = d;

        if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 64)
            return fail("The terrain reply has an invalid layer count.");

        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= (count as number))
            return fail("The terrain reply has an invalid layer index.");

        if (!Number.isInteger(parts) || (parts as number) < 1 || (parts as number) > 64)
            return fail("The terrain reply has an invalid part count.");

        if (!Number.isInteger(part) || (part as number) < 0 || (part as number) >= (parts as number))
            return fail("The terrain reply has an invalid part index.");

        if (typeof width !== "number" || !Number.isFinite(width) || width <= 0
            || typeof height !== "number" || !Number.isFinite(height) || height <= 0)
            return fail("The terrain reply has an invalid size.");

        if (typeof chunk !== "string" || chunk.length === 0)
            return fail("The terrain reply has an empty payload.");

        let transfer = this.terrainTransfers[key];
        if (!transfer) {
            transfer = { count: count as number, width, height, layers: [] };
            this.terrainTransfers[key] = transfer;
        } else if (
            transfer.count !== (count as number)
            || transfer.width !== width
            || transfer.height !== height
        ) {
            return fail("The terrain reply changed its layer count or size mid-transfer.");
        }

        const layerIndex = index as number;
        const layerParts = parts as number;
        const partIndex = part as number;
        let layer = transfer.layers[layerIndex];

        if (!layer) {
            layer = {
                name: typeof name === "string" ? name : `Layer ${layerIndex + 1}`,
                expectedParts: layerParts,
                parts: [],
            };
            transfer.layers[layerIndex] = layer;
        } else if (layer.expectedParts !== layerParts) {
            return fail("The terrain reply changed its part count mid-transfer.");
        }

        layer.parts[partIndex] = chunk;

        // Complete only when every layer index and every part of every layer is present.
        for (let i = 0; i < transfer.count; i++) {
            const entry = transfer.layers[i];
            if (!entry) return true;

            for (let p = 0; p < entry.expectedParts; p++) {
                if (typeof entry.parts[p] !== "string") return true;
            }
        }

        const payload = {
            width: transfer.width,
            height: transfer.height,
            layers: transfer.layers.map(entry => ({ name: entry.name, data: entry.parts.join("") })),
        };

        this._response(key, payload);
        return true;
    }


    constructor(mode: TransportMode = "direct") {
        this.mode = mode;
        console.log(`NetworkStartup ${mode === "remote" ? "Relay" : "WebSocket"}`);

        if (mode === "remote") {
            this.remoteApi = {
                getState: () => this.remoteState,
                getError: () => this.remoteError,
                subscribe: (listener) => {
                    this.remoteListeners.add(listener);
                    return () => { this.remoteListeners.delete(listener); };
                },
                attachCode: (code) => this.attachCode(code),
                retry: () => this.retryRemote(),
            };

            this.resetReadyPromise();
            this.prepareRemote();
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

    private setRemoteState(state: RemoteState, error = ""): void {
        if (this.remoteState === state && this.remoteError === error) return;
        this.remoteState = state;
        this.remoteError = error;

        for (const listener of [...this.remoteListeners]) {
            try {
                listener();
            } catch (listenerError) {
                console.error("TacPhone remote state listener failed:", listenerError);
            }
        }
    }

    private prepareRemote(): void {
        // Pairing data can arrive as #p=<code>, #s=<share>, ?p=<code> or ?s=<share>.
        const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const query = new URLSearchParams(window.location.search);

        const code = query.get("p") || query.get("code") || hash.get("p") || hash.get("code");
        const share = query.get("s") || query.get("share") || hash.get("s") || hash.get("share");

        if (code || share) {
            // Do not leave a bearer key in the address bar/history.
            history.replaceState(null, "", window.location.pathname);
            this.pendingAttach = code
                ? { kind: "code", value: normalizeCode(code) }
                : { kind: "share", value: share! };
            this.connect();
            return;
        }

        const stored = this.loadDevice();
        if (stored) {
            this.hostId = stored.hostId;
            this.pendingAttach = { kind: "token", value: stored.token, hostId: stored.hostId };
            this.connect();
            return;
        }

        this.setRemoteState("need-pairing");
    }

    private attachCode(code: string): void {
        const normalized = normalizeCode(code);
        if (!normalized) {
            this.setRemoteState("need-pairing", "Enter the code from the in-game Remote Access panel.");
            return;
        }

        this.pendingAttach = { kind: "code", value: normalized };
        this.setRemoteState("attaching");
        this.connect();
    }

    private retryRemote(): void {
        this.clearRetryTimer();
        this.connect(true);
    }

    private clearRetryTimer(): void {
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    private scheduleRetry(): void {
        if (this.retryTimer !== null) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.connect(true);
        }, NetworkingWebsocket.RemoteRetryMs);
    }

    private loadDevice(): { hostId: string; token: string } | null {
        try {
            const raw = localStorage.getItem(DEVICE_STORAGE_PREFIX + window.location.host);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as { hostId?: string; token?: string };
            if (!parsed?.token) return null;
            return { hostId: parsed.hostId ?? "", token: parsed.token };
        } catch (error) {
            console.warn("Could not read the stored TacPhone device token:", error);
            return null;
        }
    }

    private saveDevice(hostId: string, token: string): void {
        try {
            localStorage.setItem(
                DEVICE_STORAGE_PREFIX + window.location.host,
                JSON.stringify({ hostId, token }),
            );
        } catch (error) {
            console.warn("Could not persist the TacPhone device token:", error);
        }
    }

    private sendAttach(): void {
        if (!this.pendingAttach) return;

        const frame: Record<string, unknown> = { t: "attach", proto: 1, role: "client" };

        if (this.pendingAttach.kind === "token") {
            frame.deviceToken = this.pendingAttach.value;
            if (this.pendingAttach.hostId) frame.hostId = this.pendingAttach.hostId;
        } else if (this.pendingAttach.kind === "code") {
            frame.code = this.pendingAttach.value;
        } else {
            frame.share = this.pendingAttach.value;
        }

        try {
            this.socket.send(JSON.stringify(frame));
        } catch (error) {
            console.error("Could not send the TacPhone attach frame:", error);
        }
    }

    private handleRemoteControl(frame: any): void {
        switch (frame.t) {
            case "attach-ok": {
                const token: string | undefined = frame.deviceToken;
                const hostId: string = frame.hostId ?? this.hostId ?? "";

                if (token) {
                    this.hostId = hostId;
                    this.pendingAttach = { kind: "token", value: token, hostId };
                    this.saveDevice(hostId, token);
                }

                this.isReady = true;
                this.setRemoteState("connected");
                this.resolveReady?.();
                this.resolveReady = this.rejectReady = undefined;
                this.flushPreOpenQueue();
                this.notifyConnectionChange(true);
                break;
            }

            case "host-offline":
                this.setRemoteState("host-offline", "The phone is not connected in-game.");
                this.socket?.close();
                break;

            case "rejected":
                this.setRemoteState("rejected", `The relay rejected the connection (${frame.reason ?? "unknown"}).`);
                this.pendingAttach = null;
                this.socket?.close();
                break;

            case "peer-kicked":
                this.setRemoteState("host-offline", "The host ended this session.");
                this.socket?.close();
                break;

            case "ping":
                // The relay drops peers that do not answer its keepalive.
                try {
                    this.socket?.send(JSON.stringify({ t: "pong" }));
                } catch (error) {
                    console.warn("Could not answer the TacPhone relay ping:", error);
                }
                break;

            case "pong":
                break;

            default:
                // Keep this visible: an unexpected control frame means the server and
                // page disagree about the protocol version.
                console.warn("Unknown TacPhone relay control frame:", frame);
                break;
        }
    }

    private connect(silent = false): void {
        if (this.mode === "remote") {
            if (!this.pendingAttach) {
                this.setRemoteState("need-pairing");
                return;
            }

            this.clearRetryTimer();
            this.isReady = false;
            if (!silent) this.setRemoteState("attaching");

            const socket = new WebSocket(`wss://${window.location.host}/ws`);
            socket.binaryType = "arraybuffer";
            this.socket = socket;

            socket.onopen = () => {
                this.sendAttach();
            };

            socket.onmessage = (event) => {
                this.handleSocketMessage(event.data);
            };

            socket.onclose = () => {
                this.isReady = false;
                // Keep queued requests: they flush again after the next attach.
                this.notifyConnectionChange(false);

                if (this.remoteState === "rejected") return;
                if (!this.pendingAttach) {
                    this.setRemoteState("need-pairing");
                    return;
                }

                this.setRemoteState("host-offline");
                this.scheduleRetry();
            };

            socket.onerror = () => {
                // onclose follows and schedules the retry.
                console.log("[error] TacPhone relay socket error");
            };

            return;
        }

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
        console.log(`[message] Data received from server: ${String(data)}`);

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
            this.handleRemoteControl(jsonData);
            return;
        }

        console.log("recv", jsonData);

        if (jsonData.k == "command") {
            // The game sent a command to us, not a reply
            this.OnMessageFromGame(jsonData.d);
        }

        // Multi-frame terrain replies are buffered until complete.
        if (this.handleTerrainChunk(jsonData.k, jsonData.d)) return;

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

    private RequestWithTimeout(data: object, timeoutMs: number): Promise<object> {
        return new Promise((resolve, reject) => {
            const reqKey = this.GenerateRequestID();
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
                // MainApps/main.tsx OnMessageFromGame compressed it for us
                return decompressFromBase64(result as unknown as string);
            });
    }

    async LoadGameTerrain(config: object): Promise<TerrainData> {
        // Terrain is the only request that may need more than the default timeout:
        // the game splits and compresses every layer before replying.
        const result: unknown = await this.RequestWithTimeout(
            { a: "main", c: "RequestTerrainSVG", config },
            60_000,
        );

        // Legacy game host: one compressed whole-SVG string.
        if (typeof result === "string")
            return splitTerrainSVG(await decompressFromBase64(result));

        if (result && typeof result === "object") {
            const payload = result as { width?: unknown; height?: unknown; layers?: unknown };
            const { width, height, layers } = payload;

            if (
                typeof width === "number" && Number.isFinite(width) && width > 0
                && typeof height === "number" && Number.isFinite(height) && height > 0
                && Array.isArray(layers)
            ) {
                const decoded: TerrainLayer[] = [];

                for (const entry of layers) {
                    if (!entry || typeof entry !== "object")
                        throw new Error("The terrain reply contains an invalid layer.");

                    const { name, data } = entry as { name?: unknown; data?: unknown };
                    if (typeof name !== "string" || typeof data !== "string" || data.length === 0)
                        throw new Error("The terrain reply contains an invalid layer payload.");

                    decoded.push({ name, svg: await decompressFromBase64(data) });
                }

                return { width, height, layers: decoded };
            }
        }

        throw new Error("The terrain reply has an unexpected format.");
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

/** Normalises a pairing code: uppercase, alphanumerics only. */
function normalizeCode(code: string): string {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

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
