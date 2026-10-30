#!/usr/bin/env node
import { runBundleApiTypes } from '../api-types.mjs'
import { runSyncApiTypes } from '../sync-api-types.mjs'
import { runCheckSharedImports } from '../check-shared-imports.mjs'

const [command, ...args] = process.argv.slice(2)

const commands = {
    'bundle-api-types': runBundleApiTypes,
    'sync-api-types': runSyncApiTypes,
    'check-shared-imports': runCheckSharedImports,
}

const usage = `Usage: tacphone-build <command> [options]

Commands:
  bundle-api-types --app <dir> [--entry src/api.ts] [--name <name>] [--output <file>]
  sync-api-types <source.d.ts> <target-dir-or-file>...
  check-shared-imports
`

if (!command || !(command in commands)) {
    if (command && command !== '--help' && command !== '-h')
        console.error(`Unknown command: ${command}\n`)
    console.error(usage)
    process.exitCode = command && command !== '--help' && command !== '-h' ? 1 : 0
} else {
    try {
        await commands[command](args)
    } catch (error) {
        console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
    }
}
