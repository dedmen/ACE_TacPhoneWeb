#!/usr/bin/env node
/**
 * Live runtime tests for the TacPhone host (ACE_TacPhone_Main).
 *
 * Usage (from `websource`, with Arma and the TacPhone web host running):
 *
 *   node ACE_TacPhone_Main/test/run-tests.mjs
 *   node ACE_TacPhone_Main/test/run-tests.mjs --scenario layout-options
 *   node ACE_TacPhone_Main/test/run-tests.mjs --list
 *
 * The suite talks to the game over the real WebSocket protocol. It does not
 * import app source or patch the game; it is safe to store and rerun.
 */

import { DEFAULT_URL, WsClient, openClient } from './lib/ws-client.mjs';
import { runSuite } from './lib/assertions.mjs';
import { ensureLocalCertificate } from './lib/certificate.mjs';

import * as apps from './scenarios/apps.test.mjs';
import * as layoutOptions from './scenarios/layout-options.test.mjs';
import * as remoteAccess from './scenarios/remote-access.test.mjs';
import * as displayMode from './scenarios/display-mode.test.mjs';
import * as localization from './scenarios/localization.test.mjs';

const ALL_SCENARIOS = [
    apps,
    layoutOptions,
    remoteAccess,
    displayMode,
    localization,
];

function printHelp() {
    console.log(`TacPhone host live test suite

Usage:
  node ACE_TacPhone_Main/test/run-tests.mjs [options]

Options:
  --url <url>          WebSocket URL (default ${DEFAULT_URL})
  --timeout <ms>       Per request/push timeout (default 8000)
  --scenario <name>    Run one or more scenarios (repeat or comma-separate)
  --list               List scenario names and exit
  --verbose            Log requests, replies and pushes
  --help               Show this help

Prerequisites:
  - Arma 3 is running a mission with the current TacPhone PBO loaded.
  - The TacPhone web host is listening on port 8001.
  - The runner exports and trusts the local HTTPS certificate automatically and
    prints its PEM path. Set NODE_EXTRA_CA_CERTS only for manual Node runs.
  - Close the in-game TacPhone page before the layout test, or use a scratch
    mission: an open page may save its own layout during the round trip.
  - The remote-access and display-mode scenarios need an __A3_DEBUG__ build
    with the server-controlled "Allow debug mode" setting. Without it they are
    skipped unless you request one explicitly.`);
}

function parseArgs(argv) {
    const options = {
        url: DEFAULT_URL,
        timeout: 8000,
        scenarios: [],
        list: false,
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

        if (argument === '--url') {
            options.url = nextValue();
            continue;
        }

        if (argument.startsWith('--url=')) {
            options.url = argument.slice('--url='.length);
            continue;
        }

        if (argument === '--timeout') {
            options.timeout = Number(nextValue());
            continue;
        }

        if (argument.startsWith('--timeout=')) {
            options.timeout = Number(argument.slice('--timeout='.length));
            continue;
        }

        if (argument === '--scenario' || argument === '--only') {
            options.scenarios.push(...nextValue().split(',').map(value => value.trim()));
            continue;
        }

        if (argument.startsWith('--scenario=')) {
            options.scenarios.push(
                ...argument
                    .slice('--scenario='.length)
                    .split(',')
                    .map(value => value.trim()),
            );
            continue;
        }

        throw new Error(`Unknown argument: ${argument}`);
    }

    if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
        throw new Error('--timeout must be a positive number of milliseconds');
    }

    return options;
}

function selectScenarios(requested) {
    if (requested.length === 0) {
        return ALL_SCENARIOS;
    }

    const selected = [];

    for (const name of requested) {
        const match = ALL_SCENARIOS.find(
            scenario =>
                scenario.name === name ||
                `${scenario.name}.test.mjs` === name ||
                scenario.name.replaceAll('-', '') === name.replaceAll('-', ''),
        );

        if (!match) {
            throw new Error(
                `Unknown scenario "${name}". Available: ` +
                    ALL_SCENARIOS.map(scenario => scenario.name).join(', '),
            );
        }

        if (!selected.includes(match)) {
            selected.push(match);
        }
    }

    return selected;
}

