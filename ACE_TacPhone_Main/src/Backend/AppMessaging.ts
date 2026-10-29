// Delivers a message to the app it targets.
//
// Messages look like `{a:"<AppName>", c:"<Command>", ...}`; `a` is the app name
// (the config class and the routing key), and the app handles the command in its
// module-level OnMessageFromGame() through window.TacPhoneUtils.CommandRegistry.
//
// This lives in its own module because both networking implementations (A3API in
// game, websocket in the dev browser) forward game messages this way, and host
// features that are not the game (for example notification actions) deliver
// messages through the same path.
//
// The app directory is read from `window` at call time instead of being imported,
// which keeps this module free of load-order assumptions: an app may be loaded
// (or replaced) long after this module was evaluated.

interface AppMessageTarget {
    a?: unknown;
}

interface AppMessageHandler {
    OnMessageFromGame?(message: object): unknown;
}

/**
 * Forwards a message to the OnMessageFromGame() of the app named by its `a`.
 * Unknown or unloaded apps are logged and skipped; app failures never throw.
 */
export function SendMessageToApp(message: object): void {
    const { a } = message as AppMessageTarget;

    if (typeof a !== "string" || a.length === 0) {
        console.warn("Message from game has no app target", message);
        return;
    }

    const appModule = window.AppDirectory?.knownApps.get(a)?.module as AppMessageHandler | undefined;
    if (!appModule || typeof appModule.OnMessageFromGame !== "function") {
        console.warn(`No loaded TacPhone app can handle a message for "${a}"`, message);
        return;
    }

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
}
