// Host-side audio engine.
//
// The host has no audio assets: every notification sound is synthesised with the
// Web Audio API from short oscillator/gain note sequences. The engine owns one
// lazily-created `AudioContext`, which is also the context used for output-device
// selection, so a future `setSinkId()` applies to notification sounds too.
//
// Browser autoplay policy: a context created without a user gesture starts
// suspended, and a sound scheduled on a suspended context only fires on whatever
// gesture finally resumes it (which reads as a random noise later). The engine
// therefore tracks `hasUserGesture`:
//
// - Before the first `pointerdown`/`keydown`/`touchstart`/`mousedown`, `play()`
//   drops the sound. It does not queue it for a later random click.
// - The first gesture creates (if needed) and resumes the context; the gesture
//   listeners stay installed and a `visibilitychange`/`focus` resume wakes a
//   context that was suspended by backgrounding the page.
// - After the first gesture, a suspended context keeps at most one pending
//   preset: `play()` stores it, resumes, and schedules it when `resume()` settles
//   within a short timeout. Otherwise the pending sound is dropped.
//
// `AudioTestHooks.ts` (debug builds only) turns on an analyser tap
// (`gain -> analyser -> destination`) so the browser tests can prove that the
// graph produced non-silent samples, and can render a preset offline.
//
// Nothing here throws on a runtime path: if Web Audio is unavailable the engine
// logs one warning and becomes a no-op. `setSinkId()` is the exception: it
// rejects with a clear error because it is an explicit request whose caller has
// to know that it did not happen.
//
// Output-device scaffolding: `enumerateDevices()`/`setSinkId()` exist so a future
// feature can mirror Arma's audio output device into the browser. The game cannot
// report its device today (see TODO.md); nothing here discovers it.

import type { AudioApi, AudioDeviceInfo, NotificationSound, SpeechOptions } from "./Types";

/** Minimum time between two sounds of the same preset, in milliseconds. */
const PRESET_COOLDOWN_MS = 400;
/** Attack ramp of one tone, in seconds; keeps the start click-free. */
const ATTACK_SECONDS = 0.015;
/**
 * How long a `play()` on a suspended context waits for `resume()` before it
 * drops the pending sound. Longer waits would feel like a random late noise.
 */
const PENDING_RESUME_TIMEOUT_MS = 500;
/** Analyser polling interval while a preset plays, in milliseconds. */
const PEAK_SAMPLE_INTERVAL_MS = 15;
/** Extra time the peak window stays open after the last tone ends, in ms. */
const PEAK_WINDOW_TAIL_MS = 250;
/** Offline render sample rate; the analyser test only needs a stable buffer. */
const OFFLINE_SAMPLE_RATE = 44_100;

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
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
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

/** Resolved offline constructor, or undefined when it is unavailable. */
const OfflineAudioContextCtor: typeof OfflineAudioContext | undefined = (() => {
    if (typeof window === "undefined")
        return undefined;

    const audioWindow = window as unknown as WebAudioWindow;
    return audioWindow.OfflineAudioContext ?? audioWindow.webkitOfflineAudioContext;
})();

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Plays one preset into any context; resolves when the last tone ended. */
function schedulePreset(
    context: BaseAudioContext,
    preset: readonly ToneSpec[],
    destination: AudioNode,
    onEnded?: () => void,
): void {
    const start = context.currentTime + 0.01;

    for (const [index, tone] of preset.entries()) {
        try {
            scheduleTone(context, tone, start, destination, index === preset.length - 1 ? onEnded : undefined);
        } catch (error) {
            console.warn(`TacPhone audio: failed to schedule a sound: ${errorMessage(error)}`);
            return;
        }
    }
}

/** Builds and starts one oscillator with a click-free gain envelope. */
function scheduleTone(
    context: BaseAudioContext,
    tone: ToneSpec,
    startAt: number,
    destination: AudioNode,
    onEnded?: () => void,
): void {
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
    gain.connect(destination);

    oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
        onEnded?.();
    };

    oscillator.start(start);
    oscillator.stop(end + 0.02);
}

