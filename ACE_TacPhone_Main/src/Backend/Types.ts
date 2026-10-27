import type { ComponentType } from "react";

// Public app contract types. These are re-exported through src/TacPhoneMain.ts,
// which is the source for the generated dist/TacPhoneMain.d.ts consumed by apps.

export interface AppPanelInfo {
    /** Globally (across all panels) unique name of this one. */
    id: string;
    GetTacPhoneIcon(): string;
    GetDefaultTitle(): string;
    appComponent: ComponentType;
}

export interface AppModule {
    GetTacPhoneApps(): Array<AppPanelInfo>;
    OnMessageFromGame?(message: object): void | Promise<void>;
}

export type AppInfo = {
    devfile: string;
    file: string;
    module: AppModule;
    panels: Array<AppPanelInfo>;
};
