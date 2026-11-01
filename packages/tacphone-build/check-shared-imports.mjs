#!/usr/bin/env node
// Verifies the host import map and every discovered development app bundle
// against the shared module list.
//
// App bundles are stored as `TACPHONE-BUNDLE:<version>:<codec>:<base64>`; they
// are decoded before scanning. A bundle that is not compressed is a hard error
// for the package that owns it (an app's own build must produce one) and a
// warning elsewhere, so building one app does not fail because another app's
// `dist/` is stale. The workspace-wide run treats every bundle as its own.
//
// Import specifiers are extracted with `es-module-lexer`, which understands the
// whole module syntax (including dynamic imports) and ignores comments and
// string literals that merely look like imports. It does not parse JSX, so this
// command must only ever be pointed at built JavaScript.
//
// Invoked from any workspace package: `tacphone-build check-shared-imports`.
// The workspace root and host package are located automatically.

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { init, parse } from 'es-module-lexer'
import {
    SHARED_MODULES,
    SHARED_MODULE_SPECIFIERS,
} from './shared-modules.js'
import { decodeAppBundle } from './bundle-format.node.mjs'
import { displayPath, findWorkspaceRoot, hostDirFor, importDevApps } from './paths.mjs'

/** Exports apps actually rely on; a namespace that was tree-shaken away fails here. */
const REQUIRED_EXPORTS = {
    'react': ['createElement', 'useState', 'Component'],
    'react-dom': ['createPortal', 'flushSync'],
    'react-dom/client': ['createRoot', 'hydrateRoot'],
    'react/jsx-runtime': ['jsx', 'jsxs'],
    'react/compiler-runtime': ['c'],
};

const DEPENDENCY_HINT = 'bundle it, declare it in package.json "tacphone.dependencies", '
    + 'or add it to shared-modules.js'

/** True when the value is a `data:` or `blob:` URL, the only fetchable schemes in game. */
function isInlineUrl(specifier) {
    return specifier.startsWith('data:') || specifier.startsWith('blob:')
}

function isRelativeSpecifier(specifier) {
    return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')
}

function hasUrlScheme(specifier) {
    return specifier.startsWith('//') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)
}

/**
 * Reads the application dependencies declared in an app's `package.json`.
 *
 * `tacphone.dependencies` maps a bare specifier to options. A `facade` value is
 * a prefix such as `tacphone-ol/`: the app build externalizes the library behind
 * that prefix, and the game supplies those modules at runtime.
 */
async function readAppDependencies(appDir) {
    const pkg = JSON.parse((await readFile(join(appDir, 'package.json'), 'utf8')).replace(/^\uFEFF/, ''))
    const dependencies = pkg?.tacphone?.dependencies ?? {}
    return {
        specifiers: new Set(Object.keys(dependencies)),
        facadePrefixes: Object.values(dependencies)
            .map(entry => typeof entry?.facade === 'string' ? entry.facade : null)
            .filter(Boolean),
    }
}

/**
 * True when a specifier belongs to a declared facade prefix.
 *
 * The prefix may be written with or without a trailing slash (`tacphone-ol`
 * and `tacphone-ol/` both cover `tacphone-ol` itself and `tacphone-ol/Map`).
 */
function matchesFacade(specifier, prefix) {
    const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
    return specifier === base || specifier.startsWith(`${base}/`)
}

/**
 * Waits for the lexer's WebAssembly instance.
 *
 * `es-module-lexer` exports `init` as a promise in its ESM build and as a
 * function in older/variant builds; both shapes are supported here so a version
 * bump cannot break the checker.
 */
async function ensureLexerReady() {
    if (typeof init === 'function') {
        await init()
    } else if (init && typeof init.then === 'function') {
        await init
    }
}

/**
 * Collects every import specifier of a built module.
 *
 * `parse` returns one entry per import statement; `n` is the literal specifier
 * (undefined for a computed dynamic import) and `d` is `-1` for a static import,
 * `>= 0` for a dynamic one, and `-2` for `import.meta`. It may return a promise
 * until the lexer finished initializing, so the result is always awaited.
 */
