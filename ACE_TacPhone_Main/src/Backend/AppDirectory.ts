// Host-side directory of the installed apps and their panels.
//
// The game (request `{a:"main", c:"GetAvailableApps"}`) returns one metadata
// entry per app: `{ file, devfile, icon }`. Each app module is loaded from its
// packaged file (or from the dev server), must export the same `apiVersion` as
// `@ace-tacphone/api`, and reports its panels through `GetTacPhoneApps()`.
//
// Every app is loaded independently: one broken app becomes an entry of
// `failedApps` instead of preventing the rest of the phone from starting.
//
// Display metadata (title and icon) is resolved once per panel and cached, so
// re-rendering the app chooser or restoring a layout does not re-run app code or
// re-request textures.

import { TACPHONE_API_VERSION } from "@ace-tacphone/api";
import type { AppCatalog, AppInfo, AppModule, AppPanelInfo, PanelMeta } from "@ace-tacphone/api";

import { IsLocalDev, networking, IsArma } from "./Networking";
import { GetTacPhoneHost } from "./Host";

/**
 * Icon URL prefixes that can be used directly as `<img src>` values.
 * 
 * In the in-game browser (sandboxed Chromium 126), external URLs cannot load:
 * - `http:` and `https:` are blocked by the sandbox
 * - Protocol-relative `//` URLs also fail because there's no network access
 * 
 * Only these work inside Arma:
 * - `data:` - embedded data URIs (for example SVG or PNG)
 * - `blob:` - blob URLs created in this page
 */
const DIRECT_ICON_PREFIXES = ["data:", "blob:"];

/** External URL prefixes; only usable outside the sandboxed in-game browser. */
const EXTERNAL_ICON_PREFIXES = ["http:", "https:", "//"];

/** Maximum texture width requested for a panel icon. */
const ICON_MAX_SIZE = 512;

/**
 * How long a load waits for panel icons before reporting the app list.
 * Icons resolve in the background; the wait only gives a restored layout its
 * icons on first paint instead of re-setting them after the first render.
 */
const ICON_LOAD_WAIT_MS = 2000;

type AppInfoSource = Pick<AppInfo, "devfile" | "file">;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * True for values an `img` element can load directly, without going through the game.
 * 
 * This is environment-aware: inside Arma's sandboxed browser, external URLs (http:, https:, //)
 * cannot be loaded due to security restrictions. Only data: and blob: work in-game.
 */
function isDirectIcon(value: string): boolean {
    const lower = value.toLowerCase();

    // Always allow data: and blob: regardless of environment.
    if (DIRECT_ICON_PREFIXES.some(prefix => lower.startsWith(prefix)))
        return true;

    // Outside Arma, http:, https:, and protocol-relative URLs are allowed.
    return !IsArma() && isExternalIcon(lower);
}

/** True for URL schemes that need Internet access. */
function isExternalIcon(value: string): boolean {
    const lower = value.toLowerCase();
    return EXTERNAL_ICON_PREFIXES.some(prefix => lower.startsWith(prefix));
}

export class AppDirectory implements AppCatalog {
    knownApps: Map<string, AppInfo>;
    knownPanels: Map<string, AppPanelInfo>;
    failedApps: Map<string, string>;

    private readonly moduleCache: Map<string, Promise<AppModule>>;
    /** Reverse of knownPanels: panel id -> name of the app that provides it. */
    private readonly panelOwners: Map<string, string>;
    /** Icon field of the app metadata returned by the game, per app name. */
    private readonly appIcons: Map<string, string>;
    /** Cached display data, per panel id, resolved once on registration. */
    private readonly panelMeta: Map<string, PanelMeta>;
    /** Icon resolution per panel id, so an icon is requested only once. */
    private readonly iconPromises: Map<string, Promise<string | undefined>>;
    private readonly listeners: Set<(panels: PanelMeta[]) => void>;
    /** In-flight LoadAvailableApps() call; concurrent callers share it. */
    private loading: Promise<void> | undefined;

    constructor(){
        this.knownApps = new Map();
        this.knownPanels = new Map();
        this.failedApps = new Map();
        this.moduleCache = new Map();
        this.panelOwners = new Map();
        this.appIcons = new Map();
        this.panelMeta = new Map();
        this.iconPromises = new Map();
        this.listeners = new Set();
    }

