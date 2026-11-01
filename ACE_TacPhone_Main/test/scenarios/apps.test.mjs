/**
 * Verifies the app catalog the host uses to populate the chooser and Options
 * sidebar. This is the cheapest check that the game side is up and serving the
 * current PBO.
 */

import { assert, includes, isType } from '../lib/assertions.mjs';

export const name = 'apps';
export const description = 'GetAvailableApps lists main, Map and Messenger';

export async function run({ client }) {
    const apps = await client.request('GetAvailableApps');

    isType(apps, 'object', 'GetAvailableApps must return an object keyed by app name');
    assert(apps && !Array.isArray(apps), 'GetAvailableApps returned an array instead of an app map');

    const names = Object.keys(apps);

    for (const expected of ['main', 'ACE_TacPhone_Map', 'Messaging']) {
        includes(names, expected, `GetAvailableApps is missing "${expected}"`);
    }

    const map = apps.ACE_TacPhone_Map;
    isType(map, 'object', 'ACE_TacPhone_Map metadata must be an object');
    isType(map.file, 'string', 'ACE_TacPhone_Map must declare a packaged file');
    assert(map.file.length > 0, 'ACE_TacPhone_Map has an empty packaged file path');
}
