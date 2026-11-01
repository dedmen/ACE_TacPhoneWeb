#!/usr/bin/env node
// Keeps `ai-translated="true"` on the individual language tags that were
// machine translated.
//
// HEMTT's `hemtt ln sort` rewrites stringtable.xml and drops unknown attributes,
// so the per-key language list is stored separately and re-applied after a sort.
//
// Manifest shape: `{ "<Key ID>": ["Czech", "German", ...] }`.
//
// Usage (workspace root):
//   tacphone-build mark-ai                     # apply the saved list
//   tacphone-build mark-ai --save              # save from the current XML, then apply
//   tacphone-build mark-ai --from-translations # bootstrap: every non-English language
//   tacphone-build mark-ai --clear <Key>...    # a human rewrote this key
//   tacphone-build mark-ai --check             # report mismatches

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { findWorkspaceRoot } from './paths.mjs'
import { STRINGTABLE_LANGUAGES } from './languages.mjs'

const MANIFEST_PATH = join('node_modules', '.cache', 'tacphone', 'ai-translated.json')
const ATTRIBUTE = 'ai-translated="true"'
const ATTRIBUTE_RE = /\s*ai-translated\s*=\s*"true"/g

/** Non-English languages, the only ones that can be AI translated. */
export const AI_LANGUAGES = STRINGTABLE_LANGUAGES.filter(language => language !== 'English')

function parseArgs(args) {
    const options = { save: false, fromTranslations: false, clear: [], check: false, help: false }

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]

        if (argument === '--save') {
            options.save = true
        } else if (argument === '--from-translations') {
            options.fromTranslations = true
        } else if (argument === '--clear') {
            while (args[index + 1] && !args[index + 1].startsWith('--'))
                options.clear.push(args[++index])
        } else if (argument === '--check') {
            options.check = true
        } else if (argument === '--help' || argument === '-h') {
            options.help = true
        } else {
            throw new Error(`Unknown argument: ${argument}`)
        }
    }

    return options
}

export function marksPath(rootDir) {
    return join(rootDir, MANIFEST_PATH)
}

/** Reads the manifest, upgrading the old `{ key: true }` shape. */
export async function readMarks(rootDir) {
    try {
        const parsed = JSON.parse(await readFile(marksPath(rootDir), 'utf8'))
        const marks = {}

        for (const [id, value] of Object.entries(parsed ?? {})) {
            if (value === true)
                marks[id] = [...AI_LANGUAGES]
            else if (Array.isArray(value))
                marks[id] = value.filter(language => AI_LANGUAGES.includes(language))
        }

        return marks
    } catch {
        return {}
    }
}

export async function writeMarks(rootDir, marks) {
    const path = marksPath(rootDir)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(marks, null, 2)}\n`, 'utf8')
}

/** One `<Key>` block with its language tags. */
function parseKeys(xml) {
    return [...xml.matchAll(/([ \t]*)<Key ID="([^"]+)"([^>]*)>([\s\S]*?)<\/Key>/g)].map(match => {
        const languages = [...match[4].matchAll(/<([A-Za-z][\w.-]*)\b([^>]*)>([\s\S]*?)<\/\1>/g)]
            .map(entry => ({
                language: entry[1],
                attributes: entry[2],
                text: entry[3],
                ai: /ai-translated\s*=\s*"true"/.test(entry[2]),
            }))

        return {
            indent: match[1],
            id: match[2],
            attributes: match[3].replace(ATTRIBUTE_RE, ''),
            languages,
        }
    })
}

/** Rebuilds every Key block with per-language AI attributes from `marks`. */
function renderKeys(xml, marks) {
    let index = 0
    const keys = parseKeys(xml)

    return xml.replace(/([ \t]*)<Key ID="([^"]+)"[^>]*>[\s\S]*?<\/Key>/g, () => {
        const key = keys[index++]
        const marked = new Set(marks[key.id] ?? [])
        const lines = [`${key.indent}<Key ID="${key.id}"${key.attributes}>`]

        for (const entry of key.languages) {
            const attributes = entry.attributes.replace(ATTRIBUTE_RE, '')
            const ai = entry.language !== 'English' && marked.has(entry.language)
            const suffix = ai ? `${attributes} ${ATTRIBUTE}` : attributes
            lines.push(`${key.indent}    <${entry.language}${suffix}>${entry.text}</${entry.language}>`)
        }

        lines.push(`${key.indent}</Key>`)
        return lines.join('\n')
    })
}

export async function runMarkAI(args = []) {
    const options = parseArgs(args)

    if (options.help) {
        console.log(`Usage: tacphone-build mark-ai [--check] [--save] [--from-translations] [--clear <Key>...]

The AI-translated language list lives in ${MANIFEST_PATH.replaceAll('\\', '/')}.`)
        return
    }

    const rootDir = findWorkspaceRoot()
    const stringtablePath = resolve(rootDir, '..', 'stringtable.xml')

    if (!existsSync(stringtablePath))
        throw new Error(`stringtable not found at ${stringtablePath}`)

    const xml = await readFile(stringtablePath, 'utf8')
    const keys = parseKeys(xml)
    const marks = await readMarks(rootDir)

    if (options.fromTranslations) {
        for (const key of keys) {
            const translations = key.languages
                .map(entry => entry.language)
                .filter(language => language !== 'English')

            if (translations.length > 0)
                marks[key.id] = translations
        }
    }

    if (options.save) {
        for (const key of keys) {
            const aiLanguages = key.languages.filter(entry => entry.ai).map(entry => entry.language)
            if (aiLanguages.length > 0)
                marks[key.id] = aiLanguages
        }
    }

    for (const id of options.clear)
        delete marks[id]

    if (options.check) {
        let problems = 0

        for (const key of keys) {
            const marked = new Set(marks[key.id] ?? [])

            for (const entry of key.languages) {
                if (entry.language === 'English') {
                    if (entry.ai) {
                        console.log(`English must not be marked AI: ${key.id}`)
                        problems += 1
                    }
                    continue
                }

                if (marked.has(entry.language) && !entry.ai) {
                    console.log(`missing ai-translated: ${key.id} ${entry.language}`)
                    problems += 1
                } else if (!marked.has(entry.language) && entry.ai) {
                    console.log(`unexpected ai-translated: ${key.id} ${entry.language}`)
                    problems += 1
                }
            }
        }

        console.log(`${keys.length} keys, ${Object.values(marks).flat().length} AI translation(s), ${problems} problem(s)`)
        return
    }

    await writeMarks(rootDir, marks)
    await writeFile(stringtablePath, renderKeys(xml, marks), 'utf8')

    console.log(`${Object.keys(marks).length} key(s), ${Object.values(marks).flat().length} AI translation(s) marked`)
}
