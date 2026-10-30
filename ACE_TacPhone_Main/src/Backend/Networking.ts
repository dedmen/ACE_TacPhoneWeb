import "./A3API";
import { SendMessageToApp } from "./AppMessaging";
import { decompressFromBase64 } from "./Compression";
import { decodeGameText, decodeGameTextDeep } from "./GameText";
import type { Networking } from "./Types";

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

    LoadGameTerrain(config: object): Promise<string> {
        // The SVG is text (including location names), so it needs the UTF-8 repair.
        return window.A3API.RequestTerrainSVG(config).then(decodeGameText);
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

    private remoteState: RemoteState = "need-pairing";
    private remoteError = "";
    private remoteListeners = new Set<() => void>();
    private pendingAttach: RemoteAttach | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private hostId = "";

    private rejectRequest(key: string, reason: unknown): void {
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
                this.setRemoteState("host-offline", "The phone is not armed in-game.");
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
        return new Promise((resolve, reject) => {
            const reqKey = this.GenerateRequestID();
            const timeout = setTimeout(() => {
                this.rejectRequest(reqKey, new Error(`TacPhone websocket request "${reqKey}" timed out after ${NetworkingWebsocket.RequestTimeoutMs}ms`));
            }, NetworkingWebsocket.RequestTimeoutMs);

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

    LoadGameTerrain(config: object): Promise<string> {
        // Ask the webhost (the connected Arma client), to send us the terrain back
        return this.Request({a: "main", c: "RequestTerrainSVG", config: config})
            .then(result => {
                // MainApps/main.tsx OnMessageFromGame compressed it for us
                return decompressFromBase64(result as unknown as string);
            });
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
