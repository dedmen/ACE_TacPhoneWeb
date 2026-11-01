#!/usr/bin/env node
/**
 * Playwright runtime tests for the Messenger app.
 *
 * Usage (from `websource`, with Arma and the TacPhone web host running):
 *
 *   npm run test:messaging-ui
 *   npm run test:messaging-ui -- --slow
 *   npm run test:messaging-ui -- --headed --slow-ms 1200
 *
 * Needs a debug game: fake players, room cleanup and marker tests use the
 * `Messaging.Debug.*` commands, and the host page must serve the Messenger app.
 */

import { SkipError } from '../../ACE_TacPhone_Main/test/lib/skip.mjs';
import { DEFAULT_PAGE_URL } from '../../ACE_TacPhone_Main/test/lib/browser.mjs';
import * as browserUi from './scenarios/browser-ui.test.mjs';
import * as layoutScrollbars from './scenarios/layout-scrollbars.test.mjs';
import * as audioNotifications from './scenarios/audio-notifications.test.mjs';

const ALL_SCENARIOS = [browserUi, layoutScrollbars, audioNotifications];

function printHelp() {
    console.log(`TacPhone Messenger Playwright tests

Usage:
  node MessagingApp/test/run-browser-tests.mjs [options]

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
  - Arma 3 running an __A3_DEBUG__ mission with the current TacPhone PBO.
  - The TacPhone web host on port 8001 and the host dev page reachable.
  - Playwright with the installed Chrome channel (no browser download).`);
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
        console.log('SKIP TacPhone Messenger Playwright tests (--no-browser)');
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

        const unknown = options.scenarios.filter((name) => !scenarios.some((scenario) => scenario.name === name));
        if (unknown.length > 0) {
            throw new Error(`Unknown scenario(s): ${unknown.join(', ')}`);
        }
    }

    console.log(`TacPhone Messenger Playwright tests (Node ${process.version})`);
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

await main();
