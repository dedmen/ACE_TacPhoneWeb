#!/usr/bin/env node
/**
 * Runtime tests for the TacPhone Map app (ACE_TacPhone_Map).
 *
 * Usage (from `websource`):
 *
 *   node ACE_TacPhone_Map/test/run-tests.mjs
 *   node ACE_TacPhone_Map/test/run-tests.mjs --list
 *   node ACE_TacPhone_Map/test/run-tests.mjs --scenario marker-protocol
 *   node ACE_TacPhone_Map/test/run-tests.mjs --scenario marker-ui --headed
 *
 * Two kinds of scenario:
 *   - `node`    talks to the game over the real WebSocket protocol.
 *   - `browser` drives the TacPhone host page with Playwright (installed Chrome
 *               channel). A missing Playwright install or browser is a SKIP.
 *
 * The suite never imports app or SQF source and never edits the game.
 */

import { DEFAULT_PAGE_URL, browserChannel } from '../../ACE_TacPhone_Main/test/lib/browser.mjs';
import { DEFAULT_URL, WsClient } from '../../ACE_TacPhone_Main/test/lib/ws-client.mjs';
import { SkipError } from '../../ACE_TacPhone_Main/test/lib/skip.mjs';

import * as markerProtocol from './scenarios/marker-protocol.test.mjs';
import * as markerChannels from './scenarios/marker-channels.test.mjs';
import * as markerUi from './scenarios/marker-ui.test.mjs';
import * as polylineDraw from './scenarios/polyline-draw.test.mjs';
import * as polylineEdit from './scenarios/polyline-edit.test.mjs';
import * as mapView from './scenarios/map-view.test.mjs';

const ALL_SCENARIOS = [markerProtocol, markerChannels, markerUi, polylineDraw, polylineEdit, mapView];

function printHelp() {
    console.log(`TacPhone Map runtime tests

Usage:
  node ACE_TacPhone_Map/test/run-tests.mjs [options]

Options:
  --url <url>          Game WebSocket URL (default ${DEFAULT_URL})
  --page-url <url>     Host page URL (default ${DEFAULT_PAGE_URL})
  --timeout <ms>       Per request/reply timeout (default 8000)
  --scenario <name>    Run one or more scenarios (repeat or comma-separate)
  --list               List scenario names and exit
  --headed             Run the browser scenarios with a visible window
  --slow               Slow every Playwright action and show the browser (700 ms default)
  --slow-ms <ms>       Slow-motion delay in milliseconds; implies --slow and --headed
  --no-browser         Run only the Node scenarios
  --verbose            Log requests, replies and scenario progress
  --help               Show this help

Prerequisites:
  - Arma 3 is running a mission with the current TacPhone PBO loaded.
  - The TacPhone web host is listening on ${DEFAULT_URL}.
  - Browser scenarios: the TacPhone host page is reachable (TACPHONE_TEST_URL
    or --page-url) and Playwright with an installed Chrome channel.
  - The Node client needs Node to trust the local HTTPS certificate; set
    NODE_EXTRA_CA_CERTS instead of disabling verification.
  - The 256-character clamp assertion needs a PBO built after the SQF clamp was
    added.`);
}

