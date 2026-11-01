#!/usr/bin/env node
// AI-translates the add-on stringtable into every supported language.
//
// The game supports these 19 languages; its bundled stringtable dump may lag
// behind the five newer additions. Each language that receives a machine
// translation is marked with `ai-translated="true"` on its own tag (English
// never), as required by AGENTS/localization.md.
//
// Usage (workspace root):
//   tacphone-build translate                  # fill missing languages
//   tacphone-build translate --check          # only report what is missing
//   tacphone-build translate --only German,French
//   tacphone-build translate --force          # re-translate everything
//
// Results are cached in `node_modules/.cache/tacphone/translation-cache.json`
// so a later run only requests new/changed keys.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { findWorkspaceRoot } from './paths.mjs'
import { readMarks, writeMarks } from './ai-marks.mjs'
import { STRINGTABLE_LANGUAGES } from './languages.mjs'

export { STRINGTABLE_LANGUAGES }

/** Non-English stringtable tag -> translation API code. */
const TRANSLATION_CODES = {
    Czech: 'cs',
    French: 'fr',
    Spanish: 'es',
    Italian: 'it',
    Polish: 'pl',
    Portuguese: 'pt',
    Russian: 'ru',
    German: 'de',
    Korean: 'ko',
    Japanese: 'ja',
    Chinese: 'zh-TW',
    Chinesesimp: 'zh-CN',
    Turkish: 'tr',
    Slovak: 'sk',
    Ukrainian: 'uk',
    Latin: 'la',
    Bulgarian: 'bg',
    Hungarian: 'hu',
}

const CACHE_PATH = join('node_modules', '.cache', 'tacphone', 'translation-cache.json')
const ENDPOINT = 'https://clients5.google.com/translate_a/t'

function parseArgs(args) {
    const options = {
        check: false,
        force: false,
        only: [],
        help: false,
    }

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]

        if (argument === '--check') {
            options.check = true
        } else if (argument === '--force') {
            options.force = true
        } else if (argument === '--only') {
            options.only = (args[++index] ?? '').split(',').map(value => value.trim()).filter(Boolean)
        } else if (argument === '--help' || argument === '-h') {
            options.help = true
        } else {
            throw new Error(`Unknown argument: ${argument}`)
        }
    }

    return options
}

function decodeEntities(text) {
    return text
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&amp;', '&')
}

function encodeEntities(text) {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
}

function placeholderSet(text) {
    return [...text.matchAll(/%(\d)/g)].map(match => match[1]).sort().join(',')
}

function validTranslation(source, translated) {
    return typeof translated === 'string'
        && translated.trim() !== ''
        && placeholderSet(source) === placeholderSet(translated)
}

/** Hides `%n` from the translator, which otherwise inserts spaces. */
function protectPlaceholders(text) {
    return text.replace(/%(\d)/g, '{{$1}}')
}

/** Restores `%n` after translation. */
function restorePlaceholders(text) {
    return text.replace(/\{\{\s*(\d)\s*\}\}/g, '%$1')
}

/** One `<Key>` of the stringtable. */
function parseKeys(xml) {
    return [...xml.matchAll(/<Key ID="([^"]+)"([^>]*)>([\s\S]*?)<\/Key>/g)].map(match => {
        const entries = [...match[3].matchAll(/<([A-Za-z][\w.-]*)\b([^>]*)>([\s\S]*?)<\/\1>/g)]
            .map(entry => ({
                language: entry[1],
                attributes: entry[2],
                ai: /ai-translated\s*=\s*"true"/.test(entry[2]),
                text: decodeEntities(entry[3].trim()),
            }))

        return {
            id: match[1],
            attributes: match[2].replace(/\s*ai-translated\s*=\s*"true"/g, ''),
            entries,
            english: entries.find(entry => entry.language === 'English')?.text ?? '',
        }
    })
}

function makeBatches(entries) {
    const batches = []
    let current = []
    let length = 0

    for (const entry of entries) {
        const cost = encodeURIComponent(entry.english).length + 2
        if (current.length > 0 && (current.length >= 25 || length + cost > 5500)) {
            batches.push(current)
            current = []
            length = 0
        }
        current.push(entry)
        length += cost
    }

    if (current.length > 0)
        batches.push(current)

    return batches
}

async function translateBatch(texts, code) {
    const url = new URL(ENDPOINT)
    url.searchParams.set('client', 'dict-chrome-ex')
    url.searchParams.set('sl', 'en')
    url.searchParams.set('tl', code)
    for (const text of texts)
        url.searchParams.append('q', protectPlaceholders(text))

    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })

            if (response.status === 429 || response.status >= 500) {
                await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)))
                continue
            }

            if (!response.ok)
                throw new Error(`HTTP ${response.status}`)

            const data = await response.json()
            const result = Array.isArray(data) ? data : [data]

            if (result.length !== texts.length)
                throw new Error(`expected ${texts.length} results, got ${result.length}`)

            return result.map(value => Array.isArray(value) ? value[0] : value)
        } catch (error) {
            if (attempt === 4)
                throw error

            await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)))
        }
    }

    throw new Error('translation failed')
}

