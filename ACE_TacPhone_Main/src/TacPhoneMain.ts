// Public API surface of the TacPhone host, for host code.
//
// The app-facing contract lives in `@ace-tacphone/api` and is exposed to apps as
// the single `window.TacPhone` object (see Backend/Host.ts). This module only
// re-exports that contract plus the host implementations, so host code has one
// import path without duplicating any type.
//
// Apps must never import this module: they get the host object at runtime and
// their types from `@ace-tacphone/api`.

export * from "@ace-tacphone/api";

// Host services. Apps reach them through window.TacPhone.
export { GetTacPhoneHost } from "./Backend/Host";
export { AppDirectory, appDirectory } from "./Backend/AppDirectory";
export { InterAppRegistry, interApp } from "./Backend/InterApp";
export { InterestRegistry, interestRegistry } from "./Backend/InterestRegistry";
export { CommandRegistry } from "./Backend/MessageRouter";
export { NotificationCenter, notificationCenter } from "./Backend/Notifications";
export { PanelDirectory, panelDirectory } from "./Backend/PanelDirectory";
export { networking, IsArma, IsLocalDev } from "./Backend/Networking";
export { SendMessageToApp } from "./Backend/AppMessaging";
export { compressAndToBase64, decompressFromBase64 } from "./Backend/Compression";
