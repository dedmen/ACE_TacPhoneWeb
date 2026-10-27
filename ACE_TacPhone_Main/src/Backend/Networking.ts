import "./A3API";

export interface Networking {
 WhenReady(): Promise<void>;
 Request(params:object): Promise<object>;
 /** Loads a text file from the game filesystem. */
 LoadGameFileText(path: string): Promise<string>;
 /** Loads a texture from the game filesystem and returns it as a data URL. */
 LoadGameFileTexture(path: string, maxSize: number): Promise<string>;
 /**
  * Loads and preprocesses file from game filesystem.
  *
  * @param config - JSON object of bool true/false entries: { drawTreeObjects, layerTerrain, layerCountlines, layerAir, layerTownNames, layerMountains, layerGrid, layerForest, layerRock, layerRoads, layerObjects, simpleRoads }
  * @returns The terrain as SVG image
  */
 LoadGameTerrain(config: object): Promise<string>;

 OnMessageFromGame(message: object): void;
}

function forwardMessageToApp(message: object): void {
    const { a } = message as { a?: unknown };

    if (typeof a !== "string" || a.length === 0) {
        console.warn("Message from game has no app target", message);
        return;
    }

    const handler = window.AppDirectory?.knownApps.get(a)?.module?.OnMessageFromGame;
    if (typeof handler !== "function") {
        console.warn(`No loaded TacPhone app can handle a message for "${a}"`, message);
        return;
    }

    try {
        const result = (handler as (message: object) => unknown)(message);

        if (result !== null && result !== undefined && typeof (result as { then?: unknown }).then === "function") {
            Promise.resolve(result).catch(error => {
                console.error(`TacPhone app "${a}" failed to handle a message:`, error);
            });
        }
    } catch (error) {
        console.error(`TacPhone app "${a}" failed to handle a message:`, error);
    }
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
                    resolve: (resultData): void => { resolve(JSON.parse(atob(resultData)))},
                    reject 
                }
                ))
                window.A3API.SendAlert(JSON.stringify({k: reqKey, d:data}))
        });
    }

    LoadGameFileText(path: string): Promise<string> {
        path = path.replaceAll("/", "\\");
        return window.A3API.RequestFile(path);
    }

    LoadGameFileTexture(path: string, maxSize: number): Promise<string> {
        if (path.startsWith("\\"))
            path = path.substring(1);

        return window.A3API.RequestTexture(path, maxSize);
    }

    LoadGameTerrain(config: object): Promise<string> {
        return window.A3API.RequestTerrainSVG(config);
    }

    OnMessageFromGame(message: object): void {
        // The game sent us a message, probably a notification about something
        // Forward it to the App its destined for
        console.log("Message from game", message);
        forwardMessageToApp(message);
    }

};

// 2. Decompress a Base64 string back to the original string
async function decompressFromBase64(base64Input: string): Promise<string> {
  // Reconstruct a full Data URL from the Base64 string
  const dataUrl = `data:application/octet-stream;base64,${base64Input}`;
  
  // Use fetch ONLY to convert the data URL into a Blob (this does not hit the network)
  const blob = await fetch(dataUrl).then(res => res.blob());

  // Use FileReader to safely read the blob as an ArrayBuffer
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  
  // Create a decompression stream using 'gzip'
  const stream = new Blob([buffer]).stream();
  const decompressionStream = new DecompressionStream("gzip");
  const decompressedStream = stream.pipeThrough(decompressionStream);
  
  // Read the decompressed stream into an ArrayBuffer
  const response = new Response(decompressedStream);
  const decompressedBuffer = await response.arrayBuffer();
  
  // Decode the ArrayBuffer back to a string
  return new TextDecoder().decode(decompressedBuffer);
}

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
        };

        this.socket.onmessage = (event) => {
            console.log(`[message] Data received from server: ${event.data}`);
            let jsonData = JSON.parse(event.data);
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
        };

        this.socket.onerror = (error) => {
            console.log(`[error] ${JSON.stringify(error)}`);
            this.rejectAllPendingRequests(new Error("Could not communicate with the TacPhone websocket"));

            if (!this.isReady && this.rejectReady) {
                this.rejectReady(new Error("Could not connect to the TacPhone websocket"));
                this.resolveReady = this.rejectReady = undefined;
            }
        };
    };

    WhenReady(): Promise<void> {
        // Retry the connection if the previous attempt failed or the connection has since closed.
        if (!this.isReady && this.resolveReady === undefined)
            this.connect();

        return this.readyPromise;
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
        forwardMessageToApp(message);
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


// Its a global, accessible to everyone
window.Networking = window.Networking || (IsArma() ? new NetworkingA3() : new NetworkingWebsocket());