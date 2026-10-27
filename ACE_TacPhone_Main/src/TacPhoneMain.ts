// Public API surface of the TacPhone host.
//
// This module is the entry point for the generated declaration bundle
// (dist/TacPhoneMain.d.ts). Everything an external app may use at runtime is
// exported from here, and every property the host assigns to `window` is
// declared in the global block below.
//
// Keep this file in sync with src/main.tsx (shared modules) and the
// `window.* = ...` assignments in src/Backend. The generated bundle is what
// apps copy into their project as `TacPhoneMain.d.ts`.

import type * as React from "react";
import type * as ReactDOM from "react-dom";
import type * as ReactDOMClient from "react-dom/client";
import type * as ReactJSXRuntime from "react/jsx-runtime";
import type * as ReactCompilerRuntime from "react/compiler-runtime";

import type { A3API } from "./Backend/A3API";
import type { AppDirectory } from "./Backend/AppDirectory";
import type { Networking } from "./Backend/Networking";
import type { CommandRegistry } from "./Backend/MessageRouter";

export type { AppInfo, AppModule, AppPanelInfo } from "./Backend/Types";
export type { CommandHandler } from "./Backend/MessageRouter";
export type { Networking } from "./Backend/Networking";
export { A3API } from "./Backend/A3API";
export { AppDirectory } from "./Backend/AppDirectory";
export { CommandRegistry } from "./Backend/MessageRouter";

declare global {
    interface Window {
        // Shared modules provided through the host import map.
        // See shared-modules.js and src/main.tsx.
        React: typeof React;
        ReactDOM: typeof ReactDOM;
        ReactDOMClient: typeof ReactDOMClient;
        ReactJSXRuntime: typeof ReactJSXRuntime;
        ReactCompilerRuntime: typeof ReactCompilerRuntime;

        // Host API. Prefer Networking over A3API so the same app works in
        // external-browser mode as well as in the in-game browser.
        Networking: Networking;
        A3API: A3API;
        AppDirectory: AppDirectory;
        TacPhoneUtils: {
            CommandRegistry: typeof CommandRegistry;
        };
    }
}
