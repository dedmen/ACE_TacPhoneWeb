
// This is a TS reimplementation of the JS A3API that the engine injects.
// This mirrors what the engine does, you better not change it

export class A3API {
  private pendingRequests: { [key: string]: Array<{resolve: (_:string)=>void, reject: (_:any)=>void}> } = {};

  _response(key: string, content: string) {
    if (!(key in this.pendingRequests)) return; // Request doesn't exist

    // Trigger all promises
    this.pendingRequests[key].forEach((e: any) => e.resolve(content));
    delete this.pendingRequests[key];
  }

  _push(key: string, d: {resolve: (_:string)=>void, reject: (_:any)=>void}) : boolean
  {
    const waiterList = (this.pendingRequests[key] = this.pendingRequests[key] || []);
    waiterList.push(d);
    return waiterList.length == 1; // First insert
  }

  /**
   * Loads file from game filesystem.
   *
   * @param filePath - Path in game filesystem, without leading backslash
   * @param maxSize - maximum texture width (used to select Mip)
   * @returns The file content as raw string
   */
  RequestTexture(texturePath: string, maxSize: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this._push(`t:${btoa(texturePath)};${maxSize}`, { resolve, reject })) // Only if new request, and not already queued
        this.SendAlert(`__A3TexReq;${texturePath};${maxSize}`);
    });
  }

  /**
   * Loads file from game filesystem.
   *
   * @param filePath - same as loadFile SQF command
   * @returns The file content as raw string
   */
  RequestFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this._push(`f:${btoa(filePath)}`, { resolve, reject }))
        this.SendAlert(`__A3FileReq;${filePath}`);
    });
  }

  /**
   * Loads and preprocesses file from game filesystem.
   *
   * @param filePath - same as preprocessFile SQF command
   * @returns The file content
   */
  RequestPreprocessedFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this._push(`fP:${btoa(filePath)}`, { resolve, reject }))
        this.SendAlert(`__A3FilePReq;${filePath}`);
    });
  }

  // Triggers a alert() (Needs to be piped due to https://chromestatus.com/feature/5148698084376576)
  SendAlert(content: string): void {
    window.parent.postMessage({ alert: content }, '*');
  }
  
  SendConfirm(content: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this._push(`confirm`, { resolve, reject }))
        window.parent.postMessage({ confirm: content }, '*');
    });
  }

  /**
 * Loads and preprocesses file from game filesystem.
 *
 * @param config - JSON object of bool true/false entries: { drawTreeObjects, layerTerrain, layerCountlines, layerAir, layerTownNames, layerMountains, layerGrid, layerForest, layerRock, layerRoads, layerObjects, simpleRoads }
 * @returns The terrain as SVG image  
 */
  RequestTerrainSVG(config: object): Promise<string> {
    return new Promise((resolve, reject) => {
      // The engine protocol replies to the fixed key `t:'k'`, so concurrent
      // calls share the first response. That is safe only because the host
      // currently requests the same terrain configuration every time, and
      // changing that configuration is not intended. If configs ever diverge,
      // this key must include the serialized config instead.
      if (this._push(`t:'k'`, { resolve, reject }))
        this.SendAlert(`__A3TerSVGReq;k;${btoa(JSON.stringify(config))}`);
    });
  }
}

declare global {
    interface Window {
        // Internal engine shim. Apps should use window.TacPhone.networking so
        // they keep working in external-browser mode.
        A3API: A3API;
    }
}

window.A3API = new A3API;