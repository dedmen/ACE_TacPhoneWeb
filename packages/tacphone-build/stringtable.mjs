// Stringtable parsing shared by the build plugin and the `check-strings` CLI.
//
// The web UI loads the real stringtable at runtime through the game's file
// request path; this module only handles the build-time copy that ships inside
// the host bundle, so UI that renders before the game is reachable already has
// text (the remote pairing screen, the loading line, the fatal error screen).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

/** Id of the virtual module that carries the compressed default table. */
export const STRINGTABLE_MODULE_ID = 'virtual:tacphone-stringtable'

const RESOLVED_MODULE_ID = `\0${STRINGTABLE_MODULE_ID}`

/** Decodes the XML entities that appear in a stringtable text node. */
function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity) => {
        switch (entity) {
            case 'amp': return '&'
            case 'lt': return '<'
            case 'gt': return '>'
            case 'quot': return '"'
            case 'apos': return "'"
            default: break
        }

        const numeric = entity.startsWith('#x')
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10)

        return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : match
    })
}

/** Strips a surrounding CDATA section, if the text node has one. */
function stripCdata(text) {
    const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text)
    return match ? match[1] : text
}

/**
 * Parses a stringtable into `{ [language]: { [key]: text } }`.
 *
 * Only key/value pairs are kept: packages, containers and key IDs are not part
 * of the result, so the bundled table stays as small as possible. Keys are
 * stored exactly as written; lookups are case-insensitive at runtime.
 */
export function parseStringtable(xmlText) {
    const table = Object.create(null)

    // Comments may contain `<Key>` examples; drop them before scanning.
    const xml = String(xmlText).replace(/<!--[\s\S]*?-->/g, '')
    const keyPattern = /<Key\b[^>]*\bID\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/Key>/g

    let keyMatch
    while ((keyMatch = keyPattern.exec(xml)) !== null) {
        const key = keyMatch[1].trim()
        const body = keyMatch[2]
        if (key.length === 0)
            continue

        const entryPattern = /<([A-Za-z][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g

        let entryMatch
        while ((entryMatch = entryPattern.exec(body)) !== null) {
            const language = entryMatch[1]
            if (language === 'Key' || language === 'Package' || language === 'Container')
                continue

            const text = decodeEntities(stripCdata(entryMatch[2])).trim()
            const languageTable = table[language] ??= Object.create(null)
            languageTable[key] = text
        }
    }

    return table
}

/** Reads and parses one stringtable file. */
export function readStringtable(filePath) {
    return parseStringtable(readFileSync(filePath, 'utf8'))
}

/**
 * Keeps only the requested languages. Unknown names are ignored; an empty
 * result falls back to every language in the file.
 */
function selectLanguages(table, languages) {
    if (!languages || languages.length === 0)
        return table

    const selected = Object.create(null)
    for (const language of languages) {
        if (table[language])
            selected[language] = table[language]
    }

    return Object.keys(selected).length > 0 ? selected : table
}

/**
 * Serializes a parsed table into the base64 payload the host bundles.
 *
 * The payload is `base64(gzip(JSON))`; the host decodes it with the same
 * `decompressFromBase64` helper it uses for app bundles.
 */
export function encodeStringtable(table) {
    return gzipSync(Buffer.from(JSON.stringify(table), 'utf8')).toString('base64')
}

/**
 * Vite plugin that exposes the add-on stringtable as
 * `virtual:tacphone-stringtable`, a single base64 string.
 */
export function tacphoneStringtable(options = {}) {
    const sourcePath = options.path ?? '../../stringtable.xml'
    const languages = options.languages

    let filePath = resolve(sourcePath)

    return {
        name: 'tacphone-stringtable',
        enforce: 'pre',

        configResolved(config) {
            filePath = resolve(config.root, sourcePath)
        },

        resolveId(id) {
            return id === STRINGTABLE_MODULE_ID ? RESOLVED_MODULE_ID : undefined
        },

        load(id) {
            if (id !== RESOLVED_MODULE_ID)
                return undefined

            this.addWatchFile(filePath)

            const table = selectLanguages(readStringtable(filePath), languages)

            return `export default ${JSON.stringify(encodeStringtable(table))};\n`
        },

        handleHotUpdate(context) {
            // The bytes are baked into the module, so a stringtable edit has to
            // reload the page instead of swapping one module.
            if (resolve(context.file) !== filePath)
                return undefined

            context.server.ws.send({ type: 'full-reload' })
            return []
        },
    }
}
