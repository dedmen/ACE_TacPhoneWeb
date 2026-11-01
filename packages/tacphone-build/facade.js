// @ts-check
// Facade builds: expose a subpath-heavy library such as OpenLayers to a TacPhone
// app behind one declared prefix.
//
// An app cannot ship a whole library as separate chunks (a production app is one
// self-contained module), but it also cannot import `ol/Map` unless the module
// map knows that specifier. A facade build produces one plain ESM file that
// re-exports every module the app actually used and registers them under the
// facade prefix; the game ships that file as an app dependency and the import map
// maps `tacphone-ol/Map` and friends onto it.
//
// Two exports:
// - `tacphoneFacade(options)`: the Vite plugin used by the app build. It marks
//   the library external behind the prefix and records the specifiers used.
// - `runFacadeBuild(args)`: the `tacphone-build facade build` command that turns
//   the recorded specifiers into the single file the game loads.

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Keys an ES module namespace exposes that are not re-exportable bindings. */
const NON_EXPORTABLE_KEYS = new Set(['then', '__esModule'])

/**
 * Turns an arbitrary module key into a valid, unique-ish JS identifier fragment.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeIdentifier(name) {
    return name.replace(/[^A-Za-z0-9_$]/g, '_')
}

/**
 * Default manifest location, resolved against a Vite/app root.
 *
 * @param {string} root
 * @param {string} packageName
 * @returns {string}
 */
export function defaultManifestPath(root, packageName) {
    return join(root, 'node_modules', '.tacphone-facade', `${sanitizeIdentifier(packageName)}.json`)
}

/**
 * Vite plugin that externalizes a library behind a facade prefix.
 *
 * In a build every `packageName` and `packageName/subpath` import (except CSS)
 * resolves to `prefix + subpath`, is marked external, and is recorded in the
 * manifest. `runFacadeBuild` later reads that manifest to emit the facade file.
 * In dev the plugin is inert, so the real package resolves from `node_modules`.
 *
 * @param {{ packageName: string, prefix: string, manifestFile?: string }} options
 */
export function tacphoneFacade({ packageName, prefix, manifestFile }) {
    if (!packageName) throw new Error('tacphoneFacade: packageName is required.')
    if (!prefix) throw new Error('tacphoneFacade: prefix is required.')

    /** @type {Set<string>} */
    const specifiers = new Set()
    /** @type {string} */
    let root = process.cwd()

    return {
        name: 'tacphone-facade',
        enforce: /** @type {const} */ ('pre'),
        // Dev resolves the real package from node_modules; only a build needs the facade.
        apply: /** @type {const} */ ('build'),

        /** @param {{ root: string }} config */
        configResolved(config) {
            root = config.root
        },

        /**
         * @param {string} source
         * @returns {{ id: string, external: true } | null}
         */
        resolveId(source) {
            if (source !== packageName && !source.startsWith(`${packageName}/`)) return null
            // Stylesheets are inlined as data URLs by the single-file plugin, so
            // they must stay resolvable instead of becoming an external module.
            if (source.endsWith('.css')) return null

            specifiers.add(source)
            return { id: `${prefix}${source.slice(packageName.length)}`, external: true }
        },

        async buildEnd() {
            const target = manifestFile
                ? (isAbsolute(manifestFile) ? manifestFile : resolve(root, manifestFile))
                : defaultManifestPath(root, packageName)

            await mkdir(dirname(target), { recursive: true })
            await writeFile(
                target,
                `${JSON.stringify({
                    packageName,
                    prefix,
                    specifiers: [...specifiers].sort(),
                }, null, 2)}\n`,
                'utf8',
            )
        },
    }
}

/**
 * Parses `--flag value` / `--flag=value` pairs into an object.
 *
 * @param {string[]} args
 * @returns {Record<string, string>}
 */
