// Node-only half of the app bundle format: gzip and base64.
//
// Kept apart from `bundle-format.js` so the in-page host loader can import the
// header helpers without pulling in `node:zlib`.

import { gzipSync, gunzipSync } from 'node:zlib'
import {
    APP_BUNDLE_CODEC_GZIP,
    APP_BUNDLE_VERSION,
    formatAppBundleHeader,
    parseAppBundleHeader,
} from './bundle-format.js'

/**
 * Encodes built JavaScript as the single ASCII line that is written to
 * `dist/<app>.js`. zlib writes no filename and MTIME 0, so the same input
 * always produces the same bytes.
 * @param {string} code Final JavaScript source, after CSS inlining and
 *   non-ASCII escaping.
 * @returns {string}
 */
export function encodeAppBundle(code) {
    const gzip = gzipSync(Buffer.from(code, 'utf8'), { level: 9 })
    return formatAppBundleHeader() + gzip.toString('base64')
}

/**
 * Decodes a bundle produced by `encodeAppBundle`.
 * Throws with a readable message when the file is not a bundle this build
 * understands, so a tool can point at the rebuild instead of failing later.
 * @param {string} text File contents.
 * @returns {string} The JavaScript source.
 */
export function decodeAppBundle(text) {
    const header = parseAppBundleHeader(text)
    if ('error' in header) {
        throw new Error(header.error)
    }
    if (header.version !== APP_BUNDLE_VERSION) {
        throw new Error(`unsupported bundle format version ${header.version}`)
    }
    if (header.codec !== APP_BUNDLE_CODEC_GZIP) {
        throw new Error(`unsupported bundle codec "${header.codec}"`)
    }

    return gunzipSync(Buffer.from(header.payload, 'base64')).toString('utf8')
}
