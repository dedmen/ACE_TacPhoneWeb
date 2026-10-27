#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    SHARED_MODULES,
    SHARED_MODULE_SPECIFIERS,
} from '../shared-modules.js'

const mainDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostHtmlPath = join(mainDir, 'dist', 'index.html')
const devappsDir = join(mainDir, 'devapps')

function displayPath(path) {
    return relative(mainDir, path).replaceAll('\\', '/')
}

function isBareSpecifier(specifier) {
    return !specifier.startsWith('.')
        && !specifier.startsWith('/')
        && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)
}

function skipTrivia(source, start) {
    let index = start

    while (index < source.length) {
        const char = source[index]

        if (/\s/.test(char)) {
            index++
            continue
        }

        if (char === '/' && source[index + 1] === '/') {
            const end = source.indexOf('\n', index + 2)
            if (end === -1) return source.length
            index = end + 1
            continue
        }

        if (char === '/' && source[index + 1] === '*') {
            const end = source.indexOf('*/', index + 2)
            if (end === -1) return source.length
            index = end + 2
            continue
        }

        break
    }

    return index
}

/**
 * Collect bare specifiers from the static import declarations that a bundler
 * emits at the top of a module. Scanning only the import prologue avoids
 * matching example imports inside comments, which the debug build keeps.
 */
function collectBareSpecifiers(source) {
    const specifiers = new Set()
    let index = skipTrivia(source, 0)

    while (source.startsWith('import', index)) {
        const nextChar = source[index + 'import'.length]
        if (nextChar && /[\w$]/.test(nextChar)) break

        // An import declaration's first semicolon is its terminator: the import
        // clause cannot contain string literals before the module specifier.
        const end = source.indexOf(';', index)
        if (end === -1) break

        const statement = source.slice(index, end + 1)
        const match = statement.match(/\bfrom\s*["']([^"']+)["']/)
            ?? statement.match(/^import\s*["']([^"']+)["']/)

        if (match && isBareSpecifier(match[1])) specifiers.add(match[1])

        index = skipTrivia(source, end + 1)
    }

    return specifiers
}

async function checkHostImportMap() {
    const html = await readFile(hostHtmlPath, 'utf8')
    const match = html.match(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/i)
    if (!match) {
        throw new Error(`${displayPath(hostHtmlPath)} has no <script type="importmap"> block.`)
    }

    let importMap
    try {
        importMap = JSON.parse(match[1])
    } catch (error) {
        throw new Error(`${displayPath(hostHtmlPath)} contains an invalid import map: ${error.message}`)
    }

    const imports = importMap.imports ?? {}
    const expected = new Set(SHARED_MODULE_SPECIFIERS)
    const missing = SHARED_MODULES
        .filter(({ specifier }) => typeof imports[specifier] !== 'string')
        .map(({ specifier }) => specifier)
    const unexpected = Object.keys(imports).filter(specifier => !expected.has(specifier))

    if (missing.length > 0) {
        throw new Error(
            `${displayPath(hostHtmlPath)} is missing import map entries: ${missing.join(', ')}. `
            + 'The host import map and shared-modules.js are out of sync.',
        )
    }
    if (unexpected.length > 0) {
        throw new Error(
            `${displayPath(hostHtmlPath)} has import map entries not declared in shared-modules.js: `
            + `${unexpected.join(', ')}.`,
        )
    }

    for (const { specifier, global } of SHARED_MODULES) {
        const value = imports[specifier]
        if (!value.startsWith('data:text/javascript,')) {
            throw new Error(`Import map entry "${specifier}" is not a data:text/javascript URL.`)
        }
        if (!value.includes(`window.${global}`)) {
            throw new Error(
                `Import map entry "${specifier}" does not read window.${global}. `
                + 'Check the namespaces in vite.config.ts.',
            )
        }
    }

    return Object.keys(imports).length
}

async function findAppBundles() {
    if (!existsSync(devappsDir)) return []

    const bundles = []
    for (const entry of await readdir(devappsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue

        const distDir = join(devappsDir, entry.name, 'dist')
        if (!existsSync(distDir)) continue

        for (const file of await readdir(distDir)) {
            if (file.endsWith('.js')) bundles.push(join(distDir, file))
        }
    }

    return bundles.sort((a, b) => a.localeCompare(b))
}

async function checkAppBundle(path) {
    const source = await readFile(path, 'utf8')
    const bareSpecifiers = collectBareSpecifiers(source)
    const provided = new Set(SHARED_MODULE_SPECIFIERS)
    const missing = [...bareSpecifiers]
        .filter(specifier => !provided.has(specifier))
        .sort((a, b) => a.localeCompare(b))

    if (missing.length > 0) {
        throw new Error(
            `${displayPath(path)} imports modules that the host import map does not provide: `
            + `${missing.join(', ')}. Add them to shared-modules.js (and the host globals), `
            + 'or bundle them into the app.',
        )
    }

    return bareSpecifiers.size
}

try {
    let checks = 0

    if (existsSync(hostHtmlPath)) {
        const entries = await checkHostImportMap()
        console.log(`OK  host import map (${entries} entries)`)
        checks++
    } else {
        console.log('SKIP host import map (dist/index.html is not built)')
    }

    const bundles = await findAppBundles()
    if (bundles.length === 0) {
        console.log('SKIP app bundles (no devapps/*/dist/*.js files found)')
    } else {
        for (const bundle of bundles) {
            const imports = await checkAppBundle(bundle)
            console.log(`OK  ${displayPath(bundle)} (${imports} bare imports)`)
            checks++
        }
    }

    if (checks === 0) {
        throw new Error(
            'Nothing to check. Build the host (npm run build) or an app before running this script.',
        )
    }
} catch (error) {
    console.error(`FAIL ${error.message}`)
    process.exitCode = 1
}