/** Rebuilds the XML with every available language, sorted as before. */
function renderStringtable(xml, keys) {
    let keyIndex = 0

    return xml.replace(/[ \t]*<Key ID="([^"]+)"[^>]*>[\s\S]*?<\/Key>/g, () => {
        const key = keys[keyIndex++]
        const byLanguage = new Map(key.entries.map(entry => [entry.language, entry]))
        const lines = [`            <Key ID="${key.id}"${key.attributes}>`]

        for (const language of STRINGTABLE_LANGUAGES) {
            const entry = byLanguage.get(language)
            if (!entry)
                continue

            const attribute = language !== 'English' && entry.ai ? ' ai-translated="true"' : ''
            lines.push(`                <${language}${attribute}>${encodeEntities(entry.text)}</${language}>`)
        }

        lines.push('            </Key>')
        return lines.join('\n')
    })
}

/** Fills the requested languages of every key, one language at a time. */
async function translateLanguage(keys, language, cache, options) {
    const code = TRANSLATION_CODES[language]
    const pending = []

    for (const key of keys) {
        const existing = key.entries.find(entry => entry.language === language)
        const cached = cache[`${language}|${key.id}`]
        const fallbackWithPlaceholders = (value) => value === key.english && /%\d/.test(key.english)

        if (!options.force && existing && validTranslation(key.english, existing.text) && !fallbackWithPlaceholders(existing.text))
            continue

        if (!options.force && validTranslation(key.english, cached) && !fallbackWithPlaceholders(cached)) {
            key.entries = key.entries.filter(entry => entry.language !== language)
            key.entries.push({ language, text: cached, ai: true })

            continue
        }

        pending.push(key)
    }

    let done = 0

    for (const batch of makeBatches(pending)) {
        const results = await translateBatch(batch.map(key => key.english), code)

        for (let index = 0; index < batch.length; index += 1) {
            const key = batch[index]
            let text = restorePlaceholders(String(results[index]).trim())

            if (!validTranslation(key.english, text)) {
                console.warn(`WARN ${language} ${key.id}: invalid result, keeping English`)
                text = key.english
            }

            key.entries = key.entries.filter(entry => entry.language !== language)
            key.entries.push({ language, text, ai: true })
            cache[`${language}|${key.id}`] = text
            done += 1
        }

        process.stdout.write(`  ${language} ${done}/${pending.length}\r`)
        await new Promise(resolve => setTimeout(resolve, 250))
    }

    if (pending.length > 0)
        console.log(`${language}: ${pending.length} translated`)
}

export async function runTranslate(args = []) {
    const options = parseArgs(args)

    if (options.help) {
        console.log(`Usage: tacphone-build translate [--check] [--force] [--only <Languages>]

Languages: ${STRINGTABLE_LANGUAGES.filter(language => language !== 'English').join(', ')}`)
        return
    }

    const rootDir = findWorkspaceRoot()
    const stringtablePath = resolve(rootDir, '..', 'stringtable.xml')

    if (!existsSync(stringtablePath))
        throw new Error(`stringtable not found at ${stringtablePath}`)

    const cachePath = join(rootDir, CACHE_PATH)
    let cache = {}

    try {
        cache = JSON.parse(await readFile(cachePath, 'utf8'))
    } catch {
        cache = {}
    }

    const xml = await readFile(stringtablePath, 'utf8')
    const keys = parseKeys(xml)
    const requested = options.only.length > 0 ? options.only : Object.keys(TRANSLATION_CODES)
    const languages = requested.map(language => {
        const match = STRINGTABLE_LANGUAGES.find(value => value.toLowerCase() === language.toLowerCase())
        if (!match || match === 'English')
            throw new Error(`Unknown or untranslatable language: ${language}`)
        return match
    })

    let missing = 0
    for (const key of keys) {
        for (const language of languages) {
            const existing = key.entries.find(entry => entry.language === language)
            if (options.force || !existing || !validTranslation(key.english, existing.text))
                missing += 1
        }
    }

    if (options.check) {
        console.log(`${keys.length} keys, ${missing} translation(s) missing for ${languages.join(', ')}`)
        return
    }

    console.log(`Translating ${keys.length} keys (${missing} missing) into ${languages.join(', ')}`)

    await mkdir(dirname(cachePath), { recursive: true })

    for (const language of languages) {
        const before = cache
        await translateLanguage(keys, language, before, options)
        await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8')
    }

    await writeFile(stringtablePath, renderStringtable(xml, keys), 'utf8')

    const marks = await readMarks(rootDir)
    for (const key of keys) {
        const aiLanguages = key.entries
            .filter(entry => entry.language !== 'English' && entry.ai)
            .map(entry => entry.language)

        if (aiLanguages.length > 0)
            marks[key.id] = aiLanguages
        else
            delete marks[key.id]
    }
    await writeMarks(rootDir, marks)

    console.log('stringtable translated')
}
