/**
 * Host notification-audio checks.
 *
 * The host synthesises notification sounds with Web Audio instead of shipping
 * assets, so the test instruments the audio graph and plays every preset. Run
 * with `--slow` (headed) to actually hear the three sounds on the default output
 * device; headless Chromium is muted by Playwright but still exercises the same
 * scheduling code.
 */

import { assert, equal, isType } from '../../../ACE_TacPhone_Map/test/lib/assertions.mjs';
import { launchHostPage } from '../../../ACE_TacPhone_Map/test/lib/map-page.mjs';
import { skip } from '../../../ACE_TacPhone_Map/test/lib/skip.mjs';

export const name = 'audio-notifications';
export const kind = 'browser';
export const description = 'Notification presets are synthesised, throttled and exposed through window.TacPhone.audio';

const PRESET_TONES = {
    message: 2,
    alert: 3,
    success: 3,
};
const COOLDOWN_MS = 400;

const probeStartCount = (page) => page.evaluate(() => window.__tacphoneAudioProbe?.start ?? 0);

async function waitForStarts(page, expected, label) {
    await page.waitForFunction(
        (count) => (window.__tacphoneAudioProbe?.start ?? 0) >= count,
        expected,
        { timeout: 5000 },
    ).catch(() => {});
    const starts = await probeStartCount(page);
    equal(starts, expected, `${label}: expected ${expected} scheduled tones, got ${starts}`);
}

export async function run({ pageUrl, options, log }) {
    const { browser, page, consoleErrors } = await launchHostPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
    });

    try {
        const audioInfo = await page.evaluate(() => {
            const audio = window.TacPhone?.audio;
            return {
                available: Boolean(audio),
                play: typeof audio?.play,
                enumerateDevices: typeof audio?.enumerateDevices,
                setSinkId: typeof audio?.setSinkId,
                webAudio: typeof AudioContext === 'function',
            };
        });

        if (!audioInfo.available) {
            skip('window.TacPhone.audio is unavailable; the host audio engine was not installed.');
        }
        if (!audioInfo.webAudio) {
            skip('Web Audio is unavailable in this browser; the host audio engine is silent.');
        }

        equal(audioInfo.play, 'function', 'window.TacPhone.audio.play must be exposed');
        equal(audioInfo.enumerateDevices, 'function', 'window.TacPhone.audio.enumerateDevices must be exposed');
        equal(audioInfo.setSinkId, 'function', 'window.TacPhone.audio.setSinkId must be exposed');

        // Instrument before the first gesture creates the host's lazy AudioContext.
        await page.evaluate(() => {
            window.__tacphoneAudioProbe = { oscillator: 0, start: 0 };

            const contextPrototype = AudioContext.prototype;
            const createOscillator = contextPrototype.createOscillator;
            contextPrototype.createOscillator = function (...args) {
                window.__tacphoneAudioProbe.oscillator += 1;
                return createOscillator.apply(this, args);
            };

            const oscillatorPrototype = OscillatorNode.prototype;
            const start = oscillatorPrototype.start;
            oscillatorPrototype.start = function (...args) {
                window.__tacphoneAudioProbe.start += 1;
                return start.apply(this, args);
            };
        });

        // A real pointer gesture is required before Chrome lets the context run.
        await page.mouse.click(18, 18);
        await page.evaluate(() => window.TacPhone.audio.unlock?.());
        await page.waitForTimeout(300);

        let expected = 0;
        for (const [preset, tones] of Object.entries(PRESET_TONES)) {
            expected += tones;
            await page.evaluate((sound) => window.TacPhone.audio.play(sound), preset);
            await waitForStarts(page, expected, `${preset} preset`);
            log?.(`Played the ${preset} notification sound`);
            // Longer than the preset and the per-preset cooldown, so the sounds
            // stay distinct in a slow/headed run.
            await page.waitForTimeout(COOLDOWN_MS + 450);
        }

        // The engine throttles a burst of the same preset.
        await page.waitForTimeout(COOLDOWN_MS);
        const beforeBurst = await probeStartCount(page);
        await page.evaluate(() => {
            window.TacPhone.audio.play('message');
            window.TacPhone.audio.play('message');
        });
        await page.waitForTimeout(250);
        equal(
            await probeStartCount(page),
            beforeBurst + PRESET_TONES.message,
            'A burst of the same notification preset must be throttled',
        );

        const devices = await page.evaluate(() => window.TacPhone.audio.enumerateDevices());
        assert(Array.isArray(devices), 'enumerateDevices() must return an array');
        for (const device of devices) {
            isType(device.deviceId, 'string', 'An audio device needs a string deviceId');
            equal(device.kind, 'audiooutput', 'Only audio output devices may be listed');
        }

        const emptySink = await page.evaluate(() => window.TacPhone.audio.setSinkId('').then(
            () => null,
            (error) => String(error?.message ?? error),
        ));
        assert(
            typeof emptySink === 'string' && emptySink.includes('non-empty device id'),
            `setSinkId("") must reject with a clear message, got ${emptySink}`,
        );

        if (options?.headed === true) {
            log?.('You should have heard message (ding-dong), alert (three beeps) and success (rising arpeggio).');
        } else {
            log?.('Headless Chromium mutes audio; run with --slow to hear the presets.');
        }

        if (consoleErrors.length > 0) {
            throw new Error(`The host page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        await page.close();
        await browser.close();
    }
}
