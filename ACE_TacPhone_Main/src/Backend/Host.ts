// Host bootstrap: builds the one app-facing host object.
//
// Apps only ever see `window.TacPhone` (see `@ace-tacphone/api`). Every host
// service lives in its own module as a private singleton; this module collects
// them once and publishes the host object, so there is a single place that
// defines the runtime surface and a single place that has to change when the
// contract grows.
//
// Creation is idempotent and lazy: importing this module installs the host, and
// `GetTacPhoneHost()` builds (and installs) it on first use, so host code that
// runs before the UI entry point still gets a valid host.

import React from "react";
import { TACPHONE_API_VERSION } from "@ace-tacphone/api";
import type { TacPhoneHost } from "@ace-tacphone/api";

import { networking } from "./Networking";
import { appDirectory } from "./AppDirectory";
import { panelDirectory } from "./PanelDirectory";
import { interApp } from "./InterApp";
import { interestRegistry } from "./InterestRegistry";
import { notificationCenter } from "./Notifications";
import { CommandRegistry } from "./MessageRouter";
import { PanelContext, usePanel } from "../Panels/PanelContext";
import { compressAndToBase64, decompressFromBase64 } from "./Compression";

/** The host object, once it was built. */
let host: TacPhoneHost | undefined;

/** Builds the host object from the singleton services. */
function createHost(): TacPhoneHost {
    if (React.version.split('.')[0] !== '19') {
        console.error(
            `TacPhone expects React 19, but the host loaded React ${React.version}. `
            + 'Apps share this React instance through the import map.',
        );
    }

    return {
        apiVersion: TACPHONE_API_VERSION,
        reactVersion: React.version,
        networking,
        apps: appDirectory,
        panels: panelDirectory,
        interApp,
        interests: interestRegistry,
        notifications: notificationCenter,
        utils: {
            CommandRegistry,
            PanelContext,
            usePanel,
            compressAndToBase64,
            decompressFromBase64
        }
    };
}

/**
 * Returns the app-facing host object, building and installing it on first use.
 *
 * Host modules use this instead of `window.TacPhone`; apps read the global.
 */
export function GetTacPhoneHost(): TacPhoneHost {
    if (!host) {
        host = createHost();
        window.TacPhone = host;
    }

    return host;
}

// Install the host once the module graph finished evaluating: the host services
// import each other, so a synchronous call here could still see a service that
// is in its temporal dead zone.
queueMicrotask(() => {
    GetTacPhoneHost();
});
