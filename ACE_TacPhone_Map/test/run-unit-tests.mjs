#!/usr/bin/env node
/**
 * Game-free unit tests for the TacPhone Map (GPS) web app.
 *
 * Usage (from `websource`; no game, web host or browser needed):
 *
 *   node ACE_TacPhone_Map/test/run-unit-tests.mjs
 *   node ACE_TacPhone_Map/test/run-unit-tests.mjs --only gps-advisor --verbose
 *   node ACE_TacPhone_Map/test/run-unit-tests.mjs --list
 *
 * The runner bundles each `test/unit/*.unit.mjs` in memory with Vite and runs
 * its `run()` export; see `ACE_TacPhone_Main/test/lib/ts-module.mjs`. Only
 * browser-free modules may be imported: `GpsModule.ts` is intentionally not
 * importable here (OpenLayers + DOM), and `gps-payload` asserts that.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runUnitSuite } from '../../ACE_TacPhone_Main/test/lib/unit-runner.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MODULES = [
    {
        name: 'gps-speed',
        description: 'legSpeed speed model: maxSpeed caps, climb, water, surfaces',
        file: path.join(APP_ROOT, 'test/unit/gps-speed.unit.mjs'),
    },
    {
        name: 'gps-splice',
        description: 'Route geometry/splice helpers and the shared route codec',
        file: path.join(APP_ROOT, 'test/unit/gps-splice.unit.mjs'),
    },
    {
        name: 'gps-advisor',
        description: 'Transport-mode advisor state machine (injected clock)',
        file: path.join(APP_ROOT, 'test/unit/gps-advisor.unit.mjs'),
    },
    {
        name: 'gps-payload',
        description: 'map.gps_route payload contract and the unit-loader guard',
        file: path.join(APP_ROOT, 'test/unit/gps-payload.unit.mjs'),
    },
    {
        name: 'gps-routing',
        description: 'route metrics, turn instructions, deviation and vehicle-change parsing',
        file: path.join(APP_ROOT, 'test/unit/gps-routing.unit.mjs'),
    },
    {
        name: 'terrain-layer-priority',
        description: 'terrain layer rank/LOD planning',
        file: path.join(APP_ROOT, 'test/unit/terrain-layer-priority.unit.mjs'),
    },
];

process.exitCode = await runUnitSuite({
    title: 'TacPhone Map unit tests',
    program: 'node ACE_TacPhone_Map/test/run-unit-tests.mjs',
    root: APP_ROOT,
    appName: 'ACE_TacPhone_Map',
    modules: MODULES,
});
