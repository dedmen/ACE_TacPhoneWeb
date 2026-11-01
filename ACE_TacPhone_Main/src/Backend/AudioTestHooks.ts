// Debug-only audio hooks for the host browser test suite.
//
// The host audio engine has no DOM surface: a sound is a short oscillator graph,
// so neither the DOM nor a screenshot can tell whether it actually produced
// samples. This hook exposes the engine's counters, the debug analyser tap and an
// offline render so `test/scenarios/audio.test.mjs` can assert the real graph.
//
// The hook is installed only by the Vite dev server or when the game reports
// debug mode; a release page has no `window.__TACPHONE_AUDIO_TEST__`.

import { audio } from "./Audio";
import type { NotificationSound } from "./Types";

/** One debug snapshot of the host audio engine. */
export interface AudioTestState {
    /** Context state; `suspended` also before the context exists, `unavailable` without Web Audio. */
    state: AudioContextState | "unavailable";
    /** Context clock in seconds; 0 before the context exists. */
    currentTime: number;
    /** True after the first pointer/key/touch gesture unlocked the engine. */
    hasUserGesture: boolean;
    /** The single preset waiting for a suspended context to resume, if any. */
    pending: NotificationSound | null;
    /** Presets handed to the audio graph. */
    scheduled: number;
    /** Presets whose last tone ended. */
    completed: number;
    /** Loudest analyser sample of the current/last preset, 0..1. */
    lastPeak: number;
}

export interface AudioTestHooks {
    getState: () => AudioTestState;
    play: (sound: NotificationSound) => void;
    /** Suspends the context like a backgrounded page. */
    suspend: () => Promise<void>;
    /** Resumes the context like a returning page. */
    resume: () => Promise<void>;
    /** Renders a preset in an OfflineAudioContext and returns its peak, 0..1. */
    renderOffline: (sound: NotificationSound) => Promise<{ peak: number; duration: number; sampleRate: number }>;
}

declare global {
    interface Window {
        /** Present only in dev/debug builds. */
        __TACPHONE_AUDIO_TEST__?: AudioTestHooks;
    }
}

function install(): void {
    if (window.__TACPHONE_AUDIO_TEST__)
        return;

    // The analyser tap is created with the context, so enable it before the
    // first gesture creates one.
    audio.enableDebugTap();

    window.__TACPHONE_AUDIO_TEST__ = {
        getState: () => audio.getDebugState(),
        play: sound => audio.play(sound),
        suspend: () => audio.suspendForTest(),
        resume: () => audio.resumeForTest(),
        renderOffline: sound => audio.renderOffline(sound),
    };
}

export function installAudioTestHooks(): void {
    if (window.__TACPHONE_AUDIO_TEST__)
        return;

    if (import.meta.env.DEV) {
        install();
        return;
    }

    // The game-side debug flag is the released-build equivalent of a debug web
    // build; it is false for normal players.
    window.TacPhone.gameInfo.whenReady()
        .then(info => {
            if (info.debug)
                install();
        })
        .catch(() => {
            // No game info means no debug hook; nothing to do.
        });
}
