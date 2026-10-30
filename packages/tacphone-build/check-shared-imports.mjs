#!/usr/bin/env node
// Verifies the host import map and every discovered development app bundle
// against the shared module list.
//
// Invoked from any workspace package: `tacphone-build check-shared-imports`.
// The workspace root and host package are located automatically.

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
    SHARED_MODULES,
    SHARED_MODULE_SPECIFIERS,
} from './shared-modules.js'
import { displayPath, findWorkspaceRoot, hostDirFor, importDevApps } from './paths.mjs'

/** Exports apps actually rely on; a namespace that was tree-shaken away fails here. */
const REQUIRED_EXPORTS = {
    'react': ['createElement', 'useState', 'Component'],
    'react-dom': ['createPortal', 'flushSync'],
    'react-dom/client': ['createRoot', 'hydrateRoot'],
    'react/jsx-runtime': ['jsx', 'jsxs'],
    'react/compiler-runtime': ['c'],
};

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

async function checkHostImportMap(rootDir, hostHtmlPath) {
    const html = await readFile(hostHtmlPath, 'utf8')
    const match = html.match(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/i)
    if (!match) {
        throw new Error(`${displayPath(rootDir, hostHtmlPath)} has no <script type="importmap"> block.`)
    }

    let importMap
    try {
        importMap = JSON.parse(match[1])
    } catch (error) {
        throw new Error(`${displayPath(rootDir, hostHtmlPath)} contains an invalid import map: ${error.message}`)
    }

    const imports = importMap.imports ?? {}
    const expected = new Set(SHARED_MODULE_SPECIFIERS)
    const missing = SHARED_MODULES
        .filter(({ specifier }) => typeof imports[specifier] !== 'string')
        .map(({ specifier }) => specifier)
    const unexpected = Object.keys(imports).filter(specifier => !expected.has(specifier))

    if (missing.length > 0) {
        throw new Error(
            `${displayPath(rootDir, hostHtmlPath)} is missing import map entries: ${missing.join(', ')}. `
            + 'The host import map and shared-modules.js are out of sync.',
        )
    }
    if (unexpected.length > 0) {
        throw new Error(
            `${displayPath(rootDir, hostHtmlPath)} has import map entries not declared in shared-modules.js: `
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
                + 'Check the namespaces in the host vite.config.ts.',
            )
        }

        for (const name of REQUIRED_EXPORTS[specifier] ?? []) {
            if (!value.includes(`export const ${name} =`)) {
                throw new Error(
                    `Import map entry "${specifier}" is missing the required export "${name}". `
                    + 'The host namespace was tree-shaken or the shared module list is wrong.',
                )
            }
        }
    }

    return Object.keys(imports).length
}

async function findAppBundles(hostDir) {
    const { discoverDevApps } = await importDevApps(hostDir)
    const { apps, warnings } = await discoverDevApps(hostDir)
    for (const warning of warnings) console.warn(`WARN ${warning}`)

    const bundles = []
    for (const app of apps) {
        const distDir = join(app.dir, 'dist')
        if (!existsSync(distDir)) continue

        for (const file of await readdir(distDir)) {
            if (file.endsWith('.js')) bundles.push(join(distDir, file))
        }
    }

    return bundles.sort((a, b) => a.localeCompare(b))
}

async function checkAppBundle(rootDir, path) {
    const source = await readFile(path, 'utf8')
    const bareSpecifiers = collectBareSpecifiers(source)
    const provided = new Set(SHARED_MODULE_SPECIFIERS)
    const missing = [...bareSpecifiers]
        .filter(specifier => !provided.has(specifier))
        .sort((a, b) => a.localeCompare(b))

    if (missing.length > 0) {
        throw new Error(
            `${displayPath(rootDir, path)} imports modules that the host import map does not provide: `
            + `${missing.join(', ')}. Add them to shared-modules.js (and the host globals), `
            + 'or bundle them into the app.',
        )
    }

    return bareSpecifiers.size
}

export async function runCheckSharedImports() {
    const rootDir = findWorkspaceRoot()
    const hostDir = hostDirFor(rootDir)
    const hostHtmlPath = join(hostDir, 'dist', 'index.html')

    let checks = 0

    if (existsSync(hostHtmlPath)) {
        const entries = await checkHostImportMap(rootDir, hostHtmlPath)
        console.log(`OK  host import map (${entries} entries)`)
        checks++
    } else {
        console.log('SKIP host import map (dist/index.html is not built)')
    }

    const bundles = await findAppBundles(hostDir)
    if (bundles.length === 0) {
        console.log('SKIP app bundles (no development app dist/*.js files found)')
    } else {
        for (const bundle of bundles) {
            const imports = await checkAppBundle(rootDir, bundle)
            console.log(`OK  ${displayPath(rootDir, bundle)} (${imports} bare imports)`)
            checks++
        }
    }

    if (checks === 0) {
        throw new Error(
            'Nothing to check. Build the host (npm run build) or an app before running this command.',
        )
    }
}