/** Seconds from the start of a preset to the end of its last tone. */
function presetDuration(preset: readonly ToneSpec[]): number {
    return preset.reduce((end, tone) => Math.max(end, tone.offset + tone.duration), 0);
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
    /** True after the first real user gesture; sounds are dropped before it. */
    private hasUserGesture = false;
    /** At most one preset waiting for a suspended context to resume. */
    private pending: NotificationSound | undefined;
    /** Presets handed to the audio graph. */
    private scheduled = 0;
    /** Presets whose last tone ended. */
    private completed = 0;
    /** Debug-only analyser tap (`gain -> analyser -> destination`). */
    private analyser: AnalyserNode | undefined;
    private debugTapEnabled = false;
    private peakBuffer: Uint8Array<ArrayBuffer> | undefined;
    /** Highest analyser peak observed for the current/last preset, 0..1. */
    private lastPeak = 0;
    private peakTimer: number | undefined;
    private peakWindowEndsAt = 0;

    /** Plays one built-in preset; throttled, dropped before the first gesture. */
    play(sound: NotificationSound): void {
        const preset = PRESETS[sound];
        if (!preset) {
            console.warn(`TacPhone audio: unknown sound preset "${String(sound)}".`);
            return;
        }

        // Autoplay policy: a sound without a preceding gesture would only fire on
        // some later click. Drop it instead of queueing it.
        if (!this.hasUserGesture)
            return;

        const now = Date.now();
        const last = this.lastPlayed.get(sound) ?? 0;
        if (now - last < PRESET_COOLDOWN_MS)
            return;

        const context = this.ensureContext();
        if (!context)
            return;

        if (context.state === "running") {
            this.startPreset(context, sound);
            return;
        }

        // Suspended after a gesture (backgrounded page): keep one pending sound
        // and play it when the resume settles.
        if (this.pending !== undefined)
            return;

        this.pending = sound;
        this.resumePending(context, sound);
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

    /** True when the browser exposes the Web Speech API. */
    isSpeechAvailable(): boolean {
        return typeof window !== "undefined"
            && typeof window.speechSynthesis !== "undefined"
            && typeof window.SpeechSynthesisUtterance !== "undefined";
    }

    /**
     * Speaks text through the browser's SpeechSynthesis engine. Like `play()`,
     * this stays silent before the first user gesture and when unsupported.
     */
    speak(text: string, options: SpeechOptions = {}): void {
        const phrase = String(text ?? "").trim();
        if (phrase === "" || !this.hasUserGesture || !this.isSpeechAvailable())
            return;

        const synth = window.speechSynthesis;
        if (options.interrupt !== false)
            synth.cancel();

        const utterance = new SpeechSynthesisUtterance(phrase);
        utterance.rate = Number.isFinite(options.rate) ? options.rate! : 1;
        utterance.pitch = Number.isFinite(options.pitch) ? options.pitch! : 1;
        utterance.volume = Number.isFinite(options.volume) ? options.volume! : 0.9;
        if (options.lang)
            utterance.lang = options.lang;
        synth.speak(utterance);
    }

    /** Stops the current utterance, if any. */
    stopSpeaking(): void {
        if (typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined")
            window.speechSynthesis.cancel();
    }

    /**
     * Marks the first user gesture and creates/resumes the context. Called from
     * the page gesture listeners; safe to call repeatedly.
     */
    unlock(): void {
        this.hasUserGesture = true;
        this.resume();
    }

    /**
     * Wakes a context that browser backgrounding suspended. Called from the
     * `visibilitychange`/`focus` listeners: it never unlocks the context before
     * the first gesture, because focus is not a user activation.
     */
    resume(): void {
        if (!this.hasUserGesture)
            return;

        const context = this.ensureContext();
        if (!context)
            return;

        if (context.state === "running") {
            this.flushPending(context);
            return;
        }

        void context.resume().then(
            () => this.flushPending(context),
            error => {
                console.warn(`TacPhone audio: failed to resume the audio context: ${errorMessage(error)}`);
            },
        );
    }

    /**
     * Debug/test surface: turns the analyser tap on. Only the debug test hooks
     * call this; a normal page keeps `gain -> destination` directly.
     */
    enableDebugTap(): void {
        this.debugTapEnabled = true;
        if (this.context)
            this.ensureAnalyser(this.context);
    }

    /** Highest analyser peak seen for the current or last preset, 0..1. */
    samplePeak(): number {
        const analyser = this.analyser;
        if (!analyser)
            return this.lastPeak;

        if (!this.peakBuffer || this.peakBuffer.length !== analyser.fftSize)
            this.peakBuffer = new Uint8Array(analyser.fftSize);

        analyser.getByteTimeDomainData(this.peakBuffer);

        let peak = 0;
        for (const value of this.peakBuffer) {
            const amplitude = Math.abs(value - 128) / 128;
            if (amplitude > peak)
                peak = amplitude;
        }

        if (peak > this.lastPeak)
            this.lastPeak = peak;

        return this.lastPeak;
    }

    /** Debug/test surface: deterministic non-silence check for one preset. */
    async renderOffline(sound: NotificationSound): Promise<{ peak: number; duration: number; sampleRate: number }> {
        const preset = PRESETS[sound];
        if (!preset)
            throw new Error(`TacPhone audio: unknown sound preset "${String(sound)}".`);

        if (!OfflineAudioContextCtor)
            throw new Error("TacPhone audio: OfflineAudioContext is not available in this browser.");

        const duration = presetDuration(preset) + 0.1;
        const sampleRate = OFFLINE_SAMPLE_RATE;
        const offline = new OfflineAudioContextCtor(
            1,
            Math.max(1, Math.ceil(duration * sampleRate)),
            sampleRate,
        );

        schedulePreset(offline, preset, offline.destination);

        const buffer = await offline.startRendering();
        const samples = buffer.getChannelData(0);
        let peak = 0;
        for (const value of samples) {
            const amplitude = Math.abs(value);
            if (amplitude > peak)
                peak = amplitude;
        }

        return { peak, duration, sampleRate };
    }

    /** Immutable debug snapshot for the browser tests. */
    getDebugState(): {
        state: AudioContextState | "unavailable";
        currentTime: number;
        hasUserGesture: boolean;
        pending: NotificationSound | null;
        scheduled: number;
        completed: number;
        lastPeak: number;
    } {
        return {
            state: this.context?.state ?? (AudioContextCtor ? "suspended" : "unavailable"),
            currentTime: this.context?.currentTime ?? 0,
            hasUserGesture: this.hasUserGesture,
            pending: this.pending ?? null,
            scheduled: this.scheduled,
            completed: this.completed,
            lastPeak: this.lastPeak,
        };
    }

    /** Debug/test surface: suspends the context like a backgrounded page. */
    async suspendForTest(): Promise<void> {
        if (!this.context)
            return;

        try {
            await this.context.suspend();
        } catch (error) {
            console.warn(`TacPhone audio: failed to suspend the audio context: ${errorMessage(error)}`);
        }
    }

    /** Debug/test surface: resumes the context like a returning page. */
    async resumeForTest(): Promise<void> {
        const context = this.ensureContext();
        if (!context)
            return;

        try {
            await context.resume();
            this.flushPending(context);
        } catch (error) {
            console.warn(`TacPhone audio: failed to resume the audio context: ${errorMessage(error)}`);
        }
    }

    /** Schedules one preset now and updates the debug counters/peak window. */
    private startPreset(context: AudioContext, sound: NotificationSound): void {
        const preset = PRESETS[sound];

        this.lastPlayed.set(sound, Date.now());
        this.scheduled += 1;
        this.startPeakTracking(preset);

        schedulePreset(context, preset, this.outputNode(context), () => {
            this.completed += 1;
        });
    }

    /** Plays the single pending preset, if the context can run now. */
    private flushPending(context: AudioContext): void {
        const sound = this.pending;
        if (sound === undefined)
            return;

        this.pending = undefined;

        if (context.state !== "running")
            return;

        this.startPreset(context, sound);
    }

    /** Waits briefly for `resume()` and then plays or drops the pending preset. */
    private resumePending(context: AudioContext, sound: NotificationSound): void {
        let settled = false;

        const finish = (playIt: boolean): void => {
            if (settled)
                return;

            settled = true;
            clearTimeout(timer);

            if (this.pending === sound)
                this.pending = undefined;

            if (playIt && context.state === "running")
                this.startPreset(context, sound);
        };

        const timer = setTimeout(() => finish(true), PENDING_RESUME_TIMEOUT_MS);

        void context.resume().then(
            () => finish(true),
            error => {
                console.warn(`TacPhone audio: failed to resume the audio context: ${errorMessage(error)}`);
                finish(false);
            },
        );
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

        if (this.debugTapEnabled)
            this.ensureAnalyser(this.context);

        return this.context;
    }

    /**
     * Debug-only analyser tap: the analysed node is a pass-through, so it sits
     * between the preset gain and the speakers.
     */
    private ensureAnalyser(context: AudioContext): void {
        if (this.analyser || !this.debugTapEnabled)
            return;

        try {
            const analyser = context.createAnalyser();
            analyser.fftSize = 2048;
            analyser.connect(context.destination);
            this.analyser = analyser;
        } catch (error) {
            console.warn(`TacPhone audio: failed to install the analyser tap: ${errorMessage(error)}`);
        }
    }

    /** Output node of the tone graph: the analyser tap in debug builds, else the sink. */
    private outputNode(context: AudioContext): AudioNode {
        return this.analyser ?? context.destination;
    }

    /**
     * Samples the analyser while a preset plays so `lastPeak` captures the
     * loudest moment, not only whatever happens to be on screen at query time.
     */
    private startPeakTracking(preset: readonly ToneSpec[]): void {
        if (!this.analyser)
            return;

        this.lastPeak = 0;
        this.peakWindowEndsAt = performance.now() + presetDuration(preset) * 1000 + PEAK_WINDOW_TAIL_MS;

        if (this.peakTimer !== undefined)
            return;

        this.peakTimer = window.setInterval(() => {
            this.samplePeak();

            if (performance.now() >= this.peakWindowEndsAt) {
                window.clearInterval(this.peakTimer);
                this.peakTimer = undefined;
            }
        }, PEAK_SAMPLE_INTERVAL_MS);
    }
}

/** The one audio engine of this page. */
export const audio = new AudioEngine();

/** Creates or resumes the context; installed once for the page lifetime. */
function unlockOnGesture(): void {
    audio.unlock();
}

/** Resumes a context that browser backgrounding suspended. */
function resumeOnReturn(): void {
    if (document.visibilityState === "hidden")
        return;

    audio.resume();
}

// Capture phase and passive: the host must not interfere with app gestures.
// The listeners stay installed for the page lifetime; after the first gesture
// they keep a context that was suspended later alive.
for (const type of ["pointerdown", "keydown", "touchstart", "mousedown"] as const)
    window.addEventListener(type, unlockOnGesture, { capture: true, passive: true });

window.addEventListener("focus", resumeOnReturn);
document.addEventListener("visibilitychange", resumeOnReturn);
