// Delivers a message to the app it targets.
//
// Messages look like `{a:"<AppName>", c:"<Command>", ...}`; `a` is the app name
// (the config class and the routing key), and the app handles the command in its
// module-level OnMessageFromGame() through `window.TacPhone.utils.CommandRegistry`.
//
// This lives in its own module because both networking implementations (A3API in
// game, websocket in the dev browser) forward game messages this way, and host
// features that are not the game (for example notification actions) deliver
// messages through the same path.
//
// The app directory is read at call time instead of at module scope, which keeps
// this module free of load-order assumptions: the transport and the directory
// import each other, and an app may be loaded (or replaced) long after both were
// evaluated.

import type { AppModule } from "./Types";
import { appDirectory } from "./AppDirectory";

interface AppMessageTarget {
    a?: unknown;
}

/** Messages that arrived before their app finished loading. */
const pendingByApp = new Map<string, object[]>();
/** Keep one broken/missing app from growing the queue without bound. */
const MAX_PENDING_PER_APP = 100;
let watchingDirectory = false;

/** Delivers one message when the target app is loaded; returns false otherwise. */
function deliver(a: string, message: object): boolean {
    const appModule: AppModule | undefined = appDirectory.knownApps.get(a)?.module;
    if (!appModule || typeof appModule.OnMessageFromGame !== "function")
        return false;

    try {
        const result = appModule.OnMessageFromGame(message);

        if (result !== null && result !== undefined && typeof (result as { then?: unknown }).then === "function") {
            Promise.resolve(result).catch(error => {
                console.error(`TacPhone app "${a}" failed to handle a message:`, error);
            });
        }
    } catch (error) {
        console.error(`TacPhone app "${a}" failed to handle a message:`, error);
    }

    return true;
}

/** Flushes queued messages whose app has just become available. */
function flushPending(): void {
    for (const [app, messages] of [...pendingByApp]) {
        if (messages.length === 0) {
            pendingByApp.delete(app);
            continue;
        }

        if (!appDirectory.knownApps.has(app))
            continue;

        pendingByApp.delete(app);
        for (const message of messages)
            deliver(app, message);
    }
}

/**
 * Forwards a message to the OnMessageFromGame() of the app named by its `a`.
 *
 * A message can arrive while an app is still loading (especially during a page
 * reload, when the game answers a request from the previous page). Those are
 * queued briefly and delivered once the app directory reports the app, instead
 * of being logged as "no loaded app can handle" and lost.
 */
export function SendMessageToApp(message: object): void {
    const { a } = message as AppMessageTarget;

    if (typeof a !== "string" || a.length === 0) {
        console.warn("Message from game has no app target", message);
        return;
    }

    if (deliver(a, message))
        return;

    if (!watchingDirectory) {
        watchingDirectory = true;
        appDirectory.onDidChange(() => flushPending());
    }

    const queued = pendingByApp.get(a) ?? [];
    if (queued.length >= MAX_PENDING_PER_APP) {
        console.warn(`Dropping a message for unloaded TacPhone app "${a}"; its pending queue is full.`, message);
        return;
    }

    queued.push(message);
    pendingByApp.set(a, queued);
}
