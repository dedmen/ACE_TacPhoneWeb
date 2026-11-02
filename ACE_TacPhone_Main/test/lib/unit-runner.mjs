/**
 * Shared runner for the game-free unit tier.
 *
 * Each app keeps its own `test/run-unit-tests.mjs` that only lists its unit
 * modules; everything else (argument parsing, Vite bundling, PASS/FAIL output,
 * exit code) lives here so the app folders stay small.
 *
 * A unit module is a `test/unit/*.unit.mjs` file that:
 * - does **not** run assertions at import time (it is only imported to read
 *   `name`/`description`, and a failing import must not look like a pass);
 * - exports `name`, an optional `description` and `async run(context)`;
 * - imports only app sources that are safe outside a browser.
 *
 * `context` gives the module `{ root, appName, loadAppModule }`, so a module can
 * bundle another source (for example to assert that a browser-only module
 * cannot be imported).
 */

import path from 'node:path';

import { SkipError } from './skip.mjs';
import { loadAppModule } from './ts-module.mjs';

function printHelp(program, modules) {
    console.log(`${program} [options]

Options:
  --only <name>     Run only these modules (repeat or comma-separate):
                    ${modules.map(module => module.name).join(', ')}
  --list            List the unit modules and exit
  --verbose         Log bundling progress and failure stacks
  --help            Show this help

The unit tier needs no game, no web host and no browser: only Node and the
workspace dependencies (Vite bundles the TypeScript sources in memory).`);
}

function parseArgs(argv, program) {    const options = { only: [], list: false, verbose: false, help: false };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        const nextValue = () => {
            index += 1;
            if (index >= argv.length) {
                throw new Error(`Missing value after ${argument}`);
            }
            return argv[index];
        };

        if (argument === '--help' || argument === '-h') {
            options.help = true;
            continue;
        }

        if (argument === '--list') {
            options.list = true;
            continue;
        }

        if (argument === '--verbose') {
            options.verbose = true;
            continue;
        }

        if (argument === '--only' || argument === '--scenario') {
            options.only.push(...nextValue().split(',').map(value => value.trim()).filter(Boolean));
            continue;
        }

        if (argument.startsWith('--only=')) {
            options.only.push(
                ...argument.slice('--only='.length).split(',').map(value => value.trim()).filter(Boolean),
            );
            continue;
        }

        throw new Error(`Unknown argument: ${argument}\n\n${program} --help`);
    }

    return options;
}

function selectModules(modules, requested) {
    if (requested.length === 0) {
        return modules;
    }

    const selected = [];

    for (const name of requested) {
        const match = modules.find(
            module =>
                module.name === name
                || `${module.name}.unit.mjs` === name
                || module.name.replaceAll('-', '') === name.replaceAll('-', ''),
        );

        if (!match) {
            throw new Error(
                `Unknown unit module "${name}". Available: ${modules.map(module => module.name).join(', ')}`,
            );
        }

        if (!selected.includes(match)) {
            selected.push(match);
        }
    }

    return selected;
}

function indent(text, prefix) {
    return String(text)
        .split('\n')
        .map(line => `${prefix}${line}`)
        .join('\n');
}

/**
 * Runs unit modules sequentially and prints a PASS/FAIL/SKIP line for each.
 *
 * @param {{
 *   title: string,
 *   program: string,
 *   root: string,
 *   appName?: string,
 *   modules: Array<{ name: string, file: string }>,
 *   argv?: string[],
 * }} config
 * @returns {Promise<number>} Process exit code.
 */
export async function runUnitSuite(config) {
    const modules = config.modules;
    const argv = config.argv ?? process.argv.slice(2);
    let options;

    try {
        options = parseArgs(argv, config.program);
    } catch (error) {
        console.error(error.message);
        return 2;
    }

    if (options.help) {
        printHelp(config.program, modules);
        return 0;
    }

    if (options.list) {
        for (const module of modules) {
            console.log(`${module.name.padEnd(20)} ${module.description ?? ''}`.trimEnd());
        }
        return 0;
    }

    let selected;

    try {
        selected = selectModules(modules, options.only);
    } catch (error) {
        console.error(error.message);
        return 2;
    }

    const startedAt = Date.now();
    console.log(`${config.title} (Node ${process.version})`);
    console.log(`${selected.length} unit module${selected.length === 1 ? '' : 's'} queued.\n`);

    const context = {
        root: config.root,
        appName: config.appName,
        loadAppModule,
    };
    const failures = [];
    let passed = 0;
    let skipped = 0;

    for (const module of selected) {
        const moduleStartedAt = Date.now();
        const entry = path.resolve(module.file);

        try {
            if (options.verbose) {
                console.log(`  bundling ${entry}`);
            }

            const loaded = await loadAppModule(entry, { root: config.root });

            if (typeof loaded.run !== 'function') {
                throw new Error(
                    `${module.name}: a unit module must export an async run(context) function.`,
                );
            }

            await loaded.run(context);
            passed += 1;
            console.log(`PASS ${module.name} (${Date.now() - moduleStartedAt} ms)`);
        } catch (error) {
            if (error instanceof SkipError) {
                skipped += 1;
                console.log(`SKIP ${module.name}: ${error.message}`);
                continue;
            }

            failures.push({ name: module.name, error });
            console.log(`FAIL ${module.name} (${Date.now() - moduleStartedAt} ms)`);
            console.error(indent(options.verbose ? error?.stack : error?.message, '  '));
        }
    }

    const failed = failures.length;
    console.log(
        `\n${passed} passed, ${failed} failed, ${skipped} skipped, ` +
        `${selected.length} total (${Date.now() - startedAt} ms)`,
    );

    if (failed > 0) {
        console.log('Failed unit modules:');
        for (const failure of failures) {
            console.log(`  - ${failure.name}`);
        }
    }

    return failed > 0 ? 1 : 0;
}
