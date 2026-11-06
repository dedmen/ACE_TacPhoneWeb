/**
 * Unit tests for the "gpsUpdateRate" Map option and its game sync.
 *
 * `GpsUpdateRateSync.ts` pushes the option value to the game as a
 * `SetGpsUpdateRate` request (fire-and-forget) and re-sends it whenever the
 * option changes. The saved layout can arrive after the app's init(), so the
 * sync must converge instead of trusting a single early read. The host API is
 * stubbed on `globalThis.window` before any sync call runs.
 */

import { deepEqual, equal } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { MAP_APP, readGpsSettings } from '../../src/MapOptions.ts';
import {
    resetGpsUpdateRateSync,
    startGpsUpdateRateSync,
} from '../../src/MapGps/GpsUpdateRateSync.ts';

export const name = 'gps-update-rate-sync';
export const description = 'GPS update rate option: validation and SetGpsUpdateRate sync';

const RATE_KEY = 'gpsUpdateRate';

/** Minimal `window.TacPhone` host stub: options store plus request recorder. */
function installWindowStub() {
    const values = new Map();
    const listeners = new Set();
    const requests = [];
    let failed = false;

    globalThis.window = {
        TacPhone: {
            options: {
                get: (app, key) => {
                    if (app !== MAP_APP) return undefined;
                    return values.get(key);
                },
                onDidChange: (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
            networking: {
                Request: (frame) => {
                    requests.push(frame);
                    return failed
                        ? Promise.reject(new Error('stub failure'))
                        : Promise.resolve({ ok: true });
                },
            },
            localization: {
                t: (key) => key,
            },
        },
    };

    return {
        requests,
        set: (key, value) => {
            if (value === undefined) {
                values.delete(key);
            } else {
                values.set(key, value);
            }

            for (const listener of [...listeners]) {
                listener({ app: MAP_APP });
            }
        },
        failNext: () => {
            failed = true;
        },
    };
}

function freshSync() {
    resetGpsUpdateRateSync();
    return startGpsUpdateRateSync();
}

export async function run() {
    // readGpsSettings validates the stored value.
    {
        const stub = installWindowStub();
        equal(readGpsSettings().updateRate, 10, 'No stored value falls back to 10 Hz');

        stub.set(RATE_KEY, 30);
        equal(readGpsSettings().updateRate, 30, 'A stored 30 is accepted');

        stub.set(RATE_KEY, 20);
        equal(readGpsSettings().updateRate, 10, 'A rate outside the choices falls back to 10 Hz');

        stub.set(RATE_KEY, '30');
        equal(readGpsSettings().updateRate, 10, 'A non-number falls back to 10 Hz');

        stub.set(RATE_KEY, undefined);
        equal(readGpsSettings().updateRate, 10, 'Removing the value falls back to the default');
    }

    // The sync sends the current rate once and only re-sends real rate changes.
    {
        const stub = installWindowStub();
        const unsubscribe = freshSync();

        equal(stub.requests.length, 1, 'The sync sends the current rate on start');
        equal(stub.requests[0].a, MAP_APP, 'The request targets the Map app');
        equal(stub.requests[0].c, 'SetGpsUpdateRate', 'The request uses the SetGpsUpdateRate command');
        equal(stub.requests[0].hz, 10, 'The default rate is 10 Hz');

        stub.set('terrainQuality', 'high');
        equal(stub.requests.length, 1, 'An unrelated option change does not re-send the rate');

        stub.set(RATE_KEY, 30);
        equal(stub.requests.length, 2, 'Changing the rate sends the new value');
        equal(stub.requests[1].hz, 30, 'The second request carries 30 Hz');

        stub.set(RATE_KEY, 30);
        equal(stub.requests.length, 2, 'Setting the same value again does not re-send');

        stub.set('gpsAutoRepath', true);
        equal(stub.requests.length, 2, 'Another GPS option change does not re-send the rate');

        unsubscribe();
        stub.set(RATE_KEY, 10);
        equal(stub.requests.length, 2, 'After unsubscribing, changes are no longer sent');
    }

    // A failed send does not break the sync; the next change retries the value.
    {
        const stub = installWindowStub();
        const originalWarn = console.warn;
        console.warn = () => {};
        const unsubscribe = freshSync();
        stub.failNext();

        try {
            stub.set(RATE_KEY, 30);
            equal(stub.requests.length, 2, 'The changed rate is sent even when the previous send failed');

            // The failed send was marked as sent, so the same value is not retried
            // until the option changes again.
            stub.set('tilePreload', 1);
            equal(stub.requests.length, 2, 'An unrelated change does not retry the failed send');

            stub.set(RATE_KEY, 10);
            stub.set(RATE_KEY, 30);
            equal(stub.requests.length, 4, 'Toggling the option retries the current value');

            // Flush the rejected send's microtask so its warn fires while
            // console.warn is still suppressed.
            await Promise.resolve();
            await Promise.resolve();
        } finally {
            console.warn = originalWarn;
            unsubscribe();
        }
    }

    // readGpsSettings still exposes the other GPS settings unchanged.
    {
        const stub = installWindowStub();
        const settings = readGpsSettings();
        equal(settings.rotateWithPlayer, true, 'rotateWithPlayer keeps its default');
        equal(settings.autoRepath, false, 'autoRepath keeps its default');
        deepEqual(Object.keys(settings).sort(), ['autoRepath', 'rotateWithPlayer', 'updateRate'],
            'GpsSettings carries exactly the three GPS settings');
    }
}
