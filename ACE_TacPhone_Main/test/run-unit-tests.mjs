#!/usr/bin/env node
/**
 * Game-free unit tests for the TacPhone host.
 *
 * Usage (from `websource`; no game, web host or browser needed):
 *
 *   node ACE_TacPhone_Main/test/run-unit-tests.mjs
 *   node ACE_TacPhone_Main/test/run-unit-tests.mjs --only relay-manager --verbose
 *   node ACE_TacPhone_Main/test/run-unit-tests.mjs --list
 *
 * The relay hub is deliberately browser-free: `RelayManager` owns the wire
 * protocol and routing, while `NetworkingA3` supplies requests and terrain.
 * The unit test uses a fake `RelayNetworking`, so it needs no DOM.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runUnitSuite } from './lib/unit-runner.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MODULES = [
    {
        name: 'message-router',
        description: 'Command routing, one warn per unsubscribed command',
        file: path.join(APP_ROOT, 'test/unit/message-router.unit.mjs'),
    },
    {
        name: 'notify-request',
        description: 'Notify.Show request mapping for in-game notifications',
        file: path.join(APP_ROOT, 'test/unit/notify-request.unit.mjs'),
    },
    {
        name: 'relay-manager',
        description: 'Hub transport decode, request correlation, broadcast and interests',
        file: path.join(APP_ROOT, 'test/unit/relay-manager.unit.mjs'),
    },
];

process.exitCode = await runUnitSuite({
    title: 'TacPhone host unit tests',
    program: 'node ACE_TacPhone_Main/test/run-unit-tests.mjs',
    root: APP_ROOT,
    appName: 'Host',
    modules: MODULES,
});
