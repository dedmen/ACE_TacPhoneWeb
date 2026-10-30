// Public API surface of the TacPhone host.
//
// This module is the entry point for the generated declaration bundle
// (dist/TacPhoneMain.d.ts). Everything an external app may use at runtime is
// exported from here, and every public property the host assigns to `window`
// is declared in the global block below. Internal shims declare their own
// window property next to their implementation.
//
// Keep this file in sync with src/main.tsx (shared modules) and the
// `window.* = ...` assignments in src/Backend. The generated bundle is what
// apps copy into their project as `TacPhoneMain.d.ts`.

import type * as React from "react";
import type * as ReactDOM from "react-dom";
import type * as ReactDOMClient from "react-dom/client";
import type * as ReactJSXRuntime from "react/jsx-runtime";
import type * as ReactCompilerRuntime from "react/compiler-runtime";

import type { AppDirectory } from "./Backend/AppDirectory";
import type { AppApiRegistry } from "./Backend/AppApi";
import type { InterestRegistry } from "./Backend/InterestRegistry";
import type { Networking } from "./Backend/Networking";
import type { CommandRegistry } from "./Backend/MessageRouter";
import type { NotificationCenter } from "./Backend/Notifications";
import type { PanelDirectory, PanelInstance } from "./Backend/PanelDirectory";

export type { AppInfo, AppModule, AppPanelInfo } from "./Backend/Types";
export type { CommandHandler } from "./Backend/MessageRouter";
export type { Networking } from "./Backend/Networking";
export type {
    AppApiRegistration,
    AppServiceInfo,
    TargetChooser,
    TargetOptions,
    TargetPolicy,
} from "./Backend/AppApi";
export type {
    NotificationAction,
    NotificationOptions,
    NotificationTapHandler,
    TacPhoneNotification,
} from "./Backend/Notifications";
export type {
    OpenPanelOptions,
    OpenPanelResult,
    PanelInfo,
    PanelInstance,
    PanelPlacement,
    PanelRect,
} from "./Backend/PanelDirectory";
export { AppDirectory } from "./Backend/AppDirectory";
export { AppApiRegistry } from "./Backend/AppApi";
export { InterestRegistry } from "./Backend/InterestRegistry";
export { CommandRegistry } from "./Backend/MessageRouter";
export { NotificationCenter } from "./Backend/Notifications";
export { PanelDirectory } from "./Backend/PanelDirectory";

declare global {
    interface Window {
        // Shared modules provided through the host import map.
        // See shared-modules.js and src/main.tsx.
        React: typeof React;
        ReactDOM: typeof ReactDOM;
        ReactDOMClient: typeof ReactDOMClient;
        ReactJSXRuntime: typeof ReactJSXRuntime;
        ReactCompilerRuntime: typeof ReactCompilerRuntime;

        // Host API.
        Networking: Networking;
        AppDirectory: AppDirectory;
        // Open panels (tabs and floating popups): enumerate, activate, open.
        PanelDirectory: PanelDirectory;
        // Inter-app services: register an app's API, resolve and call another app's.
        AppApi: AppApiRegistry;
        // Demand-driven game data: acquire and release named data interests.
        InterestRegistry: InterestRegistry;
        // Host notification stack: show banners, subscribe to the current stack.
        Notifications: NotificationCenter;
        TacPhoneUtils: {
            CommandRegistry: typeof CommandRegistry;
            // Live handle of the panel an app content is rendered in.
            PanelContext: React.Context<PanelInstance | undefined>;
            usePanel(): PanelInstance | undefined;
        };
    }
}