function parseArgs(args) {
    /** @type {Record<string, string>} */
    const options = {}
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (arg === 'build') continue
        if (!arg.startsWith('--')) continue

        const eq = arg.indexOf('=')
        if (eq !== -1) {
            options[arg.slice(2, eq)] = arg.slice(eq + 1)
            continue
        }

        const value = args[index + 1]
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Missing value for ${arg}.`)
        }
        options[arg.slice(2)] = value
        index++
    }
    return options
}

/**
 * `tacphone-build facade build --app <dir> --package <name> --prefix <prefix> --out <file> [--manifest <file>]`
 *
 * @param {string[]} rawArgs
 */
export async function runFacadeBuild(rawArgs) {
    const args = parseArgs(rawArgs)
    for (const required of ['app', 'package', 'prefix', 'out']) {
        if (!args[required]) throw new Error(`Missing --${required}.`)
    }

    const appDir = resolve(args.app)
    const outPath = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out)
    const manifestPath = args.manifest
        ? (isAbsolute(args.manifest) ? args.manifest : resolve(process.cwd(), args.manifest))
        : defaultManifestPath(appDir, args.package)

    if (!existsSync(manifestPath)) {
        throw new Error(
            `Facade manifest ${manifestPath} does not exist. Build the app first: `
            + `the tacphoneFacade() Vite plugin writes it during the build.`,
        )
    }

    /** @type {{ packageName?: string, prefix?: string, specifiers?: string[] }} */
    const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''))
    const specifiers = manifest.specifiers ?? []
    if (specifiers.length === 0) {
        throw new Error(
            `${manifestPath} lists no specifiers. The app does not import "${args.package}" yet; `
            + 'build the app again after adding the import.',
        )
    }

    // Resolve every module from the app's own node_modules, so the facade always
    // matches the versions the app build resolved.
    const require = createRequire(join(appDir, 'package.json'))

    /** @type {string[]} */
    const importLines = []
    /** @type {string[]} */
    const exportLines = []
    /** @type {Record<string, { default?: string, named: Record<string, string> }>} */
    const facade = {}

    for (const [index, specifier] of specifiers.entries()) {
        const resolved = require.resolve(specifier)
        /** @type {Record<string, unknown>} */
        const namespace = await import(pathToFileURL(resolved).href)

        const alias = `__ns${index}`
        importLines.push(`import * as ${alias} from ${JSON.stringify(specifier)};`)

        const facadeKey = args.prefix + specifier.slice(args.package.length)
        /** @type {{ default?: string, named: Record<string, string> }} */
        const entry = { named: {} }

        for (const key of Object.keys(namespace)) {
            if (NON_EXPORTABLE_KEYS.has(key)) continue

            if (key === 'default') {
                const binding = `__tacphone_${index}_default`
                exportLines.push(`export const ${binding} = ${alias}.default;`)
                entry.default = binding
                continue
            }

            const binding = `__tacphone_${index}_${sanitizeIdentifier(key)}`
            exportLines.push(`export const ${binding} = ${alias}.${key};`)
            entry.named[key] = binding
        }

        facade[facadeKey] = entry
    }

    const entrySource = [
        '// Generated by tacphone-build facade build. Do not edit.',
        ...importLines,
        ...exportLines,
        `export const __tacphoneFacade = ${JSON.stringify(facade, null, 2)};`,
        '',
    ].join('\n')

    const { build } = await import('vite')
    // Self-reference through the package `exports` map; Node's type stripping
    // loads the TypeScript plugin source directly.
    const { viteSingleFile } = await import('@ace-tacphone/build/singlefile')

    const tempDir = join(appDir, 'node_modules', '.tacphone-facade', `build-${args.package}`)
    const tempOutDir = join(tempDir, 'dist')
    const tempEntry = join(tempDir, 'entry.js')
    const fileName = outPath.replaceAll('\\', '/').split('/').pop() ?? 'facade.js'

    await mkdir(tempDir, { recursive: true })
    await writeFile(tempEntry, entrySource, 'utf8')

    try {
        await build({
            configFile: false,
            root: appDir,
            logLevel: 'warn',
            plugins: [viteSingleFile({ failOnNotInlined: true })],
            build: {
                minify: 'oxc',
                lib: {
                    entry: tempEntry,
                    formats: ['es'],
                    fileName: () => fileName,
                },
                rollupOptions: {
                    output: { codeSplitting: false },
                },
                outDir: tempOutDir,
                emptyOutDir: true,
            },
        })

        const builtPath = join(tempOutDir, fileName)
        if (!existsSync(builtPath)) {
            throw new Error(`Vite did not write ${builtPath}.`)
        }

        const output = await readFile(builtPath, 'utf8')
        await mkdir(dirname(outPath), { recursive: true })
        await writeFile(outPath, output, 'utf8')
    } finally {
        await rm(tempDir, { recursive: true, force: true })
    }

    const size = (await stat(outPath)).size
    console.log(`OK  facade ${args.package} -> ${outPath} (${size} bytes, ${specifiers.length} modules)`)
}
