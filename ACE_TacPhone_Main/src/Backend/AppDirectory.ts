import { IsLocalDev } from "./Networking";
import type { AppInfo, AppModule, AppPanelInfo } from "./Types";

type AppInfoSource = Pick<AppInfo, "devfile" | "file">;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class AppDirectory
{
    knownApps: Map<string, AppInfo>;
    knownPanels: Map<string, AppPanelInfo>;
    failedApps: Map<string, string>;

    private moduleCache: Map<string, Promise<AppModule>>;
    /** Reverse of knownPanels: panel id -> name of the app that provides it. */
    private panelOwners: Map<string, string>;

    constructor(){
        this.knownApps = new Map();
        this.knownPanels = new Map();
        this.failedApps = new Map();
        this.moduleCache = new Map();
        this.panelOwners = new Map();
    }

    private async fetchExternalModule(name: string, appInfo: AppInfoSource): Promise<any> {
        // This should be same result as import(name)
        // But the module might be in different places
        // In development, module 'testModule' might be ../../testModule (A npm package, with package.json defining what we should load)
        // In Arma, it would be in A3API.RequestFile('/z/ace/addons/tacphone/apps/X.js')
        // In WebBrowser proxy mode, it would be window.Networking.LoadFile(/z/ace/addons/tacphone/apps/X.js')
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
        let content = await window.Networking.LoadGameFileText(appInfo.file); //  `/z/ace/addons/tacphone/apps/${name}.js`
        // Store it in a blob url and then return it
        let url = URL.createObjectURL(new Blob([content], {type: 'application/javascript'}));
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

    private parseAppInfo(name: string, raw: unknown): AppInfoSource {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            throw new Error(`App "${name}" has invalid metadata`);

        const data = raw as Record<string, unknown>;
        const file = typeof data.file === "string" ? data.file : "";
        const devfile = typeof data.devfile === "string" ? data.devfile : "";

        if (name !== "main" && file.length === 0)
            throw new Error(`App "${name}" does not define a file to load`);

        return { file, devfile };
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

            if (typeof candidate.GetTacPhoneIcon !== "function")
                throw new Error(`App "${appName}" panel "${candidate.id}" has no GetTacPhoneIcon()`);

            if (typeof candidate.GetDefaultTitle !== "function")
                throw new Error(`App "${appName}" panel "${candidate.id}" has no GetDefaultTitle()`);

            return candidate as AppPanelInfo;
        });
    }

    async LoadAvailableApps(): Promise<void> {
        await window.Networking.WhenReady();

        const appData = this.parseAppData(await window.Networking.Request({a: "main", c: "GetAvailableApps"}));
        const entries = Object.entries(appData);

        // Reset the directory so a retry does not leave stale apps/panels behind.
        this.knownApps = new Map();
        this.knownPanels = new Map();
        this.failedApps = new Map();
        this.panelOwners = new Map();

        // Load every app in parallel. One broken app must not prevent the rest from starting.
        const results = await Promise.allSettled(entries.map(async ([name, rawInfo]) => {
            const appInfoSource = this.parseAppInfo(name, rawInfo);
            const module = await this.getModule(name, appInfoSource);

            if (typeof module?.GetTacPhoneApps !== "function")
                throw new Error(`App "${name}" does not export GetTacPhoneApps()`);

            const panels = this.validatePanels(name, module.GetTacPhoneApps());

            const appInfo: AppInfo = {
                ...appInfoSource,
                module,
                panels
            };

            return { name, appInfo };
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

            const { appInfo } = result.value;
            this.knownApps.set(name, appInfo);

            appInfo.panels.forEach(panel => {
                if (this.knownPanels.has(panel.id))
                    console.warn(`TacPhone panel id "${panel.id}" from app "${name}" is already registered; overwriting it.`);

                this.knownPanels.set(panel.id, panel);
                this.panelOwners.set(panel.id, name);
            });
        });

        this.failedApps = failedApps;
    }

    /**
     * Returns the name of the app that provides the given panel id, if any.
     * Used by the panel directory to report which app runs in an open panel.
     */
    appNameForPanel(panelId: string): string | undefined {
        return this.panelOwners.get(panelId);
    }

    // Returns a BLOB url containing the WebP icon image
    /*async LoadAppIcon(name: string) : Promise<string> {

        if (!this.knownApps?.has(name)) //#TODO log error
            return "";

        let appInfo = this.knownApps.get(name)!;

        if (appInfo.icon.startsWith("blob:") || appInfo.icon.startsWith("data:")) // Icon was already resolved to data/blob URL
            return appInfo.icon;

        // The App might have an icon bundled in
        if (typeof appInfo.module.GetTacPhoneIcon == "function")
            return appInfo.module.GetTacPhoneIcon();

        // The icon is texture file stored in game
        let result = await window.Networking.LoadGameFileTexture(appInfo.icon, 512);
        
        // Cache so we don't need to look up next time
        appInfo.icon = result;

        return result;
    }*/
}


window.AppDirectory = new AppDirectory;
