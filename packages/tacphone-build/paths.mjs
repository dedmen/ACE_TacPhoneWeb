import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)))

/**
 * Finds the npm workspace root. Prefers the closest ancestor of the current
 * working directory whose package.json declares `workspaces`; falls back to the
 * parent of this package.
 */
export function findWorkspaceRoot(startDir = process.cwd()) {
    let dir = resolve(startDir)

    while (true) {
        const packagePath = join(dir, 'package.json')
        if (existsSync(packagePath)) {
            try {
                const pkg = JSON.parse(readFileSync(packagePath, 'utf8').replace(/^\uFEFF/, ''))
                if (pkg.workspaces) return dir
            } catch {
                // Ignore malformed package.json while walking up.
            }
        }

        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
    }

    return resolve(packageDir, '..', '..')
}

/** Absolute path of the host workspace package. */
export function hostDirFor(rootDir) {
    return join(rootDir, 'ACE_TacPhone_Main')
}

/** Formats a path relative to the workspace root with forward slashes. */
export function displayPath(rootDir, path) {
    return relative(rootDir, path).replaceAll('\\', '/')
}

export async function importDevApps(hostDir) {
    const modulePath = join(hostDir, 'dev-apps.js')
    if (!existsSync(modulePath))
        throw new Error(`${modulePath} does not exist; cannot discover development apps.`)

    return import(pathToFileURL(modulePath).href)
}

export { packageDir }
