#!/usr/bin/env node
// Copy the generated dist/TacPhoneMain.d.ts into development apps.
//
// With no arguments, every discovered development app's src directory is
// updated. Discovery includes devapps/, sibling folders with a "tacphone.app"
// package field, dev-apps.local.json, and TACPHONE_DEV_APPS.
//
// Pass one or more target directories (or explicit .d.ts paths) to update a
// specific app:
//
//   node scripts/sync-api-types.mjs ..\..\my_app\src

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverDevApps } from '../dev-apps.js'

const mainDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(mainDir, 'dist', 'TacPhoneMain.d.ts')
const fileName = 'TacPhoneMain.d.ts'

function displayPath(path) {
    return relative(mainDir, path).replaceAll('\\', '/')
}

async function findDevAppTargets() {
    const { apps, warnings } = await discoverDevApps(mainDir)
    for (const warning of warnings) console.warn(`WARN ${warning}`)

    const targets = []
    for (const app of apps) {
        const srcDir = join(app.dir, 'src')
        if (existsSync(srcDir)) targets.push(join(srcDir, fileName))
    }

    return targets.sort()
}

function resolveTargets(args) {
    if (args.length === 0) return findDevAppTargets()

    return args.map(argument => {
        const path = resolve(process.cwd(), argument)
        return path.endsWith('.d.ts') ? path : join(path, fileName)
    })
}

async function readIfExists(path) {
    try {
        return await readFile(path, 'utf8')
    } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
    }
}

try {
    if (!existsSync(sourcePath)) {
        throw new Error(
            `${displayPath(sourcePath)} does not exist. Run "npm run build" first.`,
        )
    }

    const source = await readFile(sourcePath, 'utf8')
    const targets = await resolveTargets(process.argv.slice(2))

    if (targets.length === 0) {
        console.log('SKIP api types (no development app src directories found)')
    } else {
        let updated = 0
        let upToDate = 0

        for (const target of targets) {
            if (await readIfExists(target) === source) {
                console.log(`OK  ${displayPath(target)} (up to date)`)
                upToDate++
                continue
            }

            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, source)
            console.log(`OK  ${displayPath(target)} (updated)`)
            updated++
        }

        console.log(
            `Synced ${displayPath(sourcePath)} (${updated} updated, ${upToDate} up to date).`,
        )
    }
} catch (error) {
    console.error(`FAIL ${error.message}`)
    process.exitCode = 1
}
