// Host-side audio engine.
//
// The host has no audio assets: every notification sound is synthesised with the
// Web Audio API from short oscillator/gain note sequences. The engine owns one
// lazily-created `AudioContext`, which is also the context used for output-device
// selection, so a future `setSinkId()` applies to notification sounds too.
//
// Browser autoplay policy: a context created without a user gesture starts
// suspended. The first `pointerdown`/`keydown` anywhere in the page creates (if
// needed) and resumes the context; those listeners stay installed so a context
// that is suspended later (tab/app backgrounding) wakes up on the next gesture.
// `play()` never queues a sound on a suspended context: a queued sound would
// only fire on some later click, which reads as a random noise. Instead the
// engine tries to resume and drops that one sound.
//
// Nothing here throws on a runtime path: if Web Audio is unavailable the engine
// logs one warning and becomes a no-op. `setSinkId()` is the exception: it
// rejects with a clear error because it is an explicit request whose caller has
// to know that it did not happen.
//
// Output-device scaffolding: `enumerateDevices()`/`setSinkId()` exist so a future
// feature can mirror Arma's audio output device into the browser. The game cannot
// report its device today (see TODO.md); nothing here discovers it.

import type { AudioApi, AudioDeviceInfo, NotificationSound } from "./Types";

/** Minimum time between two sounds of the same preset, in milliseconds. */
const PRESET_COOLDOWN_MS = 400;
/** Attack ramp of one tone, in seconds; keeps the start click-free. */
const ATTACK_SECONDS = 0.015;

/** One synthesised note. */
interface ToneSpec {
    /** Oscillator frequency in Hz. */
    frequency: number;
    /** Offset from the start of the preset, in seconds. */
    offset: number;
    /** Note length in seconds. */
    duration: number;
    /** Peak gain, 0..1. */
    gain: number;
    /** Oscillator waveform. */
    type: OscillatorType;
}

/**
 * Note sequences of the built-in presets.
 *
 * They are deliberately short (well under a second) and overlap a little, so a
 * burst of notifications is recognisable but does not become noise. The
 * per-preset cooldown below is the actual burst guard.
 */
const PRESETS: Record<NotificationSound, readonly ToneSpec[]> = {
    // Two rising sines: a soft "ding-dong" for a new message.
    message: [
        { frequency: 880, offset: 0, duration: 0.11, gain: 0.16, type: "sine" },
        { frequency: 1320, offset: 0.09, duration: 0.16, gain: 0.13, type: "sine" },
    ],
    // Three triangle beeps: an attention-grabbing alert.
    alert: [
        { frequency: 660, offset: 0, duration: 0.09, gain: 0.14, type: "triangle" },
        { frequency: 880, offset: 0.12, duration: 0.09, gain: 0.14, type: "triangle" },
        { frequency: 660, offset: 0.24, duration: 0.12, gain: 0.14, type: "triangle" },
    ],
    // Rising major arpeggio: a positive confirmation.
    success: [
        { frequency: 660, offset: 0, duration: 0.09, gain: 0.13, type: "sine" },
        { frequency: 880, offset: 0.08, duration: 0.09, gain: 0.13, type: "sine" },
        { frequency: 1320, offset: 0.16, duration: 0.18, gain: 0.12, type: "sine" },
    ],
};

/** The optional browser extensions this module tolerates. */
interface WebAudioWindow {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
}

/** `AudioContext.setSinkId()` is newer than the TypeScript DOM lib in use. */
interface SinkCapableAudioContext {
    setSinkId?(sinkId: string): Promise<void>;
}

/** Resolved constructor, or undefined when Web Audio is unavailable. */
const AudioContextCtor: typeof AudioContext | undefined = (() => {
    if (typeof window === "undefined")
        return undefined;

    const audioWindow = window as unknown as WebAudioWindow;
    return audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
})();

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Synthesised notification sounds and output-device scaffolding, exposed as
 * `window.TacPhone.audio` (see `AudioApi`).
 */
export class AudioEngine implements AudioApi
{
    private context: AudioContext | undefined;
    private outputDeviceId: string | undefined;
    /** Last successful play time per preset, for burst throttling. */
    private readonly lastPlayed = new Map<NotificationSound, number>();
    /** True once the "Web Audio is unavailable" warning was logged. */
    private warnedUnavailable = false;

    /** Plays one built-in preset; throttled and silent on a suspended context. */
    play(sound: NotificationSound): void {
        const preset = PRESETS[sound];
        if (!preset) {
            console.warn(`TacPhone audio: unknown sound preset "${String(sound)}".`);
            return;
        }

        const now = Date.now();
        const last = this.lastPlayed.get(sound) ?? 0;
        if (now - last < PRESET_COOLDOWN_MS)
            return;

        const context = this.ensureContext();
        if (!context)
            return;

        // Never schedule on a suspended context: it would play later, on
        // whatever gesture finally resumes it.
        if (context.state !== "running") {
            void context.resume().catch(error => {
                console.warn(`TacPhone audio: failed to resume the audio context: ${errorMessage(error)}`);
            });
            return;
        }

        this.lastPlayed.set(sound, now);
        this.schedulePreset(context, preset);
    }

