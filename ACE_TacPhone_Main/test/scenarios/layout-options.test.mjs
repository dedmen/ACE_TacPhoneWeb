/**
 * Exercises the exact persistence path the host uses for option values.
 *
 * App.tsx saves one JSON envelope: the flexlayout model plus a top-level
 * `options` map, gzipped and base64-encoded. The game treats that string as
 * opaque profile data. This scenario saves a known envelope, reads it back, and
 * restores the previous value.
 *
 * Keep the TacPhone page closed while running this scenario, or leave it on a
 * scratch mission: an open page may save its own layout during the round trip.
 */

import { gunzipSync, gzipSync } from 'node:zlib';

import { assert, deepEqual, equal, isType } from '../lib/assertions.mjs';

export const name = 'layout-options';
export const description = 'SaveLayout/GetLayout round-trip the options envelope';

const TEST_APP = '__ACE_TacPhone_Test';
const TEST_NAME = 'TacPhone options round-trip';

function encodeLayout(value) {
    return gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64');
}

function decodeLayout(stored) {
    if (typeof stored !== 'string' || stored.length === 0) {
        return undefined;
    }

    let text = stored;

    try {
        text = gunzipSync(Buffer.from(stored, 'base64')).toString('utf8');
    } catch {
        // An older game may return raw JSON; let JSON.parse below decide.
    }

    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

export async function run({ client }) {
    const originalRaw = await client.request('GetLayout');

    isType(originalRaw, 'string', 'GetLayout must return the opaque layout string');

    const envelope = {
        global: {
            tabEnablePopoutFloatIcon: true,
            tabEnablePopout: false,
        },
        borders: [],
        layout: {
            type: 'row',
            weight: 100,
            children: [{
                type: 'tabset',
                weight: 100,
                children: [{
                    type: 'tab',
                    name: TEST_NAME,
                    component: 'AppChooser',
                }],
            }],
        },
        options: {
            [TEST_APP]: {
                boolean: true,
                number: 42,
                text: 'round-trip',
                select: 'low',
            },
        },
    };

    try {
        const saveReply = await client.request('SaveLayout', {
            layout: encodeLayout(envelope),
        });

        assert(saveReply?.ok === true, 'SaveLayout did not acknowledge the test envelope');

        const storedRaw = await client.request('GetLayout');
        const stored = decodeLayout(storedRaw);

        assert(stored, 'GetLayout returned data that is not valid gzipped/base64 JSON');

        deepEqual(
            stored.options,
            envelope.options,
            'The options map did not survive the SaveLayout/GetLayout round trip',
        );

        equal(
            stored.layout?.children?.[0]?.children?.[0]?.name,
            TEST_NAME,
            'The flexlayout model did not survive the SaveLayout/GetLayout round trip',
        );
    } finally {
        const restoreReply = await client.request('SaveLayout', { layout: originalRaw });

        assert(restoreReply?.ok === true, 'Could not restore the previous layout');

        const restoredRaw = await client.request('GetLayout');
        equal(
            restoredRaw,
            originalRaw,
            'The previous layout was not restored. Was the TacPhone page open and saving during the test?',
        );
    }
}