    private async fetchExternalModule(name: string, appInfo: AppInfoSource): Promise<any> {
        // This should be same result as import(name)
        // But the module might be in different places
        // In development, module 'testModule' might be ../../testModule (A npm package, with package.json defining what we should load)
        // In Arma, it would be in A3API.RequestFile('/z/ace/addons/tacphone/apps/X.js')
        // In WebBrowser proxy mode, it would be networking.LoadGameFileText(/z/ace/addons/tacphone/apps/X.js')
        // Note in the Arma paths, we always need a lookup table, mod's modules will not all be in ace folders.

        if (IsLocalDev()) {
            // The host dev server maps /devapps/<app name>/ to the app folder.
            // The folder can be next to this package, or anywhere listed in
            // dev-apps.local.json / TACPHONE_DEV_APPS. See README.md.
            const devfile = (appInfo.devfile || "src/main.tsx")
                .replaceAll("\\", "/")
                .replace(/^\/+/, "");
            const devUrl = `/devapps/${encodeURIComponent(name)}/${devfile}`;

            try {
                return await import(/* @vite-ignore */ devUrl);
            } catch (error) {
                throw new Error(
                    `Failed to load development app "${name}" from "${devUrl}". `
                    + "Check that the app folder is exposed by the host dev server "
                    + "(see ACE_TacPhone_Main/README.md#developing-apps).",
                    { cause: error },
                );
            }
        }

        // Either Arma or Web proxy, networking will handle whichever it is

        //#TODO we need a global module/app directory, where we can look up from classname to in-game path
        const content = await networking.LoadGameFileText(appInfo.file); //  `/z/ace/addons/tacphone/apps/${name}.js`
        // Store it in a blob url and then return it
        const url = URL.createObjectURL(new Blob([content], {type: 'application/javascript'}));
        return import(/* @vite-ignore */ url);
    }

    private getModule(name: string, appInfo: AppInfoSource): Promise<AppModule> {
        // In development the module is loaded by app name, in production by its packaged file.
        const cacheKey = name === "main" ? "builtin:main" : (IsLocalDev() ? `dev:${name}` : `file:${appInfo.file}`);

        let modulePromise = this.moduleCache.get(cacheKey);
        if (!modulePromise) {
            modulePromise = (name === "main"
                ? import('../MainApps/main')
                : this.fetchExternalModule(name, appInfo)) as Promise<AppModule>;

            this.moduleCache.set(cacheKey, modulePromise);

            // Don't cache failures forever; a later reload should be able to retry this app.
            modulePromise.catch(() => {
                if (this.moduleCache.get(cacheKey) === modulePromise)
                    this.moduleCache.delete(cacheKey);
            });
        }

        return modulePromise;
    }

    private parseAppData(raw: unknown): Record<string, unknown> {
        // The game returns a hashmap; the transport serializes and deserializes it for us.
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            throw new Error("GetAvailableApps returned an unexpected value; expected an object keyed by app name");

        return raw as Record<string, unknown>;
    }

    private parseAppInfo(name: string, raw: unknown): AppInfoSource & { icon: string } {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            throw new Error(`App "${name}" has invalid metadata`);

        const data = raw as Record<string, unknown>;
        const file = typeof data.file === "string" ? data.file : "";
        const devfile = typeof data.devfile === "string" ? data.devfile : "";
        const icon = typeof data.icon === "string" ? data.icon : "";

        if (name !== "main" && file.length === 0)
            throw new Error(`App "${name}" does not define a file to load`);

        return { file, devfile, icon };
    }

    private validatePanels(appName: string, panels: unknown): Array<AppPanelInfo> {
        if (!Array.isArray(panels))
            throw new Error(`App "${appName}" GetTacPhoneApps() must return an array`);

        return panels.map((panel, index) => {
            if (typeof panel !== "object" || panel === null || Array.isArray(panel))
                throw new Error(`App "${appName}" panel at index ${index} is not an object`);

            const candidate = panel as Partial<AppPanelInfo>;

            if (typeof candidate.id !== "string" || candidate.id.length === 0)
                throw new Error(`App "${appName}" panel at index ${index} has no valid id`);

            if ((typeof candidate.appComponent !== "function" && typeof candidate.appComponent !== "object") || candidate.appComponent === null)
                throw new Error(`App "${appName}" panel "${candidate.id}" has no valid appComponent`);

            if (candidate.GetTacPhoneIcon !== undefined && typeof candidate.GetTacPhoneIcon !== "function")
                throw new Error(`App "${appName}" panel "${candidate.id}" has an invalid GetTacPhoneIcon()`);

            if (candidate.GetDefaultTitle !== undefined && typeof candidate.GetDefaultTitle !== "function")
                throw new Error(`App "${appName}" panel "${candidate.id}" has an invalid GetDefaultTitle()`);

            return candidate as AppPanelInfo;
        });
    }

