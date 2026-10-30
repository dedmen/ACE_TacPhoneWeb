// Public app-facing contract of the TacPhone host.
//
// This package is the single source of truth for the API that apps consume.
// It intentionally contains only type declarations and small runtime
// constants: it must never import host implementation code.

import './globals';

import type { ComponentType, Context } from 'react';

/** Version of the app-facing contract. Every app must export the same value. */
export const TACPHONE_API_VERSION = 1;

/** React component type used for panels. */
export type AppComponent = ComponentType<AppProps>;

/** Props passed to every app panel component. */
export interface AppProps {
    /** Name of the app that owns this panel, as registered in the game. */
    appId: string;
    /** Stable id of the app panel (AppPanelInfo.id). */
    panelId: string;
    /** flexlayout TabNode, intentionally opaque. */
    node: unknown;
    /** flexlayout Model, intentionally opaque. */
    model: unknown;
    /** Live handle of the panel this content is rendered in. */
    panel: PanelInstance;
}

/** One panel an app registers with GetTacPhoneApps(). */
export interface AppPanelInfo {
    /** Globally unique id, persisted in saved layouts. */
    id: string;
    /** Component rendered inside the panel. */
    appComponent: AppComponent;
    /** Default tab title; may be refined through PanelInstance.setTitle(). */
    GetDefaultTitle?(): string;
    /** Icon URL/path; may resolve asynchronously. */
    GetTacPhoneIcon?(): string | Promise<string>;
}

