#!/usr/bin/env node
// Finds base-game strings that could replace entries in the add-on stringtable.
//
// The dataset is BrettMayson's dump of every official Arma 3 stringtable:
//   https://github.com/BrettMayson/stringtables/blob/master/docs/strings.cbor
// It is large (~30 MB) and is not committed. Download it once with
// `--download`, or pass a local copy with `--json <path>` (JSON is still
// accepted for older dumps).
//
// Usage (workspace root):
//   tacphone-build base-strings --download
//   tacphone-build base-strings --json C:\path\to\strings.cbor
//   tacphone-build base-strings --area Map
//
// Output: for every web key, the base-game keys with the same English text and
// their translations, so a human can decide whether the reuse is a good fit.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { findWorkspaceRoot } from './paths.mjs'
import { readStringtable } from './stringtable.mjs'
import { decodeCbor } from './cbor.mjs'

const DATASET_URL = 'https://raw.githubusercontent.com/BrettMayson/stringtables/master/docs/strings.cbor'

/** Local cache location, relative to the workspace root. */
const CACHE_PATH = join('node_modules', '.cache', 'tacphone', 'base-strings.cbor')

/** Dataset language keys are lower case; print the stringtable tag names. */
const LANGUAGE_NAMES = {
    english: 'English',
    chinesesimp: 'Chinesesimp',
    chinese: 'Chinese',
    czech: 'Czech',
    german: 'German',
    russian: 'Russian',
    polish: 'Polish',
    italian: 'Italian',
    spanish: 'Spanish',
    french: 'French',
    japanese: 'Japanese',
    korean: 'Korean',
    portuguese: 'Portuguese',
    turkish: 'Turkish',
    original: 'Original',
}

function parseArgs(args) {
    const options = { json: '', download: false, area: '' }

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]

        if (argument === '--download') {
            options.download = true
        } else if (argument === '--json') {
            options.json = args[++index] ?? ''
        } else if (argument === '--area') {
            options.area = args[++index] ?? ''
        } else if (argument === '--help' || argument === '-h') {
            options.help = true
        } else {
            throw new Error(`Unknown argument: ${argument}`)
        }
    }

    return options
}

/** Lower-case text comparison that ignores trailing punctuation. */
function normalizeText(text) {
    return text
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[.!…]+$/u, '')
}

/** Rebuilds one language map with the canonical names used by stringtables. */
function normalizeLanguages(languages) {
    const table = Object.create(null)

    for (const [language, text] of Object.entries(languages)) {
        if (typeof text !== 'string')
            continue

        const name = LANGUAGE_NAMES[language.toLowerCase()]
            ?? language.charAt(0).toUpperCase() + language.slice(1)
        table[name] = text
    }

    return table
}

/** Accepts the CBOR dump and the older JSON dump. */
function normalizeDataset(raw) {
    const keys = raw?.keys ?? raw
    const result = Object.create(null)

    for (const [key, languages] of Object.entries(keys)) {
        if (languages && typeof languages === 'object')
            result[key] = normalizeLanguages(languages)
    }

    return result
}

async function loadDataset(rootDir, options) {
    const path = options.json
        ? resolve(options.json)
        : join(rootDir, CACHE_PATH)

    if (existsSync(path)) {
        return { path, data: parseDataset(path, await readFile(path)) }
    }

    if (!options.download)
        throw new Error(
            `base-game stringtable not found at ${path}. `
            + 'Run with --download, or pass --json <path>.',
        )

    console.log(`Downloading ${DATASET_URL} ...`)

    const response = await fetch(DATASET_URL)
    if (!response.ok)
        throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`)

    const buffer = Buffer.from(await response.arrayBuffer())
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, buffer)

    return { path, data: normalizeDataset(decodeCbor(buffer)) }
}

function parseDataset(path, buffer) {
    const isJson = extname(path).toLowerCase() === '.json'
    const raw = isJson
        ? JSON.parse(buffer.toString('utf8'))
        : decodeCbor(buffer)

    return normalizeDataset(raw)
}

/** Base-game keys grouped by normalized English text. */
function indexByEnglish(dataset) {
    const index = new Map()

    for (const [key, languages] of Object.entries(dataset)) {
        const english = languages.English
        if (typeof english !== 'string' || english.trim() === '')
            continue

        const normalized = normalizeText(english)
        const entry = { key, languages }
        const list = index.get(normalized)

        if (list)
            list.push(entry)
        else
            index.set(normalized, [entry])
    }

    return index
}

export async function runBaseStrings(args = []) {
    const options = parseArgs(args)
    if (options.help) {
        console.log('Usage: tacphone-build base-strings [--download] [--json <path>] [--area <Area>]')
        return
    }

    const rootDir = findWorkspaceRoot()
    const stringtablePath = resolve(rootDir, '..', 'stringtable.xml')

    if (!existsSync(stringtablePath))
        throw new Error(`stringtable not found at ${stringtablePath}`)

    const table = readStringtable(stringtablePath)
    const english = table.English ?? {}

    const { path: datasetPath, data } = await loadDataset(rootDir, options)
    const index = indexByEnglish(data)

    const prefix = options.area
        ? `STR_ACE_Tacphone_${options.area}_`
        : 'STR_ACE_Tacphone_'

    const keys = Object.keys(english)
        .filter(key => key.startsWith(prefix))
        .sort()

    let matches = 0

    console.log(`Base stringtable: ${datasetPath}`)
    console.log(`Comparing ${keys.length} key(s) from ${stringtablePath}\n`)

    for (const key of keys) {
        const value = english[key]
        const candidates = index.get(normalizeText(value))

        if (!candidates || candidates.length === 0)
            continue

        matches += 1
        console.log(`${key}\n  = "${value}"`)

        for (const candidate of candidates) {
            console.log(`  -> ${candidate.key}`)

            for (const [language, text] of Object.entries(candidate.languages)) {
                if (language === 'Original')
                    continue

                console.log(`       ${language}: ${text}`)
            }
        }

        console.log('')
    }

    console.log(`${matches} of ${keys.length} key(s) have a same-text base-game candidate.`)
}