async function collectImports(source) {
    const [imports] = await parse(source)
    return imports
        .filter(entry => entry.d !== -2)
        .map(entry => entry.n)
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

    for (const { specifier } of SHARED_MODULES) {
        const value = imports[specifier]
        if (!value.startsWith('data:text/javascript,')) {
            throw new Error(`Import map entry "${specifier}" is not a data:text/javascript URL.`)
        }
        if (!value.includes(`window.TacPhone.modules.get("${specifier}")`)) {
            throw new Error(
                `Import map entry "${specifier}" does not read window.TacPhone.modules.get("${specifier}"). `
                + 'Check the module map generated by the host vite.config.ts.',
            )
        }
        // Shared modules are published on the module map, never on a per-module
        // window global; a leftover `window.React` style read would silently
        // resolve to undefined in game.
        if (/\bwindow\.(React|ReactDOM|ReactDOMClient|ReactJSXRuntime|ReactCompilerRuntime|QRCode)\b/.test(value)) {
            throw new Error(
                `Import map entry "${specifier}" reads a legacy window global instead of window.TacPhone.modules. `
                + 'Check the module map generated by the host vite.config.ts.',
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

/**
 * Finds every built app bundle together with the app folder it belongs to, so
 * the checker can read that app's `package.json` dependencies.
 */
async function findAppBundles(hostDir) {
    const { discoverDevApps } = await importDevApps(hostDir)
    const { apps, warnings } = await discoverDevApps(hostDir)
    for (const warning of warnings) console.warn(`WARN ${warning}`)

    const bundles = []
    for (const app of apps) {
        const distDir = join(app.dir, 'dist')
        if (!existsSync(distDir)) continue

        for (const file of await readdir(distDir)) {
            if (file.endsWith('.js')) bundles.push({ path: join(distDir, file), appDir: app.dir })
        }
    }

    return bundles.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * True when the bundle belongs to the package whose build is running.
 *
 * `npm run build -w <app>` runs this command with the app folder as cwd, so its
 * own `dist/` is checked strictly while other apps may still hold stale
 * artifacts. Running the command from the workspace root checks every bundle
 * strictly.
 */
function isOwnBundle(rootDir, path) {
    const cwd = process.cwd()
    if (cwd === rootDir) return true
    return dirname(path) === join(cwd, 'dist')
}

/** Builds the error text for a specifier the in-game loader cannot resolve. */
function describeRejectedSpecifier(path, specifier) {
    if (hasUrlScheme(specifier)) {
        return `${path} imports the URL "${specifier}". The in-game browser cannot fetch the network `
            + `or local files, so ${DEPENDENCY_HINT}. Only data: and blob: URLs are allowed.`
    }
    if (isRelativeSpecifier(specifier)) {
        return `${path} imports the relative module "${specifier}". A production app is one self-contained `
            + `module, so ${DEPENDENCY_HINT}.`
    }
    return `${path} imports "${specifier}", which is neither a shared module nor a declared app dependency. `
        + `Fix: ${DEPENDENCY_HINT}.`
}

/**
 * Checks one app bundle and returns the number of imports it declares. Returns
 * `null` after warning when the bundle is not a TacPhone bundle and does not
 * belong to the current package, because the shared-import check cannot say
 * anything about it.
 */
async function checkAppBundle(rootDir, path, appDir) {
    const encoded = await readFile(path, 'utf8')

    // Every app bundle is stored as `TACPHONE-BUNDLE:<version>:<codec>:<base64>`
    // so it can travel through SQF string file loading. Decode it before scanning;
    // a plain JavaScript build here means a stale artifact or a broken build.
    let source
    try {
        source = decodeAppBundle(encoded)
    } catch (error) {
        const message = `${displayPath(rootDir, path)} is not a compressed TacPhone app bundle (${error.message}). `
            + 'Rebuild the app with the current @ace-tacphone/build.'
        if (isOwnBundle(rootDir, path)) throw new Error(message)
        console.warn(`WARN ${message}`)
        return null
    }

    const shownPath = displayPath(rootDir, path)
    const dependencies = await readAppDependencies(appDir)
    const shared = new Set(SHARED_MODULE_SPECIFIERS)
    const imports = await collectImports(source)
    const problems = []

    for (const specifier of imports) {
        if (specifier === undefined) {
            problems.push(
                `${shownPath} has a dynamic import with a computed URL. The in-game loader cannot resolve `
                + `it; use a static specifier or ${DEPENDENCY_HINT.replace('bundle it', 'a bundled chunk')}.`,
            )
            continue
        }

        if (isInlineUrl(specifier)) continue
        if (isRelativeSpecifier(specifier) || hasUrlScheme(specifier)) {
            problems.push(describeRejectedSpecifier(shownPath, specifier))
            continue
        }
        if (shared.has(specifier)) continue
        if (dependencies.specifiers.has(specifier)) continue
        if (dependencies.facadePrefixes.some(prefix => matchesFacade(specifier, prefix))) continue

        // A static bare import of an undeclared dependency is as fatal as a
        // dynamic one; both produce a module the import map cannot resolve.
        problems.push(describeRejectedSpecifier(shownPath, specifier))
    }

    if (problems.length > 0) {
        throw new Error(problems.join('\n'))
    }

    return imports.length
}

export async function runCheckSharedImports() {
    const rootDir = findWorkspaceRoot()
    const hostDir = hostDirFor(rootDir)
    const hostHtmlPath = join(hostDir, 'dist', 'index.html')

    // Must run once before the first `parse` call.
    await ensureLexerReady()

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
        for (const { path, appDir } of bundles) {
            const imports = await checkAppBundle(rootDir, path, appDir)
            if (imports !== null) {
                console.log(`OK  ${displayPath(rootDir, path)} (${imports} imports)`)
            }
            checks++
        }
    }

    if (checks === 0) {
        throw new Error(
            'Nothing to check. Build the host (npm run build) or an app before running this command.',
        )
    }
}
