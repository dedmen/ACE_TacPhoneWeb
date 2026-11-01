#!/usr/bin/env node
/**
 * Reusable live test runner for the TacPhone Messenger app.
 *
 * Usage (from `websource`, with Arma and the TacPhone web host running):
 *
 *   node MessagingApp/test/run-tests.mjs
 *   node MessagingApp/test/run-tests.mjs --url wss://localhost:8001/ws
 *   node MessagingApp/test/run-tests.mjs --scenario messages
 *   node MessagingApp/test/run-tests.mjs --list
 *
 * The suite talks to the game over the real WebSocket protocol. It does not
 * import app source or patch the game; it is safe to store and rerun.
 */

import {
    DEFAULT_URL,
    WsClient,
    collectChatState,
    openClient,
} from '../../ACE_TacPhone_Main/test/lib/ws-client.mjs';
import { FakePlayers } from './lib/fake-players.mjs';
import { runSuite } from '../../ACE_TacPhone_Main/test/lib/assertions.mjs';

import * as connection from './scenarios/connection.test.mjs';
import * as rooms from './scenarios/rooms.test.mjs';
import * as messages from './scenarios/messages.test.mjs';
import * as forwarding from './scenarios/forwarding.test.mjs';
import * as invites from './scenarios/invites.test.mjs';
import * as groups from './scenarios/groups.test.mjs';
import * as groupEvents from './scenarios/group-events.test.mjs';
import * as aiGroups from './scenarios/ai-groups.test.mjs';
import * as leave from './scenarios/leave.test.mjs';
import * as presence from './scenarios/presence.test.mjs';
import * as sideFiltering from './scenarios/side-filtering.test.mjs';
import * as reconnectSync from './scenarios/reconnect-sync.test.mjs';
import * as persistenceScaffold from './scenarios/persistence-scaffold.test.mjs';
import * as mapMarker from './scenarios/map-marker.test.mjs';

const ALL_SCENARIOS = [
    connection,
    rooms,
    messages,
    forwarding,
    invites,
    groups,
    groupEvents,
    aiGroups,
    leave,
    presence,
    sideFiltering,
    reconnectSync,
    persistenceScaffold,
    mapMarker,
];

function printHelp() {
    console.log(`TacPhone Messenger live test suite

Usage:
  node MessagingApp/test/run-tests.mjs [options]

Options:
  --url <url>          WebSocket URL (default ${DEFAULT_URL})
  --timeout <ms>       Per request/push timeout (default 8000)
  --scenario <name>    Run one or more scenarios (repeat or comma-separate)
  --list               List scenario names and exit
  --verbose            Log requests, replies and pushes
  --help               Show this help

The game must run an __A3_DEBUG__ build with the TacPhone web host on port 8001.
Node must trust the local HTTPS certificate; set NODE_EXTRA_CA_CERTS if needed.`);
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
  - Arma 3 is running a mission with the TacPhone add-on loaded.
  - The TacPhone web host is listening on port 8001.
  - The game add-on was built with __A3_DEBUG__ (Messaging.Debug.Status must be available).
  - Node trusts the local HTTPS certificate. If not, point NODE_EXTRA_CA_CERTS at the
    certificate PEM file; do not disable certificate verification.
  - Use a current Node release: the suite sends the WebSocket Origin header through
    Node's built-in WebSocket init object.`);
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

    console.log(`TacPhone Messenger live tests (Node ${process.version})`);
    console.log(`Target: ${options.url}`);

    const client = new WsClient(options.url, {
        app: 'Messaging',
        name: 'main',
        connectTimeout: options.timeout,
        requestTimeout: options.timeout,
        pushTimeout: options.timeout,
        debug: options.verbose,
    });

    let fake;
    let connected = false;

    try {
        await client.open();
        connected = true;

        const hello = await client.request('Hello', { visible: true }, { timeout: options.timeout });

        if (!hello?.ok || !hello.self?.uid) {
            throw new Error(`Hello did not return a usable identity: ${JSON.stringify(hello)}`);
        }

        fake = new FakePlayers(client, { timeout: options.timeout });

        // Fail before any scenario if the game was not built with __A3_DEBUG__.
        await fake.status();

        const context = {
            client,
            fake,
            self: hello.self,
            url: options.url,
            options,
            openClient: overrides =>
                openClient(options.url, {
                    app: 'Messaging',
                    name: 'secondary',
                    connectTimeout: options.timeout,
                    requestTimeout: options.timeout,
                    pushTimeout: options.timeout,
                    debug: options.verbose,
                    ...overrides,
                }),
            collectChatState,
        };

        const result = await runSuite(scenarios, context, {
            title: `Messenger live scenarios against ${options.url}`,
        });

        process.exitCode = result.failed > 0 ? 1 : 0;
    } catch (error) {
        if (!connected) {
            printConnectionHelp(options.url, error);
        } else {
            console.error(`\nSuite setup failed:`);
            console.error(
                (error?.stack || String(error))
                    .split('\n')
                    .map(line => `  ${line}`)
                    .join('\n'),
            );
        }

        process.exitCode = 1;
    } finally {
        if (fake) {
            try {
                await fake.setAllowEnemyChat(false);
                await fake.reset();
            } catch {
                // Cleanup must not hide the real result.
            }
        }

        await client.close().catch(() => {});
    }
}

await main();
