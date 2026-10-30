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

class NetworkingWebsocket implements Networking {
    requestCounter: number = 0;
    socket!: WebSocket;

    private static readonly RequestTimeoutMs = 30_000;

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
            this.socket.send(JSON.stringify({k: key, d:data}));
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


    constructor() {
        console.log("NetworkStartup WebSocket");
        this.connect();
    };

    private connect(): void {
        this.isReady = false;
        this.readyPromise = new Promise<void>((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });

        // Callers that don't need networking may never await this promise; don't report it as unhandled.
        this.readyPromise.catch(() => {});

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
            console.log(`[message] Data received from server: ${event.data}`);
            let jsonData: any;
            try {
                jsonData = JSON.parse(event.data);
            } catch (error) {
                console.error("TacPhone websocket sent invalid JSON:", error, event.data);
                return;
            }
            console.log("recv", jsonData);

            if (jsonData.k == "command") {
                // The game sent a command to us, not a reply
                this.OnMessageFromGame(jsonData.d);
            }

            this._response(jsonData.k, jsonData.d);
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

    WhenReady(): Promise<void> {
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

        // We are reusing the existing A3API for request/response
        // Request will land in ExtensionCallback

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



// Are we running inside Arma game, or are we standalone browser page
export function IsArma()
{
    // Arma loads content into a sandbox iframe with blob: url
    return window.location.href.startsWith("blob:");
}

// Are we running inside Arma game, or are we standalone browser page
export function IsLocalDev()
{
    // Arma loads content into a sandbox iframe with blob: url
    return window.location.href.startsWith("http://localhost"); // non-dev webbrowser will be https (for now..)
}

/**
 * The one transport of this page, in-game or websocket.
 *
 * Apps reach it through `window.TacPhone.networking`; host modules import it.
 */
export const networking: Networking = IsArma() ? new NetworkingA3() : new NetworkingWebsocket();