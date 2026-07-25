import "./A3API";

interface Networking {
 Request(params:object): Promise<object>;
 LoadGameFileText(path: string): Promise<string>;
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
        console.log(`ws://${window.location.host}/ws`);
        this.socket = new WebSocket(`wss://${window.location.host}/ws`);
        //this.socket = new WebSocket(`ws://localhost:8001/ws`, null, null, null, {rejectUnauthorized: false});

        this.socket.onopen = () => {
            console.log("[open] Connection established");
        };

        this.socket.onmessage = (event) => {
            console.log(`[message] Data received from server: ${event.data}`);
            let jsonData = JSON.parse(event.data);
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
              

            try {
                this.socket.send(JSON.stringify({k: reqKey, d:data}));
            } catch (error) {
                console.error(error);
            }       
        });
    }

    async LoadGameFileText(path: string): Promise<string> {
        return path; //#TODO request through websocket
    }


};



// Its a global, accessible to everyone
declare global {
    interface Window { Networking: Networking; }
}

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
    return window.location.href.includes("localhost:4000");
}

window.Networking = window.Networking || (IsArma() ? new NetworkingA3() : new NetworkingWebsocket());