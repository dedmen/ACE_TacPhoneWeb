// Maps NotificationOptions to the in-game Notify.Show request.
//
// Pure and browser-free so the game-free unit tier can bundle it in Node.
// The game enforces the rate limit, length caps and text stripping; the web
// side only picks defaults and normalises the style.

import type { InGameNotificationOptions, NotificationOptions } from "./Types";

/** Toast variants accepted by the game-side Notify.Show command. */
export type InGameNotifyStyle = "info" | "success" | "alert";

/** The `main` request that renders one in-game (non-phone) notification. */
export interface InGameNotifyRequest {
    a: "main";
    c: "Notify.Show";
    title: string;
    body?: string;
    app?: string;
    style: InGameNotifyStyle;
    chat: boolean;
}

const STYLES: ReadonlySet<string> = new Set(["info", "success", "alert"]);

/**
 * Builds the Notify.Show request for one notification, or undefined when the
 * caller did not ask for in-game rendering (`options.inGame` absent).
 */
export function buildInGameNotifyRequest(
    options: NotificationOptions,
): InGameNotifyRequest | undefined {
    const inGame: InGameNotificationOptions | undefined = options.inGame;
    if (inGame === undefined)
        return undefined;

    const style: InGameNotifyStyle =
        typeof inGame.style === "string" && STYLES.has(inGame.style)
            ? (inGame.style as InGameNotifyStyle)
            : "info";

    const request: InGameNotifyRequest = {
        a: "main",
        c: "Notify.Show",
        title: options.title,
        style,
        chat: inGame.chat === true,
    };

    // Forwarded verbatim; the game applies its caps and stripping.
    if (typeof options.body === "string")
        request.body = options.body;
    if (typeof options.app === "string")
        request.app = options.app;

    return request;
}
