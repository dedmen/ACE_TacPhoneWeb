#!/usr/bin/env node
/**
 * Opt-in interactive GPS test runner.
 *
 * This suite needs a human in the game: the scenario opens the GPS panel in a
 * visible browser, waits for the player to get into a vehicle, plans a route to
 * a nearby goal, starts it and then follows the player's real progress.
 *
 * It is **never** part of `npm run test:map`, `npm run test:all` or any default
 * suite listing. Both an environment variable and an explicit flag are accepted
 * as the opt-in:
 *
 *   $env:TACPHONE_GPS_INTERACTIVE = '1'
 *   npm run test:gps-interactive -- --slow
 *
 *   npm run test:gps-interactive -- --opt-in --slow
 *
 * Without the opt-in the runner prints the instructions and exits 0 with a SKIP,
 * so a generic `test:all` style invocation can never block on a human.
 *
 * The browser is always visible (`--headed` is implied); `--slow` / `--slow-ms`
 * work like in the other suites. `TACPHONE_GPS_INTERACTIVE_TIMEOUT_MS` overrides
 * the wait-for-vehicle timeout (default 180000).
 */

import { DEFAULT_PAGE_URL, browserChannel } from '../../ACE_TacPhone_Main/test/lib/browser.mjs';
import { SkipError } from '../../ACE_TacPhone_Main/test/lib/skip.mjs';

import * as gpsInteractive from './scenarios/gps-interactive.test.mjs';
import * as gpsWaterInteractive from './scenarios/gps-water-interactive.test.mjs';

/** Scenarios of this suite; `kind: 'interactive'` only. */
const ALL_SCENARIOS = [gpsInteractive, gpsWaterInteractive];
/** Environment variable that opts in. */
const OPT_IN_ENV = 'TACPHONE_GPS_INTERACTIVE';

function printHelp() {
    console.log(`TacPhone Map interactive GPS tests (opt-in)

Usage:
  node ACE_TacPhone_Map/test/run-interactive-tests.mjs [options]

Options:
  --opt-in             Confirm that a human is watching the game
  --page-url <url>     Host page URL (default ${DEFAULT_PAGE_URL})
  --timeout <ms>       Per browser action timeout (default 8000)
  --scenario <name>    Run one or more scenarios (repeat or comma-separate)
  --list               List scenario names and exit (no opt-in needed)
  --slow               Slow every Playwright action (700 ms default)
  --slow-ms <ms>       Slow-motion delay in milliseconds
  --verbose            Log scenario progress
  --help               Show this help

Opt-in:
  Set $env:${OPT_IN_ENV} = '1' (or 'true'), or pass --opt-in.
  This suite is not part of 'npm run test:map' or 'npm run test:all'.

Prerequisites:
  - Arma 3 is running with the current TacPhone PBO loaded and the web host up.
  - The TacPhone host page is reachable (TACPHONE_TEST_URL or --page-url).
  - Playwright with an installed Chrome channel.
  - A human who can get into a vehicle and drive.
  - gps-water-interactive spawns its own boat and water-capable vehicle.
  - TACPHONE_GPS_INTERACTIVE_TIMEOUT_MS overrides the wait-for-vehicle timeout.`);
}

function parseArgs(argv) {
    const options = {
        pageUrl: process.env.TACPHONE_TEST_URL || DEFAULT_PAGE_URL,
        timeout: 8000,
        scenarios: [],
        list: false,
        slow: 0,
        verbose: false,
        optIn: false,
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
        } else if (argument === '--opt-in') {
            options.optIn = true;
        } else if (argument === '--verbose') {
            options.verbose = true;
        } else if (argument === '--slow') {
            options.slow = 700;
        } else if (argument === '--slow-ms') {
            options.slow = Number(nextValue());
        } else if (argument.startsWith('--slow=')) {
            options.slow = Number(argument.slice('--slow='.length));
        } else if (argument === '--headed') {
            // Implied: the human must see the phone.
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

    return options;
}

/** True when the human opted in through the environment or the flag. */
function hasOptIn(options) {
    const value = String(process.env[OPT_IN_ENV] ?? '').trim().toLowerCase();
    return options.optIn || value === '1' || value === 'true';
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
            console.log(`${scenario.name.padEnd(18)} ${scenario.kind.padEnd(12)} ${scenario.description || ''}`);
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

    if (!hasOptIn(options)) {
        console.log('TacPhone Map interactive GPS tests');
        console.log('');
        console.log('This suite needs a human in the game and is opt-in only:');
        console.log('  1. Start Arma 3 with the current TacPhone PBO and the web host.');
        console.log('  2. Open the TacPhone host page and keep the mission running.');
        console.log('  3. Be ready to get into a car/boat/aircraft and drive.');
        console.log('');
        console.log('Then run one of:');
        console.log(`  $env:${OPT_IN_ENV} = '1'; npm run test:gps-interactive -- --slow`);
        console.log('  npm run test:gps-interactive -- --opt-in --slow');
        console.log('');
        console.log('SKIP gps-interactive: opt-in required');
        return;
    }

    console.log(`TacPhone Map interactive GPS tests (Node ${process.version})`);
    console.log(`Page: ${options.pageUrl} (browser channel: ${browserChannel()}, visible window)`);

    if (options.slow > 0) {
        console.log(`Slow mode: ${options.slow} ms per Playwright action`);
    }

    const log = options.verbose ? (message) => console.log(`  . ${message}`) : undefined;
    const results = [];

    for (const scenario of scenarios) {
        const startedAt = Date.now();

        try {
            // `--headed` is implied: the human must see the phone.
            await scenario.run({
                pageUrl: options.pageUrl,
                options: { ...options, headed: true },
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
}

await main();
