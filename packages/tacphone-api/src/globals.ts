// Global window augmentation for the app-facing TacPhone API.
//
// The host exposes exactly one app-facing object: `window.TacPhone`. The old
// per-module globals are gone: shared modules live on the internal
// `window.TacPhone.modules` map, which is not part of the public contract. Apps
// import bare specifiers (`react`, `qrcode-generator`, ...) and the host import
// map resolves them.

import type { TacPhoneHost } from './index';

declare global {
    interface Window {
        /** The TacPhone host API. */
        TacPhone: TacPhoneHost;
    }
}

export {};
