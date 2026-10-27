

interface AppPanelInfo {
    // Globally (across all panels) unique name of this one
    id: string;
    GetTacPhoneIcon(): string;
    GetDefaultTitle(): string;
    appComponent: React.ComponentClass;
}

interface AppModule {
    GetTacPhoneApps(): Array<AppPanelInfo>;
    OnMessageFromGame?(message: object): void | Promise<void>;
}

// Networking
interface Networking {
    WhenReady(): Promise<void>;
    Request(params: object): Promise<object>;
    LoadGameFileText(path: string): Promise<string>;
    LoadGameFileTexture(path: string, maxSize: number): Promise<string>;
    /**
     * Loads and preprocesses file from game filesystem.
     *
     * @param config - JSON object of bool true/false entries: { drawTreeObjects, layerTerrain, layerCountlines, layerAir, layerTownNames, layerMountains, layerGrid, layerForest, layerRock, layerRoads, layerObjects, simpleRoads }
     * @returns The terrain as SVG image  
     */
    LoadGameTerrain(config: object): Promise<string>;
}

declare global {
    interface Window {
        Networking: Networking;
    }
}

// A3API
export declare class A3API {
    private pendingRequests;
    _response(key: string, content: string): void;
    _push(key: string, d: {
        resolve: (_: string) => void;
        reject: (_: any) => void;
    }): boolean;
    /**
     * Loads file from game filesystem.
     *
     * @param filePath - Path in game filesystem, without leading backslash
     * @param maxSize - maximum texture width (used to select Mip)
     * @returns The file content as raw string
     */
    RequestTexture(texturePath: string, maxSize: number): Promise<string>;
    /**
     * Loads file from game filesystem.
     *
     * @param filePath - same as loadFile SQF command
     * @returns The file content as raw string
     */
    RequestFile(filePath: string): Promise<string>;
    /**
     * Loads and preprocesses file from game filesystem.
     *
     * @param filePath - same as preprocessFile SQF command
     * @returns The file content
     */
    RequestPreprocessedFile(filePath: string): Promise<string>;
    SendAlert(content: string): void;
    SendConfirm(content: string): Promise<string>;
    RequestTerrainSVG(config: object): Promise<string>;
}
declare global {
    interface Window {
        A3API: A3API;
    }
}

// AppDirectory
type AppInfo = {
    devfile: string;
    file: string;
    module: AppModule;
    panels: Array<AppPanelInfo>;
};
declare class AppDirectory {
    knownApps: Map<string, AppInfo>;
    knownPanels: Map<string, AppPanelInfo>;
    failedApps: Map<string, string>;
    constructor();
    private fetchExternalModule;
    private getModule;
    private parseAppData;
    private parseAppInfo;
    private validatePanels;
    LoadAvailableApps(): Promise<void>;
}
declare global {
    interface Window {
        AppDirectory: AppDirectory;
    }
}

export type CommandHandler = (payload: object) => void;
export declare class CommandRegistry {
    private registry;
    /**
     * Registers a callback for a specific action.
     * @returns A cleanup function to unregister this specific listener.
     */
    register(action: string, handler: CommandHandler): () => void;
    /**
     * Parses a raw WebSocket message string and routes it to all matching subscribers.
     */
    routeMessage(packet: {
        c: string;
    }): void;
    /**
     * Purges all subscribers across all commands.
     */
    clear(): void;
}
declare global {
    interface Window {
        TacPhoneUtils: {
            CommandRegistry: typeof CommandRegistry;
        };
    }
}