    /** Event devices the browser exposes as audio outputs; empty when unsupported. */
    async enumerateDevices(): Promise<AudioDeviceInfo[]> {
        if (typeof navigator === "undefined")
            return [];

        const mediaDevices = navigator.mediaDevices;
        if (!mediaDevices || typeof mediaDevices.enumerateDevices !== "function")
            return [];

        try {
            const devices = await mediaDevices.enumerateDevices();
            return devices
                .filter(device => device.kind === "audiooutput")
                .map(device => ({
                    deviceId: device.deviceId,
                    label: device.label,
                    kind: device.kind,
                    groupId: device.groupId,
                }));
        } catch (error) {
            console.warn(`TacPhone audio: failed to enumerate audio devices: ${errorMessage(error)}`);
            return [];
        }
    }

    /** Routes this page's audio output to one device; rejects when unsupported. */
    async setSinkId(deviceId: string): Promise<void> {
        if (typeof deviceId !== "string" || deviceId.length === 0)
            throw new Error("TacPhone audio: setSinkId() needs a non-empty device id.");

        const context = this.ensureContext();
        if (!context) {
            throw new Error(
                "TacPhone audio: output selection is unavailable because Web Audio is not supported.",
            );
        }

        const sinkContext = context as unknown as SinkCapableAudioContext;
        if (typeof sinkContext.setSinkId !== "function") {
            throw new Error(
                "TacPhone audio: output selection is unavailable because this browser "
                + "does not support AudioContext.setSinkId().",
            );
        }

        await sinkContext.setSinkId(deviceId);
        this.outputDeviceId = deviceId;
    }

    /** Explicitly selected output device, or undefined when the browser default is used. */
    getOutputDeviceId(): string | undefined {
        return this.outputDeviceId;
    }

    /**
     * Creates the context if needed and resumes it. Called from the first user
     * gesture; safe to call repeatedly.
     */
    unlock(): void {
        const context = this.ensureContext();
        if (!context || context.state === "running")
            return;

        void context.resume().catch(error => {
            console.warn(`TacPhone audio: failed to resume the audio context: ${errorMessage(error)}`);
        });
    }

    /** Lazily creates the one context; undefined (with one warning) without Web Audio. */
    private ensureContext(): AudioContext | undefined {
        if (this.context)
            return this.context;

        if (!AudioContextCtor) {
            if (!this.warnedUnavailable) {
                this.warnedUnavailable = true;
                console.warn(
                    "TacPhone audio: Web Audio is not available in this browser; "
                    + "notification sounds are disabled.",
                );
            }
            return undefined;
        }

        try {
            this.context = new AudioContextCtor({ latencyHint: "interactive" });
        } catch (error) {
            if (!this.warnedUnavailable) {
                this.warnedUnavailable = true;
                console.warn(
                    `TacPhone audio: failed to create the audio context: ${errorMessage(error)}`,
                );
            }
            return undefined;
        }

        return this.context;
    }

    /** Schedules every tone of one preset relative to the current time. */
    private schedulePreset(context: AudioContext, preset: readonly ToneSpec[]): void {
        const start = context.currentTime + 0.01;

        for (const tone of preset) {
            try {
                this.scheduleTone(context, tone, start);
            } catch (error) {
                console.warn(`TacPhone audio: failed to schedule a sound: ${errorMessage(error)}`);
                return;
            }
        }
    }

    /** Builds and starts one oscillator with a click-free gain envelope. */
    private scheduleTone(context: AudioContext, tone: ToneSpec, startAt: number): void {
        const oscillator = context.createOscillator();
        const gain = context.createGain();

        const start = startAt + tone.offset;
        const end = start + tone.duration;
        const attackEnd = Math.min(start + ATTACK_SECONDS, end);

        oscillator.type = tone.type;
        oscillator.frequency.setValueAtTime(tone.frequency, start);

        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(tone.gain, attackEnd);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);

        oscillator.connect(gain);
        gain.connect(context.destination);

        oscillator.onended = () => {
            oscillator.disconnect();
            gain.disconnect();
        };

        oscillator.start(start);
        oscillator.stop(end + 0.02);
    }
}

/** The one audio engine of this page. */
export const audio = new AudioEngine();

/** Creates or resumes the context; installed once for the page lifetime. */
function unlockOnGesture(): void {
    audio.unlock();
}

// Capture phase and passive: the host must not interfere with app gestures.
window.addEventListener("pointerdown", unlockOnGesture, { capture: true, passive: true });
window.addEventListener("keydown", unlockOnGesture, { capture: true, passive: true });