/** Module contract every app entry point exports. */
export interface AppModule {
    /** Required; checked for exact equality against TACPHONE_API_VERSION. */
    apiVersion: number;
    /** Optional one-time setup, called before GetTacPhoneApps(). Apps read `window.TacPhone` directly. */
    init?(): void | Promise<void>;
    /** Returns the panels this app provides. Apps read `window.TacPhone` directly. */
    GetTacPhoneApps(): Array<AppPanelInfo> | Promise<Array<AppPanelInfo>>;
    /** Exactly one message handler per app; route payloads with CommandRegistry. */
    OnMessageFromGame?(message: object): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/** The single app-facing host object, exposed as `window.TacPhone`. */
export interface TacPhoneHost {
    apiVersion: number;
    reactVersion: string;
    networking: Networking;
    apps: AppCatalog;
    panels: PanelDirectoryApi;
    interApp: InterAppRegistry;
    interests: InterestRegistryApi;
    notifications: NotificationCenterApi;
    utils: TacPhoneUtils;
}

/** Cached display data of one registered panel. */
export interface PanelMeta {
    /** AppPanelInfo.id. */
    id: string;
    /** Name of the app that provides the panel. */
    appName: string;
    /** Resolved tab title. */
    title: string;
    /** Resolved icon URL, if the panel has one. */
    icon?: string;
}

/** Read-only view of the apps and panels the host knows about. */
export interface AppCatalog {
    /** Successfully loaded apps, keyed by app name. */
    readonly knownApps: ReadonlyMap<string, AppInfo>;
    /** All registered panels, keyed by AppPanelInfo.id. */
    readonly knownPanels: ReadonlyMap<string, AppPanelInfo>;
    /** Apps that failed to load, keyed by app name, mapped to the error message. */
    readonly failedApps: ReadonlyMap<string, string>;
    /** Name of the app that provides the given panel id, if any. */
    appNameForPanel(panelId: string): string | undefined;
    /** Cached title/icon of one panel. */
    getPanelMeta(panelId: string): PanelMeta | undefined;
    /** Every registered panel, with cached display data. */
    listPanels(): PanelMeta[];
    /** Reloads the app list from the game. */
    LoadAvailableApps(): Promise<void>;
}

/** One successfully loaded app. */
export interface AppInfo {
    /** Development entry file, relative to the app folder. */
    devfile: string;
    /** Packaged entry file inside the game PBO. */
    file: string;
    module: AppModule;
    panels: Array<AppPanelInfo>;
}

/** Rectangle in the coordinates of the layout that contains the panel. */
export interface PanelRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** How PanelDirectoryApi.open() places a new panel. */
export type PanelPlacement = 'float' | 'tab';

/** Options for PanelDirectoryApi.open(). */
export interface OpenPanelOptions {
    /** "float" (default) opens a floating popup, "tab" adds a docked tab. */
    placement?: PanelPlacement;
    /** Select the new tab. Default true. */
    select?: boolean;
    /** "tab" only: target tabset id. Defaults to the active tabset, then the first one. */
    tabsetId?: string;
    /** "float" only: popup rectangle; individual fields override the default placement. */
    rect?: Partial<PanelRect>;
    /** Stored in the tab config, so it is persisted with the layout. */
    config?: unknown;
}

/** Result of a successful PanelDirectoryApi.open(). */
export interface OpenPanelResult {
    /** Id of the created tab node. */
    tabId: string;
    /** Main layout id for "tab", the sub-layout id for "float". */
    layoutId: string;
    /** Id of the tabset that now holds the new tab. */
    tabSetId: string;
}

/** Snapshot of one open panel. */
export interface PanelInfo {
    /** Present only while the tab content is mounted. */
    instanceId?: string;
    /** Id of the tab node; stable across layout save/load. */
    tabId: string;
    /** Id of the tabset that holds the tab; undefined for border tabs. */
    tabSetId?: string;
    /** Main layout id or the id of a floating/window sub-layout. */
    layoutId: string;
    /** AppPanelInfo.id; undefined for an unassigned app chooser tab. */
    panelId?: string;
    /** App name that owns panelId. */
    appName?: string;
    /** Tab title (a user rename wins), falling back to the panel default title. */
    title: string;
    /** True while a PanelInstance exists for this tab. */
    mounted: boolean;
    /** True when this is the selected tab of its tabset. */
    isSelected: boolean;
    /** True when this tab's tabset is the active/focused tabset of its layout. */
    isActive: boolean;
    /** True while the tab content is rendered. */
    isVisible: boolean;
    /** True when the panel lives in a floating popup sub-layout. */
    isFloating: boolean;
    /** True when the panel lives in a native window popout sub-layout. */
    isPoppedOut: boolean;
    /** Rect of the tabset in the coordinates of its own layout. */
    rect: PanelRect;
    /** rect.width * rect.height. */
    area: number;
}

/** Live handle for one mounted app content. */
export interface PanelInstance {
    /** Host counter id, e.g. "panel-7"; new on every mount. */
    readonly instanceId: string;
    /** Tab the content is rendered in. */
    readonly tabId: string;
    /** Current snapshot of this panel. */
    getInfo(): PanelInfo;
    /** Persisted config of the tab, as stored in the saved layout. */
    getConfig(): unknown;
    /** Selects the tab and focuses its tabset (and brings a popup to the front). */
    activate(): boolean;
    /** Switches the app shown in the tab; undefined means "no app assigned". */
    setApp(panelId: string | undefined): void;
    /** Updates the tab title. */
    setTitle(title: string): void;
    /** Updates the tab icon. */
    setIcon(icon: string): void;
}

/** Directory of the open panels of the current layout. */
export interface PanelDirectoryApi {
    /** Every open panel: the main layout, its borders, and every sub-layout. */
    list(): PanelInfo[];
    /** Snapshot of the panel of one mounted instance. */
    get(instanceId: string): PanelInfo | undefined;
    /** Every panel that runs the given app panel id, in no particular order. */
    find(panelId: string): PanelInfo[];
    /** The last focused tab, following the user across layouts. */
    focused(): PanelInfo | undefined;
    /** The biggest panel of the main layout, optionally restricted to one panel id. */
    largest(panelId?: string): PanelInfo | undefined;
    /** Selects the tab of the given instance and makes its tabset active. */
    activate(instanceId: string): boolean;
    /** Opens the given app panel as a docked tab or floating popup. */
    open(panelId: string, options?: OpenPanelOptions): OpenPanelResult | undefined;
    /** Subscribes to panel changes. Returns an unsubscribe function. */
    onDidChange(listener: (panels: PanelInfo[]) => void): () => void;
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/** Transport between the page and the game. */
export interface Networking {
    WhenReady(): Promise<void>;
    Request(params: object): Promise<object>;
    /**
     * Subscribes to transport connectivity. The listener receives true when the
     * transport becomes usable and false when it goes away. The returned function
     * unsubscribes.
     */
    OnConnectionChange(listener: (connected: boolean) => void): () => void;
    /** Loads a text file from the game filesystem. */
    LoadGameFileText(path: string): Promise<string>;
    /** Loads a texture from the game filesystem and returns it as a data URL. */
    LoadGameFileTexture(path: string, maxSize: number): Promise<string>;
    /** Loads and preprocesses terrain data from the game filesystem as SVG. */
    LoadGameTerrain(config: object): Promise<string>;
    OnMessageFromGame(message: object): void;
}

// ---------------------------------------------------------------------------
// Game message routing
// ---------------------------------------------------------------------------

export type CommandHandler = (payload: object) => void;

/** Per-app registry that routes game messages by their `c` field. */
export interface CommandRegistry {
    /**
     * Registers a callback for a specific action.
     * @returns A cleanup function to unregister this specific listener.
     */
    register(action: string, handler: CommandHandler): () => void;
    /** Routes a raw game message to all matching subscribers. */
    routeMessage(packet: { c: string }): void;
    /** Purges all subscribers across all commands. */
    clear(): void;
}

/** Constructor of CommandRegistry, provided by the host. */
export interface CommandRegistryConstructor {
    new (): CommandRegistry;
}

/** Miscellaneous host-provided helpers. */
export interface TacPhoneUtils {
    CommandRegistry: CommandRegistryConstructor;
    /** Live handle of the panel an app content is rendered in. */
    PanelContext: Context<PanelInstance | undefined>;
    /** Hook that returns the panel the calling component is rendered in. */
    usePanel(): PanelInstance | undefined;
    /** Gzip-compresses a string and returns it as base64. */
    compressAndToBase64(text: string): Promise<string>;
    /** Decompresses base64 produced by compressAndToBase64. */
    decompressFromBase64(base64: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Runs when a notification is tapped; may be async. */
export type NotificationTapHandler = (
    notification: TacPhoneNotification,
) => void | Promise<void>;

/** The tap action of a notification. */
export type NotificationAction = NotificationTapHandler;

/** Options accepted by NotificationCenterApi.show(). */
export interface NotificationOptions {
    title: string;
    body?: string;
    /** App name, used to resolve the default app icon. */
    app?: string;
    /** Explicit icon URL; overrides the app icon. */
    icon?: string;
    /** Milliseconds; 0 = permanent until dismissed. Default 15000. */
    duration?: number;
    /** Arbitrary payload available to the tap handler on the stored notification. */
    data?: unknown;
    /** Runs when the notification is tapped. */
    action?: NotificationAction;
}

/** Stored notification; what subscribers render. */
export interface TacPhoneNotification extends NotificationOptions {
    id: string;
    createdAt: number;
    /** True while the exit animation runs; the store removes it afterwards. */
    closing?: boolean;
}

/** Host notification stack (phone-style banners). */
export interface NotificationCenterApi {
    /** Current immutable snapshot; the reference changes on every change. */
    getSnapshot(): readonly TacPhoneNotification[];
    /** Subscribes to snapshot changes; returns the unsubscribe function. */
    subscribe(
        listener: (notifications: readonly TacPhoneNotification[]) => void,
    ): () => void;
    /** Shows a notification and returns its id. */
    show(options: NotificationOptions): string;
    /** Starts the exit animation of one notification and removes it afterwards. */
    dismiss(id: string): void;
    /** Removes every notification immediately, without the exit animation. */
    clear(): void;
}

// ---------------------------------------------------------------------------
// Data interests
// ---------------------------------------------------------------------------

/** Reference-counted registry of game data interests. */
export interface InterestRegistryApi {
    /**
     * Adds one reference to an interest. The returned disposer is idempotent.
     */
    acquire(interest: string): () => void;
    /** True while this page holds at least one reference to the interest. */
    isActive(interest: string): boolean;
    /** Every interest this page currently holds, in acquisition order. */
    list(): string[];
    /** Subscribes to changes of the held set. Returns an unsubscribe function. */
    onDidChange(listener: (interests: string[]) => void): () => void;
}

// ---------------------------------------------------------------------------
// Inter-app services
// ---------------------------------------------------------------------------

/** One service registration of one mounted panel. */
export interface InterAppRegistration<T = unknown> {
    /** Stable, app-chosen, lowercase service name: "map", "messenger", ... */
    service: string;
    /** Integer major version of the API. */
    version: number;
    /** What other apps receive from resolve()/resolveAll()/getApi(). */
    api: T;
}

/** One registered provider of a service, with a fresh snapshot of its panel. */
export interface AppServiceInfo {
    /** Service name the panel registered. */
    service: string;
    /** Version the panel registered. */
    version: number;
    /** Fresh PanelInfo of the panel that provides the API. */
    instance: PanelInfo;
    /** The api passed to register(). */
    api: unknown;
}

/** How resolve()/resolveAsync() pick between several panels of the same service. */
export type TargetPolicy = 'auto' | 'focused' | 'largest' | 'first' | 'ask';

/** What to route to: one service, optionally narrowed to a version, panel or instance. */
export interface TargetOptions {
    /** Service to find, e.g. "map". */
    service: string;
    /** Default "auto": focused panel, then the largest, then the only candidate. */
    policy?: TargetPolicy;
    /** Requested major version; without it the highest registered version wins. */
    version?: number;
    /** Restrict candidates to one app panel id, e.g. "ACE_TacPhone_Map". */
    panelId?: string;
    /** Explicit target; wins over the policy. Accepts an instance id or a tab id. */
    instanceId?: string;
    /** Open the app when no panel provides it yet. Needs panelId. */
    openIfMissing?: boolean;
    /** Placement used with openIfMissing; default "float". */
    placement?: PanelPlacement;
    /** Activate the target panel before returning and waiting. Default true. */
    activate?: boolean;
    /** How long to wait for a panel to mount and register its API. Default 3000. */
    waitMs?: number;
}

/** Asks the user (or host) which panel should receive a request. */
export type TargetChooser = (
    request: { service: string; candidates: PanelInfo[]; reason?: string },
) => Promise<string | undefined> | string | undefined;

/** Registry of the APIs apps expose to each other, with target routing. */
export interface InterAppRegistry {
    /**
     * Registers the API of one mounted panel.
     *
     * Call it from the app lifecycle with the instance delivered through
     * AppProps.panel / usePanel(), and call the returned function on unmount.
     */
    register(instance: PanelInstance, registration: InterAppRegistration): () => void;
    /** Every registered service, optionally restricted to one service name. */
    list(service?: string): AppServiceInfo[];
    /** Synchronous lookup of an already registered service. */
    resolve(target: string | TargetOptions): AppServiceInfo | undefined;
    /** Every registered provider that matches the filters of the target. */
    resolveAll(target: TargetOptions): AppServiceInfo[];
    /** Routing entry point: find, mount, activate and wait for a service. */
    resolveAsync(
        target: TargetOptions,
        reason?: string,
    ): Promise<AppServiceInfo | undefined>;
    /** Convenience wrapper around resolve(): the API of a mounted service. */
    getApi<T>(service: string, options?: TargetOptions): T | undefined;
    /** Calls one method of a service after routing to a provider. */
    call<T>(service: string, method: string, ...args: unknown[]): Promise<T>;
    /** Installs the handler policy "ask" calls to let the user pick a panel. */
    setTargetChooser(chooser: TargetChooser | undefined): void;
    /** Subscribes to registration and panel changes. Returns an unsubscribe function. */
    onDidChange(listener: (services: AppServiceInfo[]) => void): () => void;
}
