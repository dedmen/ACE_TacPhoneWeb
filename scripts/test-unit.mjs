#!/usr/bin/env node
/**
 * Game-free unit tests for every TacPhone web app.
 *
 * Runs the app unit runners sequentially, like `scripts/test-all.mjs`:
 *   - host       ACE_TacPhone_Main/test/run-unit-tests.mjs
 *   - messaging  MessagingApp/test/run-unit-tests.mjs
 *   - map        ACE_TacPhone_Map/test/run-unit-tests.mjs
 *
 * No Arma, no web host and no browser: Node bundles the TypeScript sources in
 * memory with Vite and runs the exported `run()` of each unit module.
 *
 * Usage (from `websource`):
 *
 *   npm run test:unit
 *   npm run test:unit -- --verbose
 *   npm run test:unit -- --only object-codec
 *   npm run test:unit -- --fail-fast
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RUNNERS = [
    {
        name: 'host',
        script: 'ACE_TacPhone_Main/test/run-unit-tests.mjs',
        description: 'Relay hub transport, request correlation, broadcast, interests',
        modules: ['relay-manager'],
    },
    {
        name: 'messaging',
        script: 'MessagingApp/test/run-unit-tests.mjs',
        description: 'Messenger chat object codec',
        modules: ['object-codec'],
    },
    {
        name: 'map',
        script: 'ACE_TacPhone_Map/test/run-unit-tests.mjs',
        description: 'GPS speed model, route splice, advisor, payload',
        modules: [
            'gps-speed',
            'gps-splice',
            'gps-advisor',
            'gps-payload',
            'gps-routing',
            'gps-water-corridor',
            'gps-leg-info',
            'terrain-layer-priority',
        ],
    },
];

const FLAG_OPTIONS = new Set(['verbose', 'fail-fast']);
const VALUE_OPTIONS = new Set(['only']);

function printHelp() {
    console.log(`TacPhone game-free unit tests

Usage:
  node scripts/test-unit.mjs [options]

Options:
  --only <name>     Run only these unit modules (repeat or comma-separate)
  --verbose         Log bundling progress and failure stacks
  --fail-fast       Stop after the first failing runner
  --help            Show this help

No game, web host or browser is needed.`);
}

function parseArgs(argv) {
    const options = { values: {}, flags: new Set(), help: false };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '--help' || argument === '-h') {
            options.help = true;
            continue;
        }

        const name = argument.startsWith('--') ? argument.slice(2) : '';

        if (VALUE_OPTIONS.has(name)) {
            const value = argv[++index];
            if (value === undefined) {
                throw new Error(`Missing value after ${argument}`);
            }

            const existing = options.values[name];
            options.values[name] = existing ? `${existing},${value}` : value;
            continue;
        }

        if (FLAG_OPTIONS.has(name)) {
            options.flags.add(name);
            continue;
        }

        throw new Error(`Unknown argument: ${argument}`);
    }

    return options;
}

function requestedModules(options) {
    return (options.values.only ?? '')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);
}

function runnerArguments(runner, options) {
    const args = [runner.script];
    const requested = requestedModules(options);
    const only = requested.filter(name => runner.modules.includes(name));

    for (const [name, value] of Object.entries(options.values)) {
        if (name === 'only') {
            if (only.length > 0) {
                args.push('--only', only.join(','));
            }
            continue;
        }

        args.push(`--${name}`, value);
    }

    for (const flag of options.flags) {
        if (flag === 'fail-fast') {
            continue;
        }

        args.push(`--${flag}`);
    }

    return args;
}

function runRunner(runner, options) {
    const args = runnerArguments(runner, options);

    return new Promise((resolve) => {
        const startedAt = Date.now();
        const child = spawn(process.execPath, args, {
            cwd: ROOT,
            stdio: 'inherit',
            env: process.env,
        });

        child.on('error', (error) => {
            resolve({ runner, status: 'fail', durationMs: Date.now() - startedAt, error });
        });

        child.on('close', (code, signal) => {
            resolve({
                runner,
                status: code === 0 ? 'pass' : 'fail',
                durationMs: Date.now() - startedAt,
                code,
                signal,
            });
        });
    });
}

async function main() {
    let options;

    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        printHelp();
        process.exitCode = 2;
        return;
    }

    if (options.help) {
        printHelp();
        return;
    }

    const requested = requestedModules(options);
    const unknown = requested.filter(name => !RUNNERS.some(runner => runner.modules.includes(name)));

    if (unknown.length > 0) {
        console.error(`Unknown unit module(s): ${unknown.join(', ')}`);
        console.error(`Available: ${RUNNERS.flatMap(runner => runner.modules).join(', ')}`);
        process.exitCode = 2;
        return;
    }

    const runners = requested.length === 0
        ? RUNNERS
        : RUNNERS.filter(runner => runner.modules.some(name => requested.includes(name)));

    console.log(`TacPhone unit test suite (Node ${process.version})`);
    console.log(`Runners: ${runners.map(runner => runner.name).join(', ')}\n`);

    const results = [];
    const startedAt = Date.now();

    for (const [index, runner] of runners.entries()) {
        console.log(`==== [${index + 1}/${runners.length}] ${runner.name}: ${runner.description} ====\n`);
        const result = await runRunner(runner, options);
        results.push(result);

        const label = result.status === 'pass' ? 'PASS' : 'FAIL';
        console.log(`\n==== ${label} ${runner.name} (${result.durationMs} ms) ====\n`);

        if (result.status === 'fail' && options.flags.has('fail-fast')) {
            console.error('Stopping after the first failing runner (--fail-fast).');
            break;
        }
    }

    const passed = results.filter(result => result.status === 'pass').length;
    const failed = results.length - passed;

    console.log('TacPhone unit summary');
    for (const result of results) {
        console.log(
            `  ${result.status === 'pass' ? 'PASS' : 'FAIL'}  ${result.runner.name.padEnd(12)} ${result.durationMs} ms` +
                (result.status === 'fail' ? ` (exit ${result.code ?? result.signal ?? 'error'})` : ''),
        );
    }

    console.log(`\n${passed} passed, ${failed} failed, ${results.length} total (${Date.now() - startedAt} ms)`);
    process.exitCode = failed > 0 ? 1 : 0;
}

await main();
