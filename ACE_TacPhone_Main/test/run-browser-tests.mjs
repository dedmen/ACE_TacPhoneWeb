#!/usr/bin/env node
/**
 * Playwright browser tests for the TacPhone host page.
 *
 * Usage (from `websource`, with Arma and the TacPhone web host running):
 *
 *   npm run test:host-ui
 *   npm run test:host-ui -- --scenario audio
 *   npm run test:host-ui -- --slow
 *
 * The scenarios drive the real host page at `--page-url` (default
 * `http://localhost:5173/`), like the Map and Messenger browser suites. Audio
 * checks need a dev/debug page because they use the debug-only
 * `window.__TACPHONE_AUDIO_TEST__` hook; a missing hook or a missing Playwright
 * browser is a SKIP, not a failure.
 */

import { DEFAULT_PAGE_URL } from './lib/browser.mjs';
import { SkipError } from './lib/skip.mjs';
import { ensureLocalCertificate } from './lib/certificate.mjs';

import * as audio from './scenarios/audio.test.mjs';
import * as backgroundTabs from './scenarios/background-tabs.test.mjs';

const ALL_SCENARIOS = [audio, backgroundTabs];

function printHelp() {
    console.log(`TacPhone host Playwright tests

Usage:
  node ACE_TacPhone_Main/test/run-browser-tests.mjs [options]

Options:
  --page-url <url>     Host page URL (default ${DEFAULT_PAGE_URL})
  --headed             Run the browser with a visible window
  --slow               Slow every Playwright action and show the browser (700 ms default)
  --slow-ms <ms>       Slow-motion delay in milliseconds; implies --slow and --headed
  --no-browser         Skip the browser scenarios
  --scenario <name>    Run one scenario (default: all)
  --list               List scenarios and exit
  --verbose            Log scenario progress
  --help               Show this help

Prerequisites:
  - Arma 3 is running a mission with the current TacPhone PBO loaded.
  - The TacPhone web host is listening on port 8001.
  - The TacPhone host dev page is reachable (TACPHONE_TEST_URL or --page-url).
  - Playwright with the installed Chrome channel (no browser download).
  - A dev/debug build for the audio debug hook.`);
}

function parseArgs(argv) {
    const options = {
        pageUrl: process.env.TACPHONE_TEST_URL || DEFAULT_PAGE_URL,
        headed: false,
        slow: 0,
        scenarios: [],
        list: false,
        verbose: false,
        noBrowser: false,
        help: false,
    };

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
        } else if (argument === '--list') {
            options.list = true;
        } else if (argument === '--verbose') {
            options.verbose = true;
        } else if (argument === '--headed') {
            options.headed = true;
        } else if (argument === '--no-browser') {
            options.noBrowser = true;
        } else if (argument === '--slow') {
            options.slow = 700;
        } else if (argument === '--slow-ms') {
            options.slow = Number(nextValue());
        } else if (argument.startsWith('--slow=')) {
            options.slow = Number(argument.slice('--slow='.length));
        } else if (argument === '--page-url') {
            options.pageUrl = nextValue();
        } else if (argument.startsWith('--page-url=')) {
            options.pageUrl = argument.slice('--page-url='.length);
        } else if (argument === '--scenario' || argument === '--only') {
            options.scenarios.push(...nextValue().split(',').map((value) => value.trim()));
        } else if (argument.startsWith('--scenario=')) {
            options.scenarios.push(
                ...argument.slice('--scenario='.length).split(',').map((value) => value.trim()),
            );
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    if (!Number.isFinite(options.slow) || options.slow < 0) {
        throw new Error('--slow-ms must be zero or a positive number of milliseconds');
    }

    if (options.slow > 0) {
        // A human is watching: never hide the browser in slow mode.
        options.headed = true;
    }

    return options;
}

function indent(text, prefix = '  ') {
    return String(text).split('\n').map((line) => `${prefix}${line}`).join('\n');
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
        for (const scenario of ALL_SCENARIOS) {
            console.log(`${scenario.name.padEnd(18)} ${scenario.description || ''}`);
        }
        return;
    }

    if (options.noBrowser) {
        console.log('SKIP TacPhone host Playwright tests (--no-browser)');
        return;
    }

    let scenarios = ALL_SCENARIOS;

    if (options.scenarios.length > 0) {
        scenarios = ALL_SCENARIOS.filter((scenario) => (
            options.scenarios.some((name) => (
                scenario.name === name ||
                `${scenario.name}.test.mjs` === name ||
                scenario.name.replaceAll('-', '') === name.replaceAll('-', '')
            ))
        ));

        const unknown = options.scenarios.filter(
            (name) => !scenarios.some((scenario) => scenario.name === name),
        );

        if (unknown.length > 0) {
            console.error(`Unknown scenario(s): ${unknown.join(', ')}`);
            console.error(`Available: ${ALL_SCENARIOS.map((scenario) => scenario.name).join(', ')}`);
            process.exitCode = 2;
            return;
        }
    }

    console.log(`TacPhone host Playwright tests (Node ${process.version})`);
    console.log(`Page: ${options.pageUrl}`);

    if (options.slow > 0) {
        console.log(`Slow mode: ${options.slow} ms per Playwright action, browser visible`);
    }

    const log = options.verbose ? (message) => console.log(`  . ${message}`) : undefined;
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const scenario of scenarios) {
        const startedAt = Date.now();

        try {
            await scenario.run({
                pageUrl: options.pageUrl,
                options,
                log,
            });
            passed += 1;
            console.log(`PASS ${scenario.name} (${Date.now() - startedAt} ms)`);
        } catch (error) {
            if (error instanceof SkipError) {
                skipped += 1;
                console.log(`SKIP ${scenario.name}: ${error.message}`);
            } else {
                failed += 1;
                console.log(`FAIL ${scenario.name} (${Date.now() - startedAt} ms)`);
                console.error(indent(error?.stack || String(error)));
            }
        }
    }

    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped, ${scenarios.length} total`);
    process.exitCode = failed > 0 ? 1 : 0;
}

await ensureLocalCertificate();
await main();
