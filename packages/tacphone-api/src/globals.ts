// Global window augmentation for the app-facing TacPhone API.
//
// The host exposes exactly one app-facing object: `window.TacPhone`. The old
// per-module globals are deliberately not declared here; they are removed as
// part of the API migration.

import type { TacPhoneHost } from './index';

declare global {
    interface Window {
        /** The TacPhone host API. */
        TacPhone: TacPhoneHost;

        // Shared React modules provided through the host import map.
        // See @ace-tacphone/build/shared-modules.
        React: typeof import('react');
        ReactDOM: typeof import('react-dom');
        ReactDOMClient: typeof import('react-dom/client');
        ReactJSXRuntime: typeof import('react/jsx-runtime');
        ReactCompilerRuntime: typeof import('react/compiler-runtime');
    }
}

export {};
