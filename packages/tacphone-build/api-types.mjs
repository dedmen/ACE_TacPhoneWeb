#!/usr/bin/env node
// Bundle one app's service declarations into a self-contained .d.ts.
//
//   tacphone-build bundle-api-types --app . --entry src/api.ts --name ACE_TacPhone_Map
//
// Every TacPhone app exports its inter-app service contract from `src/api.ts`
// (the Map's `MapApi` is the reference). The host contract itself comes from
// @ace-tacphone/api and is never copied into an app.

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor'
import ts from 'typescript'
import { displayPath, findWorkspaceRoot } from './paths.mjs'

function extractorConfig({ projectFolder, mainEntryPointFilePath, tsconfigFilePath, publicTrimmedFilePath, packageJsonFullPath, configObjectFullPath }) {
    return ExtractorConfig.prepare({
        configObject: {
            projectFolder,
            mainEntryPointFilePath,
            compiler: {
                tsconfigFilePath,
            },
            apiReport: {
                enabled: false,
            },
            docModel: {
                enabled: false,
            },
            dtsRollup: {
                enabled: true,
                publicTrimmedFilePath,
            },
            tsdocMetadata: {
                enabled: false,
            },
            messages: {
                compilerMessageReporting: {
                    default: { logLevel: 'none' },
                },
                extractorMessageReporting: {
                    default: { logLevel: 'none' },
                },
                tsdocMessageReporting: {
                    default: { logLevel: 'none' },
                },
            },
        },
        configObjectFullPath,
        packageJsonFullPath,
    })
}

function invokeExtractor(config, label) {
    const result = Extractor.invoke(config, {
        localBuild: false,
        showVerboseMessages: false,
        showDiagnostics: false,
    })

    if (!result.succeeded) {
        throw new Error(`API Extractor failed to bundle the ${label} declarations.`)
    }
}

/** Reads --app/--entry/--output/--name from the command line. */
function parseOptions(argv) {
    const options = {}

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]

        if (argument === '--app') options.appDir = argv[++index]
        else if (argument === '--entry') options.entry = argv[++index]
        else if (argument === '--output') options.output = argv[++index]
        else if (argument === '--name') options.name = argv[++index]
    }

    return options
}

/** Resolves the default output path for an app from package.json. */
function defaultAppOutput(appDir, name, packageJson) {
    if (typeof packageJson.types === 'string' && packageJson.types.length > 0) {
        return resolve(appDir, packageJson.types)
    }

    if (typeof packageJson.main === 'string' && packageJson.main.endsWith('.js')) {
        return resolve(appDir, packageJson.main.replace(/\.js$/, '.d.ts'))
    }

    const fileName = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    return resolve(appDir, 'dist', `${fileName}.d.ts`)
}

/** Collects the names exported by a program's source file. */
function moduleExportNames(program, filePath) {
    const sourceFile = program.getSourceFile(filePath)
    if (!sourceFile) return []

    const checker = program.getTypeChecker()
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    if (!moduleSymbol) return []

    return checker.getExportsOfModule(moduleSymbol)
        .map(symbol => symbol.getName())
        .filter(name => name !== 'default')
}

function getExportedNames(sourceFile) {
    const names = new Set()

    sourceFile.forEachChild(node => {
        const modifiers = node.modifiers ?? []
        const exported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)

        if (exported) {
            if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text)

            if (ts.isVariableStatement(node)) {
                for (const declaration of node.declarationList.declarations) {
                    if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
                }
            }
        }

        if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const element of node.exportClause.elements) names.add(element.name.text)
        }
    })

    return names
}