function printConnectionHelp(url, error) {
    console.error(`\nCould not connect to ${url}:`);
    console.error(
        (error?.message || String(error))
            .split('\n')
            .map(line => `  ${line}`)
            .join('\n'),
    );
    console.error(`
Prerequisites:
  - Arma 3 is running a mission with the current TacPhone PBO loaded.
  - The TacPhone web host is listening on port 8001.
  - The runner exports and trusts the local HTTPS certificate automatically and
    prints its PEM path. If you run Node manually, set NODE_EXTRA_CA_CERTS to
    that path; do not disable certificate verification.
  - Use a current Node release: the suite uses a small RFC 6455 client that sends
    the loopback Origin header the host requires.`);
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
            console.log(`${scenario.name.padEnd(24)} ${scenario.description || ''}`);
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

    console.log(`TacPhone host live tests (Node ${process.version})`);
    console.log(`Target: ${options.url}`);

    const client = new WsClient(options.url, {
        app: 'main',
        name: 'main',
        connectTimeout: options.timeout,
        requestTimeout: options.timeout,
        pushTimeout: options.timeout,
        debug: options.verbose,
    });

    let connected = false;

    try {
        await client.open();
        connected = true;

        const info = await client.request('GetGameInfo', {}, { timeout: options.timeout });

        if (!info || typeof info !== 'object') {
            throw new Error(`GetGameInfo did not return an object: ${JSON.stringify(info)}`);
        }

        console.log(
            `Game: ${info.terrainName ?? '?'} / ${info.missionName ?? '?'} ` +
                `(version ${info.gameVersion ?? '?'}, debug ${info.debug === true})`,
        );

        if (scenarios.some(scenario => scenario.requiresDebug)) {
            // Probe the generic debug command instead of a specific scenario
            // bridge: all test bridges share the Allow debug mode guard.
            const probe = await client
                .request('Debug.Status', {}, { timeout: options.timeout })
                .catch(() => undefined);

            if (!probe || probe.ok === false) {
                const debugOnly = scenarios.filter(scenario => scenario.requiresDebug);

                if (options.scenarios.length > 0) {
                    throw new Error(
                        `Scenario(s) ${debugOnly.map(scenario => scenario.name).join(', ')} ` +
                            'require the server-controlled TacPhone "Allow debug mode" setting. ' +
                            `Probe result: ${JSON.stringify(probe)}`,
                    );
                }

                scenarios = scenarios.filter(scenario => !scenario.requiresDebug);
                console.log(
                    `Skipping debug-only scenarios: ${debugOnly.map(scenario => scenario.name).join(', ')} ` +
                        '(Allow debug mode is disabled)',
                );
            }
        }

        const result = await runSuite(
            scenarios,
            {
                client,
                url: options.url,
                options,
                openClient: overrides =>
                    openClient(options.url, {
                        app: 'main',
                        name: 'secondary',
                        connectTimeout: options.timeout,
                        requestTimeout: options.timeout,
                        pushTimeout: options.timeout,
                        debug: options.verbose,
                        ...overrides,
                    }),
            },
            { title: `TacPhone host scenarios against ${options.url}` },
        );

        process.exitCode = result.failed > 0 ? 1 : 0;
    } catch (error) {
        if (!connected) {
            printConnectionHelp(options.url, error);
        } else {
            console.error('\nSuite setup failed:');
            console.error(
                (error?.stack || String(error))
                    .split('\n')
                    .map(line => `  ${line}`)
                    .join('\n'),
            );
        }

        process.exitCode = 1;
    } finally {
        await client.close().catch(() => {});
    }
}

await ensureLocalCertificate();
await main();
