#!/usr/bin/env node
/**
 * Game-free unit tests for the TacPhone Messenger web app.
 *
 * Usage (from `websource`; no game, web host or browser needed):
 *
 *   node MessagingApp/test/run-unit-tests.mjs
 *   node MessagingApp/test/run-unit-tests.mjs --only object-codec --verbose
 *   node MessagingApp/test/run-unit-tests.mjs --list
 *
 * The runner bundles each `test/unit/*.unit.mjs` in memory with Vite and runs
 * its `run()` export; see `ACE_TacPhone_Main/test/lib/ts-module.mjs` for why.
 * Unit tests may import app source — they are the documented exception to the
 * "live suites never import app source" rule — but only modules that are safe
 * outside a browser.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runUnitSuite } from '../../ACE_TacPhone_Main/test/lib/unit-runner.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MODULES = [
    {
        name: 'object-codec',
        description: 'Chat object codec: envelope, decode, cache, size limit',
        file: path.join(APP_ROOT, 'test/unit/object-codec.unit.mjs'),
    },
];

process.exitCode = await runUnitSuite({
    title: 'TacPhone Messenger unit tests',
    program: 'node MessagingApp/test/run-unit-tests.mjs',
    root: APP_ROOT,
    appName: 'Messaging',
    modules: MODULES,
});
