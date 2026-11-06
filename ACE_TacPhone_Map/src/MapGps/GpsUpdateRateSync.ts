// Keeps the game's GPS push rate in sync with the "gpsUpdateRate" Map option.
//
// The game pushes GPS.Update from a per-frame handler whose interval is fixed
// when it starts, so the option is pushed to the game as a `SetGpsUpdateRate`
// request; while the GPS interest is held the game restarts its handler. The
// send is fire-and-forget like the other Map requests: a failed send is
// logged, and the next option change retries the current value.
//
// The saved layout (and with it the stored option) can arrive after this app's
// init(), so the sync starts with the current value and re-sends on every Map
// option change until it converges.

import { MAP_APP, onGpsSettingsChanged, readGpsSettings } from '../MapOptions';

/** Rate already sent to the game; avoids a duplicate send per change. */
let sentRate: number | undefined;

function sendRate(hz: number): void {
    sentRate = hz;

    void window.TacPhone.networking.Request({
        a: MAP_APP,
        c: 'SetGpsUpdateRate',
        hz,
    }).catch((error) => {
        console.warn('GPS: could not set the update rate', error);
    });
}

/**
 * Sends the current GPS update rate to the game and keeps it in sync while the
 * Map options change. Returns an unsubscribe function.
 */
export function startGpsUpdateRateSync(): () => void {
    const sync = (): void => {
        const { updateRate } = readGpsSettings();
        if (updateRate !== sentRate)
            sendRate(updateRate);
    };

    sync();

    return onGpsSettingsChanged(sync);
}

/** Test-only: forgets the rate already sent so the next sync sends again. */
export function resetGpsUpdateRateSync(): void {
    sentRate = undefined;
}
