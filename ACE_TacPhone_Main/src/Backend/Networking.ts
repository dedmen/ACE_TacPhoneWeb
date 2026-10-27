import "./A3API";

interface Networking {
 WhenReady(): Promise<void>;
 Request(params:object): Promise<object>;
 LoadGameFileText(path: string): Promise<string>;
 LoadGameFileTexture(path: string, maxSize: number): Promise<string>;
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

class NetworkingWebsocket implements Networking {
    requestCounter: number = 0;
    socket!: WebSocket;

    private readyPromise!: Promise<void>;
    private resolveReady: (() => void) | undefined;
    private rejectReady: ((reason?: unknown) => void) | undefined;
    private isReady = false;

    // We cannot use A3API's pendingRequests implementation, so we ship our own
    private pendingRequests: { [key: string]: Array<{resolve: (_:object)=>void, reject: (_:any)=>void}> } = {};
    _response(key: string, content: object) {
        if (!(key in this.pendingRequests)) return; // Request doesn't exist

        // Trigger all promises
        this.pendingRequests[key].forEach((e: any) => e.resolve(content));
        delete this.pendingRequests[key];
    }

    _push(key: string, d: {resolve: (_:object)=>void, reject: (_:any)=>void}) : boolean
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

            if (this.rejectReady) {
                this.rejectReady(new Error(`TacPhone websocket closed before connecting (code=${event.code})`));
                this.resolveReady = this.rejectReady = undefined;
            }
        };

        this.socket.onerror = (error) => {
            console.log(`[error] ${JSON.stringify(error)}`);

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
            let reqKey = this.GenerateRequestID();

            if (this._push(reqKey, 
                {
                    resolve, // resultData is already an object
                    reject 
                }
                ))
            {
                try {
                    console.log("send", {k: reqKey, d:data});
                    this.socket.send(JSON.stringify({k: reqKey, d:data}));
                } catch (error) {
                    console.error(error);
                }  
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
        return new Promise((resolve, _reject) => {
            this.Request({a: "main", c: "RequestTexture", path: path, maxSize: maxSize}).then(async result => {
                
                // MainApps/main.tsx OnMessageFromGame compressed it for us
                var decompressed = await decompressFromBase64(result as unknown as string);
                //#TODO handle failure when ingame phone isn't open
                resolve(decompressed);
            });
        });
    }

    LoadGameTerrain(config: object): Promise<string> {
        // Ask the webhost (the connected Arma client), to send us the terrain back
        return new Promise((resolve, _reject) => {
            this.Request({a: "main", c: "RequestTerrainSVG", config: config}).then(async result => {
                
                // MainApps/main.tsx OnMessageFromGame compressed it for us
                var decompressed = await decompressFromBase64(result as unknown as string);
                //#TODO handle failure when ingame phone isn't open
                resolve(decompressed);
            });
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
declare global {
    interface Window { Networking: Networking; }
}

window.Networking = window.Networking || (IsArma() ? new NetworkingA3() : new NetworkingWebsocket());