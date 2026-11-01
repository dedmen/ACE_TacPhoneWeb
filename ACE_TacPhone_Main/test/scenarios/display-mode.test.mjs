/**
 * Exercises the main-app display-mode debug command used by the Messaging
 * presence scenarios and by the host test suite.
 *
 * The command actually calls openDisplay, so the phone briefly changes mode.
 * The scenario restores CLOSED in a finally block.
 */

import { assert, equal } from '../lib/assertions.mjs';

export const name = 'display-mode';
export const description = 'Debug.SetLocalDisplayMode CLOSED/HUD/DIALOG/HIDDEN';

export const requiresDebug = true;

const COMMAND = 'Debug.SetLocalDisplayMode';
const MODES = ['CLOSED', 'HUD', 'DIALOG', 'HIDDEN'];

async function setMode(client, mode) {
    return client.request(COMMAND, { mode }, { timeout: 15000 });
}

export async function run({ client }) {
    const invalid = await setMode(client, 'BOGUS');

    assert(invalid?.ok === false, 'An unknown display mode must be rejected');

    try {
        for (const mode of MODES) {
            const result = await setMode(client, mode);

            equal(result?.ok, true, `${COMMAND} failed for ${mode}: ${result?.error || 'unknown error'}`);
            equal(result?.mode, mode, `${COMMAND} returned the wrong mode`);
        }
    } finally {
        // Leave the phone as the test found it (the runner starts with it closed).
        await setMode(client, 'CLOSED').catch(() => {});
    }
}