    /**
     * Loads (or reloads) every app the game reports.
     *
     * Concurrent calls share one load, so mounting the host twice in
     * development (StrictMode) cannot load an app module twice.
     */
    LoadAvailableApps(): Promise<void> {
        if (this.loading)
            return this.loading;

        let run: Promise<void>;
        run = this.loadApps().finally(() => {
            if (this.loading === run)
                this.loading = undefined;
        });

        this.loading = run;
        return run;
    }

    private async loadApps(): Promise<void> {
        const host = GetTacPhoneHost();

        await host.networking.WhenReady();

        const appData = this.parseAppData(await host.networking.Request({a: "main", c: "GetAvailableApps"}));
        const entries = Object.entries(appData);

        // Reset the directory so a retry does not leave stale apps/panels behind.
        this.knownApps = new Map();
        this.knownPanels = new Map();
        this.panelMeta.clear();
        this.panelOwners.clear();
        this.appIcons.clear();
        this.iconPromises.clear();

        // Load every app in parallel. One broken app must not prevent the rest from starting.
        const results = await Promise.allSettled(entries.map(async ([name, rawInfo]) => {
            const { icon, ...appInfoSource } = this.parseAppInfo(name, rawInfo);
            const module = await this.getModule(name, appInfoSource);

            if (typeof module?.GetTacPhoneApps !== "function")
                throw new Error(`App "${name}" does not export GetTacPhoneApps()`);

            this.checkApiVersion(name, module);
            await module.init?.();

            const panels = this.validatePanels(name, await module.GetTacPhoneApps());

            const appInfo: AppInfo = {
                ...appInfoSource,
                module,
                panels
            };

            return { name, appInfo, icon };
        }));

        const failedApps = new Map<string, string>();

        results.forEach((result, index) => {
            const name = entries[index][0];

            if (result.status === "rejected") {
                const message = errorMessage(result.reason);
                console.error(`Failed to load TacPhone app "${name}":`, result.reason);
                failedApps.set(name, message);
                return;
            }

            const { appInfo, icon } = result.value;
            this.knownApps.set(name, appInfo);

            if (icon.length > 0)
                this.appIcons.set(name, icon);

            appInfo.panels.forEach(panel => {
                if (this.knownPanels.has(panel.id))
                    console.warn(`TacPhone panel id "${panel.id}" from app "${name}" is already registered; overwriting it.`);

                this.knownPanels.set(panel.id, panel);
                this.panelOwners.set(panel.id, name);
                this.cachePanelMeta(name, panel);
            });
        });

        this.failedApps = failedApps;

        await this.settleIcons(ICON_LOAD_WAIT_MS);
        this.notifyChanged();
    }

    /**
     * Waits for the pending icon loads, but never longer than `timeoutMs`:
     * a slow or missing game texture must not hold up the app list.
     */
    private async settleIcons(timeoutMs: number): Promise<void> {
        const pending = [...this.iconPromises.values()];
        if (pending.length === 0)
            return;

        let timer: number | undefined;
        const deadline = new Promise<void>(resolve => {
            timer = window.setTimeout(resolve, timeoutMs);
        });

        try {
            await Promise.race([Promise.allSettled(pending), deadline]);
        } finally {
            if (timer !== undefined)
                window.clearTimeout(timer);
        }
    }

    /** Rejects an app that was built against a different host contract. */
    private checkApiVersion(name: string, module: AppModule): void {
        const version: unknown = module.apiVersion;

        if (version === TACPHONE_API_VERSION)
            return;

        if (typeof version !== "number")
            throw new Error(
                `App "${name}" does not export "apiVersion"; apps must target TacPhone API version ${TACPHONE_API_VERSION}.`
            );

        throw new Error(
            `App "${name}" targets TacPhone API version ${version}, but this host implements version ${TACPHONE_API_VERSION}. `
            + "Rebuild the app against the matching @ace-tacphone/api."
        );
    }

    /** Resolves and caches the display data of one panel; never throws for an app. */
    private cachePanelMeta(appName: string, panel: AppPanelInfo): void {
        this.panelMeta.set(panel.id, {
            id: panel.id,
            appName,
            title: this.panelTitle(panel)
        });

        // Icons may need a texture round-trip, so they resolve in the background
        // and are cached; the meta entry is updated in place once known.
        this.iconPromises.set(panel.id, this.resolvePanelIcon(appName, panel));
    }

    /** Default title of a panel, resolved once; the panel id is the fallback. */
    private panelTitle(panel: AppPanelInfo): string {
        try {
            const title: unknown = panel.GetDefaultTitle?.();
            if (typeof title === "string" && title.length > 0)
                return title;
        } catch (error) {
            console.error(`TacPhone panel "${panel.id}" failed in GetDefaultTitle():`, error);
        }

        return panel.id;
    }

