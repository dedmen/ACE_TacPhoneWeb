/**
 * Host audio checks (Playwright).
 *
 * Proves the host audio engine's autoplay handling end to end:
 *
 * 1. The engine starts locked: the context is suspended (or the browser starts
 *    it unlocked) and `hasUserGesture` is false.
 * 2. The first trusted page click unlocks the context.
 * 3. A preset played after that gesture reaches the analyser tap with non-silent
 *    samples (or, when a headless sink stays silent, the offline render is used
 *    as the deterministic non-silence check) and the counters advance.
 * 4. A later preset plays without a new click, so the context stays alive.
 * 5. A sound played on a suspended context is kept as the single pending preset
 *    and then played when the resume settles, or dropped after the timeout.
 *
 * Needs the debug-only `window.__TACPHONE_AUDIO_TEST__` hook, so it skips on a
 * release page.
 *
 *   npm run test:host-ui -- --scenario audio --slow
 */

import { assert, equal } from '../lib/assertions.mjs';
import { launchHostPage } from '../lib/host-page.mjs';
import { skip } from '../lib/skip.mjs';

export const name = 'audio';
export const kind = 'browser';
export const description = 'Host audio: first-gesture unlock, keep-alive, one pending preset';

const HOOK_TIMEOUT_MS = 20000;
const MIN_PEAK = 0.01;

function getState(page) {
    return page.evaluate(() => window.__TACPHONE_AUDIO_TEST__?.getState() ?? null);
}

/** Polls the audio debug state until `predicate` matches. */
async function waitForState(page, predicate, description, timeout = 8000) {
    const startedAt = Date.now();
    let last = null;

    while (Date.now() - startedAt < timeout) {
        last = await getState(page);

        if (last && predicate(last)) {
            return last;
        }

        await page.waitForTimeout(50);
    }

    throw new Error(
        `Timed out after ${timeout} ms waiting for ${description}.` +
            `\n  last state: ${JSON.stringify(last)}`,
    );
}

export async function run({ pageUrl, options, log }) {
    const { browser, page, consoleErrors } = await launchHostPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
    });

    try {
        let hasHook = await page.evaluate(() => Boolean(window.__TACPHONE_AUDIO_TEST__));

        if (!hasHook) {
            await page
                .waitForFunction(() => Boolean(window.__TACPHONE_AUDIO_TEST__), null, { timeout: HOOK_TIMEOUT_MS })
                .catch(() => {});
            hasHook = await page.evaluate(() => Boolean(window.__TACPHONE_AUDIO_TEST__));
        }

        if (!hasHook) {
            skip(
                'window.__TACPHONE_AUDIO_TEST__ is unavailable; the host audio hook only exists ' +
                    'in a dev/debug build.',
            );
        }

        const webAudio = await page.evaluate(() => typeof AudioContext === 'function');

        if (!webAudio) {
            skip('Web Audio is unavailable in this browser; the host audio engine is silent.');
        }

        // ---- 1. locked before the first gesture -------------------------
        const initial = await getState(page);
        assert(
            initial.state === 'suspended' || initial.state === 'running',
            `The initial audio context must be suspended (or start unlocked), got "${initial.state}"`,
        );
        equal(initial.hasUserGesture, false, 'No user gesture must be recorded before the first click');
        equal(initial.pending, null, 'Nothing may be pending before the first click');
        log?.(`Initial audio state: ${initial.state}, hasUserGesture ${initial.hasUserGesture}`);

        // ---- 2. the first click unlocks --------------------------------
        // A trusted input event: a synthetic element.click() would not satisfy
        // the browser autoplay policy.
        await page.mouse.click(24, 24);

        const unlocked = await waitForState(
            page,
            state => state.hasUserGesture && state.state === 'running',
            'the audio context to run after the first click',
            10000,
        );
        log?.(`Audio unlocked; context time ${unlocked.currentTime.toFixed(3)} s`);

        // ---- 3. an alert with non-silent output -----------------------
        const afterUnlock = await getState(page);
        await page.evaluate(() => window.__TACPHONE_AUDIO_TEST__.play('alert'));

        const played = await waitForState(
            page,
            state => state.scheduled > afterUnlock.scheduled && state.completed > afterUnlock.completed,
            'the alert preset to be scheduled and to finish',
            5000,
        );
        log?.(`Alert completed: scheduled ${played.scheduled}, completed ${played.completed}`);

        const livePeak = await page
            .waitForFunction(
                () => window.__TACPHONE_AUDIO_TEST__.getState().lastPeak > 0.01,
                null,
                { timeout: 2000 },
            )
            .then(() => true)
            .catch(() => false);

        if (livePeak) {
            const state = await getState(page);
            assert(
                state.lastPeak > MIN_PEAK,
                `The analyser tap must see non-silent samples, peak was ${state.lastPeak}`,
            );
            log?.(`Live analyser peak: ${state.lastPeak.toFixed(3)}`);
        } else {
            // A headless sink can stay silent; the offline render is then the
            // deterministic proof that the preset is not silent.
            const offline = await page.evaluate(() => window.__TACPHONE_AUDIO_TEST__.renderOffline('alert'));
            assert(
                offline.peak > MIN_PEAK,
                `OfflineAudioContext must render a non-silent alert, peak was ${offline.peak}`,
            );
            log?.(`Headless sink was silent; offline render peak ${offline.peak.toFixed(3)}`);
        }

        // ---- 4. a later preset needs no new click ---------------------
        const beforeSecond = await getState(page);
        await page.waitForTimeout(500);
        await page.evaluate(() => window.__TACPHONE_AUDIO_TEST__.play('alert'));

        const second = await waitForState(
            page,
            state => state.scheduled > beforeSecond.scheduled,
            'a second alert without a new gesture',
            5000,
        );
        assert(
            second.state === 'running',
            `The context must stay running after the first gesture, got "${second.state}"`,
        );
        equal(second.pending, null, 'A running context must not keep a pending sound');
        log?.('Second alert played without a new gesture');

        // ---- 5. suspended context keeps one pending sound -------------
        await page.evaluate(() => window.__TACPHONE_AUDIO_TEST__.suspend());
        await waitForState(page, state => state.state === 'suspended', 'the suspended context', 5000);

        const beforeSuspendedPlay = await getState(page);
        await page.evaluate(() => window.__TACPHONE_AUDIO_TEST__.play('message'));

        // The engine keeps at most one pending preset and resolves it either by
        // resuming and playing it, or by dropping it after the resume timeout.
        const settled = await waitForState(
            page,
            state => state.pending === null,
            'the pending sound to play or to be dropped',
            3000,
        );

        if (settled.scheduled > beforeSuspendedPlay.scheduled) {
            equal(settled.state, 'running', 'A played pending sound needs a running context');
            log?.('Suspended context resumed and played the pending sound');
        } else {
            log?.('Suspended context could not resume; the pending sound was dropped after the timeout');
        }

        await page.evaluate(() => window.__TACPHONE_AUDIO_TEST__.resume());

        if (consoleErrors.length > 0) {
            throw new Error(`The host page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        await page.close();
        await browser.close();
    }
}
