// @ts-check
import { existsSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Directories of TacPhone apps that the development server should expose.
 *
 * An app is discovered when its folder is:
 * - listed in `dev-apps.local.json` (paths relative to this folder, or absolute),
 * - listed in the `TACPHONE_DEV_APPS` environment variable (same path rules),
 * - a direct child of `devapps` (the legacy location), or
 * - a sibling folder of this package whose `package.json` contains:
 *
 *   ```json
 *   "tacphone": { "app": "ACE_TacPhone_MyApp" }
 *   ```
 *
 * The declared app name must match the config class name (`ace_tacphone_apps`)
 * because it is also the routing key used by the game and the host.
 *
 * @typedef {'config' | 'env' | 'devapps' | 'sibling'} DevAppSource
 * @typedef {{ name: string, dir: string, source: DevAppSource }} DevApp
 * @typedef {{ apps: DevApp[], warnings: string[] }} DevAppDiscovery
 */

const CONFIG_FILE_NAME = 'dev-apps.local.json'
const ENV_VAR_NAME = 'TACPHONE_DEV_APPS'
const APP_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** @param {string} path */
async function isDirectory(path) {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}

/** @param {string} text */
function parseJson(text) {
    // PowerShell's Set-Content -Encoding utf8 writes a BOM.
    return JSON.parse(text.replace(/^\uFEFF/, ''))
}

/** @param {string} dir */
async function readPackageJson(dir) {
    const path = join(dir, 'package.json')
    if (!existsSync(path)) return undefined

    try {
        return parseJson(await readFile(path, 'utf8'))
    } catch {
        return undefined
    }
}

/**
 * @param {unknown} pkg
 * @returns {string | undefined}
 */
function declaredAppName(pkg) {
    if (typeof pkg !== 'object' || pkg === null) return undefined

    const tacphone = /** @type {{ tacphone?: unknown }} */ (pkg).tacphone
    if (typeof tacphone !== 'object' || tacphone === null) return undefined

    const app = /** @type {{ app?: unknown }} */ (tacphone).app
    return typeof app === 'string' && app.trim().length > 0 ? app.trim() : undefined
}

/**
 * @param {string} mainDir
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<DevAppDiscovery>}
 */
export async function discoverDevApps(mainDir, options = {}) {
    const env = options.env ?? process.env
    /** @type {Map<string, DevApp>} */
    const apps = new Map()
    /** @type {Map<string, string>} */
    const realDirs = new Map()
    /** @type {string[]} */
    const warnings = []

    /**
     * @param {string} dir
     * @param {DevAppSource} source
     * @param {boolean} requireDeclaration
     */
    async function add(dir, source, requireDeclaration) {
        const absoluteDir = resolve(dir)
        if (!(await isDirectory(absoluteDir))) {
            warnings.push(`Skipping TacPhone dev app "${absoluteDir}": the directory does not exist.`)
            return
        }

        let realDir
        try {
            realDir = await realpath(absoluteDir)
        } catch {
            realDir = absoluteDir
        }

        const pkg = await readPackageJson(absoluteDir)
        const name = declaredAppName(pkg) ?? (requireDeclaration ? undefined : basename(absoluteDir))

        if (!name) {
            warnings.push(
                `Skipping TacPhone dev app "${absoluteDir}": package.json has no "tacphone.app" name.`,
            )
            return
        }

        if (!APP_NAME_PATTERN.test(name)) {
            warnings.push(
                `Skipping TacPhone dev app "${absoluteDir}": "${name}" is not a valid app/config class name.`,
            )
            return
        }

        const existing = apps.get(name)
        if (existing) {
            if (existing.dir === realDir) return

            warnings.push(
                `Ignoring duplicate TacPhone dev app "${name}" at "${absoluteDir}"; `
                + `using "${existing.dir}" instead.`,
            )
            return
        }

        const previousUse = realDirs.get(realDir)
        if (previousUse && previousUse !== name) {
            warnings.push(
                `TacPhone dev app directory "${absoluteDir}" is already exposed as "${previousUse}"; `
                + `also exposing it as "${name}".`,
            )
        }

        realDirs.set(realDir, name)
        apps.set(name, { name, dir: realDir, source })
    }

    /** @param {unknown} value @param {DevAppSource} source */
    async function addConfiguredPath(value, source) {
        if (typeof value !== 'string' || value.trim().length === 0) return

        // Allow paths copied from Windows Explorer or JSON, which may keep surrounding quotes.
        const cleaned = value.trim().replace(/^"(.*)"$/, '$1')
        const dir = isAbsolute(cleaned) ? cleaned : resolve(mainDir, cleaned)
        await add(dir, source, false)
    }

    // 1. Explicit local configuration. This is git-ignored and easy to edit.
    const configPath = join(mainDir, CONFIG_FILE_NAME)
    if (existsSync(configPath)) {
        let config
        try {
            config = parseJson(await readFile(configPath, 'utf8'))
        } catch (error) {
            throw new Error(
                `Could not parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
            )
        }

        const entries = Array.isArray(config) ? config : config?.apps
        if (!Array.isArray(entries)) {
            throw new Error(
                `${configPath} must be an array of paths or an object with an "apps" array.`,
            )
        }

        for (const entry of entries) await addConfiguredPath(entry, 'config')
    }

    // 2. Environment override, handy for CI or one-off app locations.
    for (const entry of (env[ENV_VAR_NAME] ?? '').split(delimiter))
        await addConfiguredPath(entry, 'env')

    // 3. Legacy location. Keep working so existing checkouts do not need a rename.
    const devappsDir = join(mainDir, 'devapps')
    if (await isDirectory(devappsDir)) {
        for (const entry of await readdir(devappsDir, { withFileTypes: true })) {
            const dir = join(devappsDir, entry.name)
            if (await isDirectory(dir)) await add(dir, 'devapps', false)
        }
    }

    // 4. Sibling app repositories. A package marker is required so unrelated
    //    folders next to the host are never exposed by accident.
    const parentDir = dirname(mainDir)
    for (const entry of await readdir(parentDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

        const dir = join(parentDir, entry.name)
        if (resolve(dir) === resolve(mainDir)) continue
        if (!(await isDirectory(dir))) continue

        const pkg = await readPackageJson(dir)
        if (!declaredAppName(pkg)) continue

        await add(dir, 'sibling', true)
    }

    return { apps: [...apps.values()], warnings }
}
