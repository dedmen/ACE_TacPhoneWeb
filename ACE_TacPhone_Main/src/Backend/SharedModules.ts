// Host-side registry of the modules the host provides to apps.
//
// The namespaces live on the internal `window.TacPhone.modules` map, keyed by
// bare specifier, instead of on per-module window globals. The generated import
// map entries read them back by specifier (see vite.config.ts), and the
// dependency loader seeds `es-module-shims` with the same mappings.
//
// `SHARED_MODULES` is the single source of truth for the specifier list; the
// Record below makes TypeScript report a missing entry when it changes.

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as ReactJSXRuntime from "react/jsx-runtime";
import * as ReactCompilerRuntime from "react/compiler-runtime";
import qrcode from "qrcode-generator";
import { SHARED_MODULES } from "@ace-tacphone/build/shared-modules";

const namespaces: Record<(typeof SHARED_MODULES)[number]["specifier"], unknown> = {
    "react": React,
    "react-dom": ReactDOM,
    "react-dom/client": ReactDOMClient,
    "react/jsx-runtime": ReactJSXRuntime,
    "react/compiler-runtime": ReactCompilerRuntime,
    "qrcode-generator": qrcode,
};

/**
 * Internal module registry installed on `window.TacPhone.modules`.
 *
 * Apps must not read this map: they import the bare specifier and let the host
 * import map resolve it.
 */
export const sharedModules: ReadonlyMap<string, unknown> = new Map(
    SHARED_MODULES.map(({ specifier }) => [specifier, namespaces[specifier]] as const),
);

/** Namespace of a host-provided specifier; throws for an unknown one. */
export function getSharedModule(specifier: string): unknown {
    if (!sharedModules.has(specifier))
        throw new Error(`TacPhone does not provide the shared module "${specifier}".`);

    return sharedModules.get(specifier);
}
