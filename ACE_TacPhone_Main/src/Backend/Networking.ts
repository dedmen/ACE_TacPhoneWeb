import "./A3API";

interface Networking {
 Request(params:object): Promise<object>;
 LoadGameFileText(path: string): Promise<string>;
 LoadGameFileTexture(path: string, maxSize: number): Promise<string>;
}



class NetworkingA3 implements Networking {
    requestCounter: number = 0;
    constructor() {
        console.log("NetworkStartup A3");
    };

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
        return window.A3API.RequestFile(path);
    }

    LoadGameFileTexture(path: string, maxSize: number): Promise<string>{
        return window.A3API.RequestTexture(path, maxSize);
    }
};


class NetworkingWebsocket implements Networking {
    requestCounter: number = 0;
    socket: WebSocket;

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

        // Establish websocket connection to our server

        let wsURL = IsLocalDev() ? `wss://localhost:8001/ws` : `wss://${window.location.host}/ws`;

        console.log(wsURL);
        this.socket = new WebSocket(wsURL);
        this.socket.onopen = () => {
            console.log("[open] Connection established");
        };

        this.socket.onmessage = (event) => {
            console.log(`[message] Data received from server: ${event.data}`);
            let jsonData = JSON.parse(event.data);
            console.log("recv", jsonData);
            this._response(jsonData.k, jsonData.d);
        };

        this.socket.onclose = function(event) {
            if (event.wasClean) {
                console.log(`[close] Connection closed cleanly, code=${event.code} reason=${event.reason}`);
            } else {
                // e.g. server process killed or network down
                // event.code is usually 1006 in this case
                console.log('[close] Connection died');
            }
        };

        this.socket.onerror = function(error) {
            console.log(`[error] ${JSON.stringify(error)}`);
        };
    };

    GenerateRequestID(): string {
        return `nr${this.requestCounter++}`;
    }

    Request(data:object): Promise<object> {

        // We are reusing the existing A3API for request/response

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
        return path; //#TODO request through websocket
    }


    //#TODO engine side needs to be able to load texture, currently only a webbrowser can do
    LoadGameFileTexture(path: string, maxSize: number): Promise<string>{
        return window.A3API.RequestTexture(path, maxSize);
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