async function bundleAppDeclarations(rootDir, options) {
    const appDir = resolve(process.cwd(), options.appDir ?? '.')
    const entry = resolve(appDir, options.entry ?? 'src/api.ts')
    const tsconfigPath = join(appDir, 'tsconfig.app.json')

    if (!existsSync(entry))
        throw new Error(`${entry} does not exist. Pass --entry <app-relative file>.`)

    if (!existsSync(tsconfigPath))
        throw new Error(`${tsconfigPath} does not exist. App mode expects a tsconfig.app.json.`)

    const packagePath = join(appDir, 'package.json')
    const packageJson = existsSync(packagePath)
        ? JSON.parse((await readFile(packagePath, 'utf8')).replace(/^\uFEFF/, ''))
        : {}
    const displayName = options.name ?? packageJson.name ?? basename(appDir)
    const output = options.output
        ? resolve(appDir, options.output)
        : defaultAppOutput(appDir, displayName, packageJson)

    const configFile = ts.readConfigFile(tsconfigPath, fileName => ts.sys.readFile(fileName))
    if (configFile.error)
        throw new Error(`Could not read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`)

    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, appDir)
    const tempDir = await mkdtemp(join(tmpdir(), 'tacphone-api-'))

    try {
        const compilerOptions = {
            ...parsed.options,
            noEmit: false,
            declaration: true,
            emitDeclarationOnly: true,
            declarationMap: false,
            composite: false,
            incremental: false,
            rootDir: appDir,
            outDir: tempDir,
            sourceMap: false,
        }

        const program = ts.createProgram([entry], compilerOptions)
        const emit = program.emit(undefined, undefined, undefined, true)
        if (emit.emitSkipped)
            throw new Error(`TypeScript did not emit declarations for ${entry}.`)

        const entryRelative = relative(appDir, entry).replaceAll('\\', '/').replace(/\.(tsx?|mts|cts)$/, '.d.ts')
        const entrySource = relative(appDir, entry).replaceAll('\\', '/')
        const entryDeclarations = join(tempDir, entryRelative)
        if (!existsSync(entryDeclarations))
            throw new Error(`Expected ${entryDeclarations} to be emitted.`)

        const expectedExports = moduleExportNames(program, entry)

        const config = extractorConfig({
            projectFolder: appDir,
            mainEntryPointFilePath: entryDeclarations,
            tsconfigFilePath: tsconfigPath,
            publicTrimmedFilePath: output,
            packageJsonFullPath: packagePath,
            configObjectFullPath: join(tempDir, 'api-extractor.json'),
        })

        invokeExtractor(config, displayName)

        if (!existsSync(output))
            throw new Error(`${relative(appDir, output)} was not emitted.`)

        const bundled = (await readFile(output, 'utf8'))
            .replace(/\r?\n?export \{\s*\}\s*$/, '')
            .trimEnd()

        if (bundled.trim().length === 0)
            throw new Error(`${relative(appDir, output)} is empty; the app API entry exports nothing.`)

        if (/^\s*(?:import|export)\s[^;]*from\s+['"]/m.test(bundled))
            throw new Error(`${relative(appDir, output)} is not self-contained; it still imports another module.`)

        const banner = `// Generated by tacphone-build for ${displayName}. Do not edit this file by hand.
// Edit ${entrySource} in ${basename(appDir)} instead.
`

        const content = `${banner}${bundled}\n`
        await writeFile(output, content)

        const verifyProgram = ts.createProgram([output], {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            skipLibCheck: false,
            noEmit: true,
        })
        const sourceFile = verifyProgram.getSourceFile(output)
        if (!sourceFile)
            throw new Error(`TypeScript could not load ${relative(appDir, output)}.`)

        const diagnostics = [
            ...verifyProgram.getSyntacticDiagnostics(sourceFile),
            ...verifyProgram.getSemanticDiagnostics(sourceFile),
        ].filter(diagnostic => diagnostic.file?.fileName === sourceFile.fileName)

        if (diagnostics.length > 0) {
            const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
                getCanonicalFileName: fileName => fileName,
                getCurrentDirectory: () => appDir,
                getNewLine: () => '\n',
            })
            throw new Error(`${relative(appDir, output)} has type errors:\n${formatted}`)
        }

        if (expectedExports.length > 0) {
            const actualExports = getExportedNames(sourceFile)
            const missing = expectedExports.filter(name => !actualExports.has(name))
            if (missing.length > 0) {
                throw new Error(
                    `${relative(appDir, output)} is missing expected exports: ${missing.join(', ')}.`,
                )
            }
        }

        const outputRelative = relative(appDir, output).replaceAll('\\', '/')
        if (typeof packageJson.types === 'string' && resolve(appDir, packageJson.types) !== output) {
            throw new Error(
                `${packagePath} "types" points at ${packageJson.types}, but bundle-api-types wrote ${outputRelative}.`,
            )
        }

        if (!packageJson.types && existsSync(packagePath)) {
            packageJson.types = `./${outputRelative}`
            await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
            console.log(`OK  ${displayPath(rootDir, packagePath)} (types -> ${outputRelative})`)
        }

        console.log(`OK  ${outputRelative} (bundled app API declarations for ${displayName})`)
    } finally {
        await rm(tempDir, { recursive: true, force: true })
    }
}

export async function runBundleApiTypes(argv = process.argv.slice(2)) {
    const rootDir = findWorkspaceRoot()
    const options = parseOptions(argv)

    if (!options.appDir) {
        throw new Error(
            'bundle-api-types needs --app <dir> (and usually --entry src/api.ts --name <AppName>). '
            + 'The host contract is provided by @ace-tacphone/api, not generated here.',
        )
    }

    await bundleAppDeclarations(rootDir, options)
}
