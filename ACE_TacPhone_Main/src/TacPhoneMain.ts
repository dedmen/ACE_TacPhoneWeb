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
import type { Networking } from "./Backend/Networking";
import type { CommandRegistry } from "./Backend/MessageRouter";

export type { AppInfo, AppModule, AppPanelInfo } from "./Backend/Types";
export type { CommandHandler } from "./Backend/MessageRouter";
export type { Networking } from "./Backend/Networking";
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

        // Host API.
        Networking: Networking;
        AppDirectory: AppDirectory;
        TacPhoneUtils: {
            CommandRegistry: typeof CommandRegistry;
        };
    }
}
