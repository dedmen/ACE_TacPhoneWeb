import { IsLocalDev } from "./Networking";

type AppInfo = {
    devfile: string;
    file: string;
    module: AppModule;
    panels: Array<AppPanelInfo>;
};

class AppDirectory
{
    knownApps: Map<string, AppInfo>;
    knownPanels: Map<string, AppPanelInfo>;

    constructor(){
        this.knownApps = new Map();
        this.knownPanels = new Map();
    }

    private async fetchExternalModule(name: string, appInfo: AppInfo): Promise<any> {
        // This should be same result as import(name)
        // But the module might be in different places
        // In development, module 'testModule' might be ../../testModule (A npm package, with package.json defining what we should load)
        // In Arma, it would be in A3API.RequestFile('/z/ace/addons/tacphone/apps/X.js')
        // In WebBrowser proxy mode, it would be window.Networking.LoadFile(/z/ace/addons/tacphone/apps/X.js')
        // Note in the Arma paths, we always need a lookup table, mod's modules will not all be in ace folders.

        //#TODO cache? If we loaded one once, we don't need to re-load it

        if (IsLocalDev()) {
            // Try to find it in parent folder

            //#TODO we need to make mod development a bit easier, always copying or symlinking next to our folders is a bit annoying

            //#TODO document this
            // For development, the directory that contains the app (with its package.json), must be symlinked into "devapps" folder.

            let lib = await import(/* @vite-ignore */ `/devapps/${name}/src/main.tsx`);
            return lib;
        }

        // Either Arma or Web proxy, networking will handle whichever it is

        //#TODO we need a global module/app directory, where we can look up from classname to in-game path
        let content = await window.Networking.LoadGameFileText(appInfo.file); //  `/z/ace/addons/tacphone/apps/${name}.js`
        // Store it in a blob url and then return it
        let url = URL.createObjectURL(new Blob([Uint8Array.from(content, c => c.charCodeAt(0))], {type: 'application/javascript'}));
        return import(/* @vite-ignore */ url);
    }

    async LoadAvailableApps(): Promise<void> {
        let appData = JSON.parse(await window.Networking.Request({a: "main", c: "GetAvailableApps"}) as unknown as string);
        
        this.knownApps = new Map(Object.entries(appData));

        // immediately load their modules here
        for (let [key, value] of this.knownApps) {

            if (key == "main") // Main is provided by us, we are main, not an external module
                value.module = await import('../MainApps/main');
            else
                value.module = await this.fetchExternalModule(key, value);
            value.panels = value.module.GetTacPhoneApps();

            value.panels.forEach(panel => {
                this.knownPanels.set(panel.id, panel);
            });
        }
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


declare global {
    interface Window { AppDirectory: AppDirectory; }
}
window.AppDirectory = new AppDirectory;