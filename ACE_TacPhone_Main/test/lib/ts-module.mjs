/**
 * In-memory TypeScript module loader for the game-free unit tier.
 *
 * The unit tests import app sources (`RouteSplice.ts`, `objectCodec.ts`, ...),
 * which use extensionless relative imports and TypeScript syntax. Neither
 * `node x.ts` nor a type-stripping hook resolves those portably across the
 * documented Node range, so each unit module is bundled by Vite into a single
 * ESM string and imported from a `data:` URL:
 *
 * - no artifacts (`write: false`, nothing lands in `dist/`);
 * - the same TypeScript pipeline as the app build;
 * - `vite` is already a workspace devDependency, so no new dependency.
 *
 * Only modules that are safe to evaluate outside a browser may be imported.
 * `src/MapGps/GpsModule.ts` is the documented counter-example: it imports
 * OpenLayers and touches the DOM, so importing it fails (see
 * `gps-payload.unit.mjs`, which asserts that failure on purpose).
 */

import path from 'node:path';

import { SkipError } from './skip.mjs';

/** Bundles already loaded, keyed by `<root>|<entry>`. */
const cache = new Map();

/** Modules that must never be inlined into a unit bundle. */
const DEFAULT_EXTERNALS = [/^node:/, /^playwright/];

/**
 * Bundles one module (a test module that imports pure app sources) and imports
 * it from a `data:` URL.
 *
 * @param {string} entryPath Absolute path of the entry module.
 * @param {{ root?: string, externals?: RegExp[] }} [options]
 *   `root` is the app directory Vite resolves relative imports from.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 * @throws {SkipError} When `vite` is not installed.
 */
export async function loadAppModule(entryPath, options = {}) {
    const root = options.root ?? process.cwd();
    const entry = path.resolve(entryPath);
    const key = `${root}|${entry}`;

    const cached = cache.get(key);
    if (cached) {
        return cached;
    }

    const promise = buildAndImport(entry, root, options.externals ?? []);
    cache.set(key, promise);

    return promise;
}

/** Drops the bundle cache; only useful between suites in one process. */
export function resetAppModuleCache() {
    cache.clear();
}

async function buildAndImport(entry, root, extraExternals) {
    const vite = await importVite();
    let output;

    try {
        output = await vite.build({
            configFile: false,
            root,
            logLevel: 'error',
            build: {
                write: false,
                minify: false,
                target: 'node20',
                lib: {
                    entry,
                    formats: ['es'],
                    fileName: 'unit',
                },
                rollupOptions: {
                    external: [...DEFAULT_EXTERNALS, ...extraExternals],
                },
            },
        });
    } catch (error) {
        throw new Error(
            `Could not bundle ${entry} for the unit tier:\n${describeError(error)}`,
            { cause: error },
        );
    }

    const results = Array.isArray(output) ? output : [output];
    const chunk = results
        .flatMap(result => result.output ?? [])
        .find(item => item.type === 'chunk' && typeof item.code === 'string');

    if (!chunk) {
        throw new Error(`Bundling ${entry} produced no JavaScript chunk`);
    }

    const url = `data:text/javascript;base64,${Buffer.from(chunk.code, 'utf8').toString('base64')}`;

    try {
        return await import(url);
    } catch (error) {
        throw new Error(
            `Could not evaluate ${entry}; the module likely touches browser globals ` +
            `at module scope and must not be imported by a unit test:\n${describeError(error)}`,
            { cause: error },
        );
    }
}

async function importVite() {
    try {
        return await import('vite');
    } catch (error) {
        throw new SkipError(
            'vite is not installed, so the unit tier cannot bundle TypeScript sources. ' +
            `Run "npm install" in webspace root first (${describeError(error)}).`,
        );
    }
}

function describeError(error) {
    if (error && typeof error === 'object' && 'message' in error) {
        return String(error.message);
    }

    return String(error);
}