    /**
     * Resolves the icon of one panel: a data/blob value is used as-is, external URLs
     * (http:, https:, //) are only allowed outside Arma's sandbox, and the app metadata
     * icon is the fallback. Never rejects.
     */
    private async resolvePanelIcon(appName: string, panel: AppPanelInfo): Promise<string | undefined> {
        const declared = await this.declaredIcon(panel);
        const resolved = await this.loadIcon(declared) ?? await this.loadIcon(this.appIcons.get(appName));

        if (resolved) {
            const meta = this.panelMeta.get(panel.id);
            if (meta) {
                meta.icon = resolved;
                this.notifyChanged();
            }
        }

        return resolved;
    }

    /** Value returned by an app's GetTacPhoneIcon(), if it has one. */
    private async declaredIcon(panel: AppPanelInfo): Promise<string | undefined> {
        if (typeof panel.GetTacPhoneIcon !== "function")
            return undefined;

        try {
            const icon: unknown = await panel.GetTacPhoneIcon();
            return typeof icon === "string" && icon.length > 0 ? icon : undefined;
        } catch (error) {
            console.warn(`TacPhone panel "${panel.id}" failed in GetTacPhoneIcon():`, error);
            return undefined;
        }
    }

    /**
     * Turns an icon value into something an `img` can show; undefined on failure.
     * 
     * In Arma's sandboxed browser, external URLs (http:, https:, //) cannot be loaded.
     * Such values return undefined so the app metadata icon fallback runs instead.
     */
    private async loadIcon(value: string | undefined): Promise<string | undefined> {
        if (!value)
            return undefined;

        // data:/blob: work everywhere; http(s) only outside the in-game browser.
        if (isDirectIcon(value))
            return value;

        // In-game the sandbox has no network access. Do not send an external URL
        // to LoadGameFileTexture as if it were a game path; fall back instead.
        if (isExternalIcon(value)) {
            console.warn(
                `TacPhone cannot load the external icon "${value}" inside the in-game browser; `
                + 'use a data:, blob:, or game texture path.',
            );
            return undefined;
        }

        try {
            const texture = await networking.LoadGameFileTexture(value, ICON_MAX_SIZE);
            return typeof texture === "string" && texture.length > 0 ? texture : undefined;
        } catch (error) {
            console.warn(`TacPhone failed to load the icon "${value}" from the game:`, error);
            return undefined;
        }
    }

    /**
     * Cached display data of one panel, or undefined when the panel is unknown.
     * The icon is present once it was resolved.
     */
    getPanelMeta(panelId: string): PanelMeta | undefined {
        return this.panelMeta.get(panelId);
    }

    /** Every registered panel, with cached display data. */
    listPanels(): PanelMeta[] {
        return this.knownPanels.size === 0 ? [] : [...this.panelMeta.values()];
    }

    /**
     * Awaitable icon of one panel, for UI that needs it before rendering.
     * Resolves to undefined for an unknown panel or when the icon cannot load.
     */
    resolvePanelIconAsync(panelId: string): Promise<string | undefined> {
        const cached = this.panelMeta.get(panelId)?.icon;
        if (cached)
            return Promise.resolve(cached);

        const pending = this.iconPromises.get(panelId);
        return pending ?? Promise.resolve(undefined);
    }

    /** Subscribes to changes of the app/panel catalog. Returns an unsubscribe function. */
    onDidChange(listener: (panels: PanelMeta[]) => void): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Notifies the listeners with a fresh panel list; listener failures are contained. */
    private notifyChanged(): void {
        if (this.listeners.size === 0)
            return;

        const panels = this.listPanels();

        for (const listener of [...this.listeners]) {
            try {
                listener(panels);
            } catch (error) {
                console.error("TacPhone app directory listener failed:", error);
            }
        }
    }

    /**
     * Returns the name of the app that provides the given panel id, if any.
     * Used by the panel directory to report which app runs in an open panel.
     */
    appNameForPanel(panelId: string): string | undefined {
        return this.panelOwners.get(panelId);
    }

    /** Icon of an app: the resolved icon of its first panel. */
    appIcon(appName: string | undefined): string | undefined {
        if (!appName)
            return undefined;

        const panel = this.knownApps.get(appName)?.panels?.[0];
        return panel ? this.panelMeta.get(panel.id)?.icon : undefined;
    }
}

/** The one app directory of this page. */
export const appDirectory = new AppDirectory();
