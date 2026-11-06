/**
 * Exercises the game-side Notify.Show notification command end to end: a
 * shown notification, suppression while the phone is open, the machine-wide
 * rate-limit bucket (5 shown notifications per 10 s), and Debug.Notify.Reset.
 *
 * The scenario briefly opens the phone in HUD mode. It restores CLOSED and
 * clears the rate-limit bucket in a finally block.
 */

import { assert, equal } from '../lib/assertions.mjs';

export const name = 'notify';
export const description = 'Notify.Show: shown, phone-open suppression, rate limit, reset';

export const requiresDebug = true;

const NOTIFY = 'Notify.Show';
const SET_MODE = 'Debug.SetLocalDisplayMode';
const RESET = 'Debug.Notify.Reset';

const BASE_PAYLOAD = {
    title: 'Notify test',
    body: 'Shown while the phone is closed',
    app: 'ACE_TacPhone_Map',
};

function notify(client, payload) {
    return client.request(NOTIFY, payload);
}

async function setMode(client, mode) {
    return client.request(SET_MODE, { mode }, { timeout: 15000 });
}

function json(reply) {
    return JSON.stringify(reply);
}

export async function run({ client }) {
    try {
        // The runner starts with the phone closed; make sure of it.
        await setMode(client, 'CLOSED');

        // 1. Phone closed: the notification is shown.
        const shown = await notify(client, BASE_PAYLOAD);

        equal(shown?.ok, true, `Notify.Show should accept the request: ${json(shown)}`);
        equal(shown?.shown, true, `Notification should be shown while the phone is closed: ${json(shown)}`);

        // 2. Phone HUD: suppressed with reason "phone open". Suppressed calls
        // do not consume the rate-limit bucket, so the follow-up after closing
        // the phone is shown again.
        await setMode(client, 'HUD');

        const suppressed = await notify(client, BASE_PAYLOAD);

        equal(suppressed?.ok, true, `Notify.Show should accept the request: ${json(suppressed)}`);
        equal(suppressed?.shown, false, `Notification must be suppressed while the phone is open: ${json(suppressed)}`);
        equal(suppressed?.reason, 'phone open', `Expected reason "phone open": ${json(suppressed)}`);

        await setMode(client, 'CLOSED');

        const afterSuppress = await notify(client, BASE_PAYLOAD);

        equal(afterSuppress?.ok, true, `Notify.Show should accept the request: ${json(afterSuppress)}`);
        equal(afterSuppress?.shown, true, `Suppression must not consume the rate-limit bucket: ${json(afterSuppress)}`);

        // 3. Spam: 7 rapid calls. The bucket already holds 2 entries, so at
        // most 3 of the 7 can be shown and at least 2 must be rate limited.
        const spam = [];

        for (let index = 0; index < 7; index += 1) {
            spam.push(await notify(client, BASE_PAYLOAD));
        }

        const rateLimited = spam.filter(
            reply => reply?.ok === true && reply?.shown === false && reply?.reason === 'rate limited',
        );

        assert(
            rateLimited.length >= 2,
            `Expected at least 2 rate-limited replies out of 7 rapid calls, got ${rateLimited.length}: ${json(spam)}`,
        );

        const reset = await client.request(RESET, {});

        equal(reset?.ok, true, `Debug.Notify.Reset failed: ${json(reset)}`);

        const afterReset = await notify(client, BASE_PAYLOAD);

        equal(afterReset?.ok, true, `Notify.Show should accept the request: ${json(afterReset)}`);
        equal(afterReset?.shown, true, `Reset must clear the rate-limit bucket: ${json(afterReset)}`);

        // 4. Unknown app: the generic-icon fallback is a manual visual check,
        // so assert the reply shape only.
        const unknownApp = await notify(client, { ...BASE_PAYLOAD, app: 'ACE_TacPhone_NotAnApp' });

        equal(unknownApp?.ok, true, `Notify.Show should accept the request: ${json(unknownApp)}`);
        equal(unknownApp?.shown, true, `Unknown app should fall back to the generic icon: ${json(unknownApp)}`);

        // 5. Oversized title: truncation is a manual visual check, so assert
        // the reply shape only.
        const oversized = await notify(client, { ...BASE_PAYLOAD, title: 'x'.repeat(300) });

        equal(oversized?.ok, true, `Notify.Show should accept the request: ${json(oversized)}`);
        equal(oversized?.shown, true, `Oversized title should be truncated and shown: ${json(oversized)}`);
    } finally {
        // Leave the phone as the test found it and clear the rate-limit bucket.
        await setMode(client, 'CLOSED').catch(() => {});
        await client.request(RESET, {}).catch(() => {});
    }
}
