#!/usr/bin/env node
/**
 * Complete TacPhone runtime test suite.
 *
 * Runs every app's live suite in one pass:
 *   - host        ACE_TacPhone_Main/test/run-tests.mjs
 *   - messaging   MessagingApp/test/run-tests.mjs
 *   - messaging-ui MessagingApp/test/run-browser-tests.mjs (Playwright)
 *   - map         ACE_TacPhone_Map/test/run-tests.mjs (protocol + browser)
 *
 * Prerequisites are the same as the individual suites: Arma is running a
 * mission with the current TacPhone PBO loaded, the TacPhone web host listens
 * on port 8001, Node trusts the local HTTPS certificate, and the browser
 * scenarios can launch the installed Chrome channel.
 *
 * Usage (from `websource`):
 *
 *   npm run test:all
 *   npm run test:all -- --verbose
 *   npm run test:all -- --suite host,map --headed
 *   npm run test:all -- --fail-fast
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
    {
        name: 'host',
        script: 'ACE_TacPhone_Main/test/run-tests.mjs',
        description: 'Host page protocol, layout/options, display mode, remote access',
        accepts: ['url', 'timeout', 'verbose'],
    },
    {
        name: 'messaging',
        script: 'MessagingApp/test/run-tests.mjs',
        description: 'Messenger rooms, messages, invites, groups, presence, markers',
        accepts: ['url', 'timeout', 'verbose'],
    },
    {
        name: 'messaging-ui',
        script: 'MessagingApp/test/run-browser-tests.mjs',
        description: 'Messenger UI: rooms, messages, marker sharing, map focus',
        accepts: ['page-url', 'verbose', 'headed', 'slow', 'slow-ms', 'no-browser'],
    },
    {
        name: 'map',
        script: 'ACE_TacPhone_Map/test/run-tests.mjs',
        description: 'Map marker protocol, channels, colors, SelectMenu, polyline drawing',
        accepts: ['url', 'page-url', 'timeout', 'verbose', 'headed', 'slow', 'slow-ms', 'no-browser'],
    },
];

const VALUE_OPTIONS = new Set(['url', 'page-url', 'timeout', 'slow-ms']);
const FLAG_OPTIONS = new Set(['verbose', 'headed', 'slow', 'no-browser', 'fail-fast']);

function printHelp() {
    console.log(`Complete TacPhone runtime test suite

Usage:
  node scripts/test-all.mjs [options]

Options:
  --suite <name>       Run only these suites (repeat or comma-separate):
                       ${SUITES.map((suite) => suite.name).join(', ')}
  --url <url>          Game WebSocket URL (default wss://localhost:8001/ws)
  --page-url <url>     Host page URL for browser tests
  --timeout <ms>       Per request/reply timeout (default 8000)
  --verbose            Log requests, replies and scenario progress
  --headed             Run browser scenarios with a visible window
  --slow               Slow every Playwright action and show the browser (700 ms default)
  --slow-ms <ms>       Slow-motion delay in milliseconds; implies --slow and --headed
  --no-browser         Skip browser scenarios (Map protocol tests still run)
  --fail-fast          Stop after the first failing suite
  --list               List the suites and exit
  --help               Show this help

Prerequisites:
  - Arma 3 is running a mission with the current TacPhone PBO loaded.
  - The TacPhone web host is listening on port 8001.
  - Node trusts the local HTTPS certificate (NODE_EXTRA_CA_CERTS).
  - Browser scenarios: Playwright with an installed Chrome channel.`);
}

function parseArgs(argv) {
    const options = {
        suites: [],
        values: {},
        flags: new Set(),
        list: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '--help' || argument === '-h') {
            options.help = true;
            continue;
        }

        if (argument === '--list') {
            options.list = true;
            continue;
        }

        if (argument === '--suite' || argument.startsWith('--suite=')) {
            const value = argument.includes('=')
                ? argument.slice(argument.indexOf('=') + 1)
                : argv[++index];

            if (!value) {
                throw new Error(`Missing value after ${argument}`);
            }

            options.suites.push(...value.split(',').map((name) => name.trim()).filter(Boolean));
            continue;
        }

        const name = argument.startsWith('--') ? argument.slice(2) : '';

        if (VALUE_OPTIONS.has(name)) {
            const value = argv[++index];
            if (value === undefined) {
                throw new Error(`Missing value after ${argument}`);
            }

            options.values[name] = value;
            continue;
        }

        if (argument.startsWith('--') && argument.includes('=')) {
            const [key, value] = argument.slice(2).split('=');
            if (VALUE_OPTIONS.has(key)) {
                options.values[key] = value;
                continue;
            }
        }

        if (FLAG_OPTIONS.has(name)) {
            options.flags.add(name);
            continue;
        }

        throw new Error(`Unknown argument: ${argument}`);
    }

    return options;
}

function selectSuites(requested) {
    if (requested.length === 0) {
        return SUITES;
    }

    const selected = [];

    for (const name of requested) {
        const match = SUITES.find((suite) => suite.name === name);
        if (!match) {
            throw new Error(
                `Unknown suite "${name}". Available: ${SUITES.map((suite) => suite.name).join(', ')}`,
            );
        }

        if (!selected.includes(match)) {
            selected.push(match);
        }
    }

    return selected;
}

function suiteArguments(suite, options) {
    const args = [suite.script];

    for (const [name, value] of Object.entries(options.values)) {
        if (!suite.accepts.includes(name)) {
            continue;
        }

        args.push(`--${name}`, value);
    }

    for (const flag of options.flags) {
        if (flag === 'fail-fast' || !suite.accepts.includes(flag)) {
            continue;
        }

        args.push(`--${flag}`);
    }

    return args;
}

function runSuite(suite, options) {
    const args = suiteArguments(suite, options);

    return new Promise((resolve) => {
        const startedAt = Date.now();
        const child = spawn(process.execPath, args, {
            cwd: ROOT,
            stdio: 'inherit',
            env: process.env,
        });

        child.on('error', (error) => {
            resolve({ suite, status: 'fail', durationMs: Date.now() - startedAt, error });
        });

        child.on('close', (code, signal) => {
            resolve({
                suite,
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

    if (options.list) {
        for (const suite of SUITES) {
            console.log(`${suite.name.padEnd(12)} ${suite.description}`);
        }
        return;
    }

    let suites;

    try {
        suites = selectSuites(options.suites);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 2;
        return;
    }

    console.log(`TacPhone complete runtime test suite (Node ${process.version})`);
    console.log(`Suites: ${suites.map((suite) => suite.name).join(', ')}\n`);

    const results = [];

    for (const [index, suite] of suites.entries()) {
        console.log(`==== [${index + 1}/${suites.length}] ${suite.name}: ${suite.description} ====\n`);
        const result = await runSuite(suite, options);
        results.push(result);

        const label = result.status === 'pass' ? 'PASS' : 'FAIL';
        console.log(`\n==== ${label} ${suite.name} (${result.durationMs} ms) ====\n`);

        if (result.status === 'fail' && options.flags.has('fail-fast')) {
            console.error('Stopping after the first failing suite (--fail-fast).');
            break;
        }
    }

    const passed = results.filter((result) => result.status === 'pass').length;
    const failed = results.length - passed;
    const skipped = suites.length - results.length;

    console.log('TacPhone suite summary');
    for (const result of results) {
        console.log(
            `  ${result.status === 'pass' ? 'PASS' : 'FAIL'}  ${result.suite.name.padEnd(12)} ${result.durationMs} ms` +
                (result.status === 'fail' ? ` (exit ${result.code ?? result.signal ?? 'error'})` : ''),
        );
    }

    if (skipped > 0) {
        console.log(`  SKIP  ${skipped} suite(s) not run`);
    }

    console.log(`\n${passed} passed, ${failed} failed, ${results.length} total`);
    process.exitCode = failed > 0 ? 1 : 0;
}

await main();
