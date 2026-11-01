#!/usr/bin/env node
// Safety net for the web UI localization: every STR_ACE_Tacphone_* key used by
// web code must exist in the add-on stringtable and have an English entry.
//
// The reverse is reported but not fatal: a stringtable key may be used only by
// the game side (SQF, settings, HUD) and never appear in web code.
//
// Invoked from the workspace root: `tacphone-build check-strings`.

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { findWorkspaceRoot } from './paths.mjs'
import { readStringtable } from './stringtable.mjs'

/** Source folders that may reference a translation key. */
const SCAN_DIRS = [
    'ACE_TacPhone_Main/src',
    'ACE_TacPhone_Map/src',
    'MessagingApp/src',
    'SampleApp/src',
]

/** File extensions that can contain a `t()` call. */
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])

const KEY_PATTERN = /STR_ACE_Tacphone_[A-Za-z0-9_]+/g

/** Every source file below `dir`, recursively; missing folders are skipped. */
async function listSourceFiles(dir) {
    if (!existsSync(dir))
        return []

    const entries = await readdir(dir, { withFileTypes: true })
    const files = []

    for (const entry of entries) {
        const path = join(dir, entry.name)

        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'data')
                continue

            files.push(...await listSourceFiles(path))
        } else if (SCAN_EXTENSIONS.has(extname(entry.name))) {
            files.push(path)
        }
    }

    return files
}

/**
 * Scans the web sources for translation keys and compares them with the
 * add-on stringtable. Returns true when everything is defined.
 */
export async function runCheckStrings() {
    const rootDir = findWorkspaceRoot()
    const addonDir = resolve(rootDir, '..')
    const stringtablePath = join(addonDir, 'stringtable.xml')

    if (!existsSync(stringtablePath)) {
        console.error(`FAIL stringtable not found at ${stringtablePath}`)
        return false
    }

    let table
    try {
        table = readStringtable(stringtablePath)
    } catch (error) {
        console.error(`FAIL could not parse ${stringtablePath}: ${error instanceof Error ? error.message : error}`)
        return false
    }

    const english = table.English ?? {}
    const defined = new Set(Object.keys(english))

    /** key -> first place that uses it */
    const used = new Map()
    const files = (await Promise.all(SCAN_DIRS.map(dir => listSourceFiles(join(rootDir, dir))))).flat()

    for (const file of files) {
        const text = await readFile(file, 'utf8')
        for (const match of text.matchAll(KEY_PATTERN)) {
            const key = match[0]
            if (!used.has(key))
                used.set(key, relative(rootDir, file).replaceAll('\\', '/'))
        }
    }

    const missing = [...used].filter(([key]) => !defined.has(key))
    const missingEnglish = [...used]
        .filter(([key]) => defined.has(key) && english[key].trim().length === 0)

    for (const [key, file] of missing)
        console.error(`FAIL ${key} is used in ${file} but is not defined in ${stringtablePath}`)

    for (const [key, file] of missingEnglish)
        console.error(`FAIL ${key} is used in ${file} but has no English text`)

    const unused = [...defined].filter(key => !used.has(key)).sort()

    if (unused.length > 0) {
        console.log(`note: ${unused.length} stringtable key(s) are not referenced by web code:`)
        for (const key of unused)
            console.log(`  ${key}`)
    }

    const failed = missing.length + missingEnglish.length
    if (failed > 0) {
        console.error(`FAIL ${failed} localization key(s) are missing or incomplete.`)
        return false
    }

    console.log(`OK ${used.size} localization key(s) used by web code, all defined.`)
    return true
}