function parseArgs(argv) {
    const options = {
        url: DEFAULT_URL,
        pageUrl: process.env.TACPHONE_TEST_URL || DEFAULT_PAGE_URL,
        timeout: 8000,
        scenarios: [],
        list: false,
        headed: false,
        slow: 0,
        noBrowser: false,
        verbose: false,
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
        } else if (argument === '--slow') {
            options.slow = 700;
        } else if (argument === '--slow-ms') {
            options.slow = Number(nextValue());
        } else if (argument.startsWith('--slow=')) {
            options.slow = Number(argument.slice('--slow='.length));
        } else if (argument === '--no-browser') {
            options.noBrowser = true;
        } else if (argument === '--url') {
            options.url = nextValue();
        } else if (argument.startsWith('--url=')) {
            options.url = argument.slice('--url='.length);
        } else if (argument === '--page-url') {
            options.pageUrl = nextValue();
        } else if (argument.startsWith('--page-url=')) {
            options.pageUrl = argument.slice('--page-url='.length);
        } else if (argument === '--timeout') {
            options.timeout = Number(nextValue());
        } else if (argument.startsWith('--timeout=')) {
            options.timeout = Number(argument.slice('--timeout='.length));
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

    if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
        throw new Error('--timeout must be a positive number of milliseconds');
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

function selectScenarios(requested) {
    if (requested.length === 0) {
        return ALL_SCENARIOS;
    }

    const selected = [];

    for (const requestedName of requested) {
        const match = ALL_SCENARIOS.find(
            (scenario) =>
                scenario.name === requestedName ||
                `${scenario.name}.test.mjs` === requestedName ||
                scenario.name.replaceAll('-', '') === requestedName.replaceAll('-', ''),
        );

        if (!match) {
            throw new Error(
                `Unknown scenario "${requestedName}". Available: ` +
                    ALL_SCENARIOS.map((scenario) => scenario.name).join(', '),
            );
        }

        if (!selected.includes(match)) {
            selected.push(match);
        }
    }

    return selected;
}

function indent(text, prefix = '  ') {
    return String(text).split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function printConnectionHelp(url, error) {
    console.error(`\nCould not connect to ${url}:`);
    console.error(indent(error?.message || String(error)));
    console.error(`
Prerequisites:
  - Arma 3 is running a mission with the current TacPhone PBO loaded.
  - The TacPhone web host is listening on port 8001.
  - Node trusts the local HTTPS certificate (NODE_EXTRA_CA_CERTS).`);
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
            console.log(`${scenario.name.padEnd(18)} ${scenario.kind.padEnd(8)} ${scenario.description || ''}`);
        }
        return;
    }

    let scenarios;

    try {
        scenarios = selectScenarios(options.scenarios);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 2;
        return;
    }

    if (options.noBrowser) {
        scenarios = scenarios.filter((scenario) => scenario.kind !== 'browser');
    }

    console.log(`TacPhone Map runtime tests (Node ${process.version})`);
    console.log(`Game: ${options.url}`);
    console.log(`Page: ${options.pageUrl} (browser channel: ${browserChannel()})`);

    if (options.slow > 0) {
        console.log(`Slow mode: ${options.slow} ms per Playwright action, browser visible`);
    }

    const log = options.verbose ? (message) => console.log(`  . ${message}`) : undefined;

    let client;
    let connected = false;

    try {
        if (scenarios.some((scenario) => scenario.kind === 'node')) {
            client = new WsClient(options.url, {
                // Map requests use the app name; `main` is only used for probes.
                app: 'ACE_TacPhone_Map',
                name: 'map-tests',
                connectTimeout: options.timeout,
                requestTimeout: options.timeout,
                pushTimeout: options.timeout,
                debug: options.verbose,
            });

            await client.open();
            connected = true;

            const info = await client.request('GetGameInfo', {}, { app: 'main', timeout: options.timeout });
            console.log(
                `Game: ${info?.terrainName ?? '?'} / ${info?.missionName ?? '?'} ` +
                    `(version ${info?.gameVersion ?? '?'}, debug ${info?.debug === true})`,
            );
        }

        const results = [];

        for (const scenario of scenarios) {
            const startedAt = Date.now();

            try {
                await scenario.run({
                    client,
                    url: options.url,
                    pageUrl: options.pageUrl,
                    options,
                    log,
                });
                results.push({ name: scenario.name, status: 'pass' });
                console.log(`PASS ${scenario.name} (${Date.now() - startedAt} ms)`);
            } catch (error) {
                if (error instanceof SkipError) {
                    results.push({ name: scenario.name, status: 'skip', error });
                    console.log(`SKIP ${scenario.name}: ${error.message}`);
                } else {
                    results.push({ name: scenario.name, status: 'fail', error });
                    console.log(`FAIL ${scenario.name} (${Date.now() - startedAt} ms)`);
                    console.error(indent(error?.stack || String(error)));
                }
            }
        }

        const passed = results.filter((result) => result.status === 'pass').length;
        const failed = results.filter((result) => result.status === 'fail').length;
        const skipped = results.filter((result) => result.status === 'skip').length;

        console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped, ${results.length} total`);
        process.exitCode = failed > 0 ? 1 : 0;
    } catch (error) {
        if (!connected && error instanceof SkipError) {
            console.log(`SKIP ${error.message}`);
            process.exitCode = 0;
        } else if (!connected) {
            printConnectionHelp(options.url, error);
            process.exitCode = 1;
        } else {
            console.error('\nSuite setup failed:');
            console.error(indent(error?.stack || String(error)));
            process.exitCode = 1;
        }
    } finally {
        await client?.close().catch(() => {});
    }
}

await main();
