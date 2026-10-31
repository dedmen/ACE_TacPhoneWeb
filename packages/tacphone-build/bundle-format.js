// On-disk format of a built TacPhone app bundle.
//
// An app bundle is not stored as JavaScript. It is one ASCII line:
//
//     TACPHONE-BUNDLE:<version>:<codec>:<base64>
//
// Gzip output contains NUL bytes, and the game hands file text through C
// strings (`loadFile` in SQF, `A3API.RequestFile` in the page), so raw
// compressed bytes would be truncated at the first NUL. Base64 also keeps the
// payload pure ASCII, which the engine's base64 hop and the host's
// `decodeGameText` pass through unchanged.
//
// Version and codec are separate fields on purpose: brotli would be
// `TACPHONE-BUNDLE:1:brotli:<base64>` without changing the shape a reader has
// to understand. The reader only accepts what it knows and reports anything
// else, so an old host says "rebuild the app" instead of failing to parse.
//
// This module is browser-safe (no Node imports) because the host loader imports
// the header helpers. The Node half lives in `bundle-format.node.mjs`; the
// single-file plugin and the CLI use that one.

/** Start of every app bundle line, independent of version and codec. */
export const APP_BUNDLE_MARKER = "TACPHONE-BUNDLE:";

/** Version of the bundle container described by this module. */
export const APP_BUNDLE_VERSION = 1;

/** Codec the build writes today. The reader rejects every other codec. */
export const APP_BUNDLE_CODEC_GZIP = "gzip";

const HEADER_PATTERN = new RegExp(`^${APP_BUNDLE_MARKER}(\\d+):([a-z0-9-]+):`);

/**
 * Builds the header an app bundle starts with.
 * @param {number} [version]
 * @param {string} [codec]
 * @returns {string}
 */
export function formatAppBundleHeader(version = APP_BUNDLE_VERSION, codec = APP_BUNDLE_CODEC_GZIP) {
    return `${APP_BUNDLE_MARKER}${version}:${codec}:`
}

/**
 * Splits a bundle into its header fields and base64 payload.
 * @param {string} text File contents, as read from `dist/<app>.js`.
 * @returns {{ version: number, codec: string, payload: string } | { error: string }}
 *   `{ error }` means the text is not a TacPhone bundle at all, for example a
 *   plain JavaScript build.
 */
export function parseAppBundleHeader(text) {
    const match = HEADER_PATTERN.exec(text)
    if (!match) {
        return { error: "missing the TACPHONE-BUNDLE header" }
    }

    return {
        version: Number(match[1]),
        codec: match[2],
        payload: text.slice(match[0].length).trim(),
    }
}
