#!/usr/bin/env node
// Copy a generated app service declaration into explicit consumer targets.
//
//   tacphone-build sync-api-types <source.d.ts> <target-dir-or-file>...
//
// The host contract itself comes from @ace-tacphone/api; this command only
// distributes app service declarations such as the Map's generated d.ts.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { displayPath, findWorkspaceRoot } from './paths.mjs'

function resolveTargets(cwd, args, fileName) {
    return args.map(argument => {
        const path = resolve(cwd, argument)
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

export async function runSyncApiTypes(argv = process.argv.slice(2)) {
    if (argv.length < 2) {
        throw new Error(
            'sync-api-types needs a source .d.ts and at least one target: '
            + 'tacphone-build sync-api-types <source.d.ts> <target-dir-or-file>...',
        )
    }

    const rootDir = findWorkspaceRoot()
    const cwd = process.cwd()
    const sourcePath = resolve(cwd, argv[0])
    const fileName = basename(sourcePath)

    if (!sourcePath.endsWith('.d.ts'))
        throw new Error(`The source must be a .d.ts file: ${argv[0]}`)

    if (!existsSync(sourcePath))
        throw new Error(`${displayPath(rootDir, sourcePath)} does not exist. Build the app first.`)

    const source = await readFile(sourcePath, 'utf8')
    const targets = resolveTargets(cwd, argv.slice(1), fileName)

    let updated = 0
    let upToDate = 0

    for (const target of targets) {
        if (await readIfExists(target) === source) {
            console.log(`OK  ${displayPath(rootDir, target)} (up to date)`)
            upToDate++
            continue
        }

        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, source)
        console.log(`OK  ${displayPath(rootDir, target)} (updated)`)
        updated++
    }

    console.log(
        `Synced ${displayPath(rootDir, sourcePath)} (${updated} updated, ${upToDate} up to date).`,
    )
}
