#!/usr/bin/env node
/**
 * Copies the built web artifacts into the game add-on's data folders.
 *
 * Paths are relative to the workspace root. A target folder that does not
 * exist is skipped, so a partial checkout or a game-side folder rename does not
 * fail the whole build.
 *
 * Usage:
 *   node scripts/copy-data.mjs          # host + every app
 *   node scripts/copy-data.mjs host     # only ACE_TacPhone_Main
 *   node scripts/copy-data.mjs apps     # only the app bundles
 */

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const requestedGroup = process.argv[2] || 'all';

const COPIES = [
    {
        group: 'host',
        from: 'ACE_TacPhone_Main/dist/index.html',
        to: '../data/index.html',
    },
    {
        group: 'apps',
        from: 'ACE_TacPhone_Map/dist/ace_tacphone_map.js',
        to: '../apps/map/data/ace_tacphone_map.js',
    },
    {
        group: 'apps',
        from: 'ACE_TacPhone_Map/dist/ace_tacphone_ol.js',
        to: '../apps/map/data/ace_tacphone_ol.js',
    },
    {
        group: 'apps',
        from: 'MessagingApp/dist/ace_tacphone_messaging.js',
        to: '../apps/messaging/data/ace_tacphone_messaging.js',
    },
    {
        group: 'apps',
        from: 'SampleApp/dist/ace_tacphone_sampleapp.js',
        to: '../apps/SampleApp/data/ace_tacphone_sampleapp.js',
    },
];

if (!['all', 'host', 'apps'].includes(requestedGroup)) {
    console.error(`Unknown copy group "${requestedGroup}"; expected all, host or apps.`);
    process.exitCode = 2;
} else {
    let copied = 0;
    let skipped = 0;

    for (const entry of COPIES) {
        if (requestedGroup !== 'all' && entry.group !== requestedGroup)
            continue;

        const source = resolve(workspace, entry.from);
        const target = resolve(workspace, entry.to);
        const targetDir = dirname(target);

        if (!existsSync(targetDir)) {
            console.log(`skip ${entry.from}: target folder "${entry.to}" does not exist`);
            skipped += 1;
            continue;
        }

        if (!existsSync(source)) {
            console.log(`skip ${entry.from}: built file does not exist`);
            skipped += 1;
            continue;
        }

        copyFileSync(source, target);
        console.log(`copied ${entry.from} -> ${entry.to}`);
        copied += 1;
    }

    console.log(`Copied ${copied} file(s), skipped ${skipped}.`);
}
