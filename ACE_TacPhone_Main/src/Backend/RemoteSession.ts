// Pairing and connection state of the public relay page.
//
// `NetworkingWebsocket` owns the socket; this session owns the state machine
// around it: pairing data (URL code/share, stored device token), the attach
// frame, the relay control frames, retry timing and the UI-facing
// `RemoteSessionApi` handle. The socket and the LAN-side caches are reached
// only through the narrow `RemoteSessionTransport` interface.

import { t } from "./i18n";

/** Pairing/connection state of the public relay page. */
export type RemoteState = "need-pairing" | "attaching" | "connected" | "host-offline" | "rejected";

/** UI-facing handle for the relay session; `null` outside the hosted page. */
export interface RemoteSessionApi {
    getState(): RemoteState;
    getError(): string;
    subscribe(listener: () => void): () => void;
    attachCode(code: string): void;
    retry(): void;
}

type RemoteAttach =
    | { kind: "token"; value: string; hostId?: string }
    | { kind: "code"; value: string }
    | { kind: "share"; value: string };

const DEVICE_STORAGE_PREFIX = "tacphone.device.";
const REMOTE_RETRY_MS = 15_000;

/** The websocket operations the remote session drives. */
export interface RemoteSessionTransport {
    /** The currently open (or connecting) relay socket, if any. */
    socket: WebSocket;
    /** Marks the transport not yet usable (socket closing or reconnecting). */
    markNotReady(): void;
    /** Marks the transport usable (attach-ok arrived). */
    markReady(): void;
    /** Resolves the `WhenReady` promise after a successful attach. */
    settleReady(): void;
    /** Clears terrain state cached for the previous host. */
    clearTerrain(): void;
    /** Sends every queued request now that the socket is open. */
    flushQueue(): void;
    /** Delivers one raw socket message to the shared transport handler. */
    deliverMessage(data: unknown): void;
    /** Notifies connectivity listeners. */
    notifyConnectionChange(connected: boolean): void;
}

/**
 * Owns the relay pairing state machine.
 *
 * The session never touches the socket directly: `open()` wires the socket's
 * lifecycle to itself, and everything else goes through the transport.
 */
export class RemoteSession {
    private state: RemoteState = "need-pairing";
    private error = "";
    private listeners = new Set<() => void>();
    private pendingAttach: RemoteAttach | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private hostId = "";

    readonly api: RemoteSessionApi;
    private readonly transport: RemoteSessionTransport;

    constructor(transport: RemoteSessionTransport) {
        this.transport = transport;

        this.api = {
            getState: () => this.state,
            getError: () => this.error,
            subscribe: (listener) => {
                this.listeners.add(listener);
                return () => { this.listeners.delete(listener); };
            },
            attachCode: (code) => this.attachCode(code),
            retry: () => this.retry(),
        };
    }

    private setState(state: RemoteState, error = ""): void {
        if (this.state === state && this.error === error) return;
        this.state = state;
        this.error = error;

        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (listenerError) {
                console.error("TacPhone remote state listener failed:", listenerError);
            }
        }
    }

    /** Resolves pairing data from the URL or the stored device, then connects. */
    prepareRemote(): void {
        // Pairing data can arrive as #p=<code>, #s=<share>, ?p=<code> or ?s=<share>.
        const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const query = new URLSearchParams(window.location.search);

        const code = query.get("p") || query.get("code") || hash.get("p") || hash.get("code");
        const share = query.get("s") || query.get("share") || hash.get("s") || hash.get("share");

        if (code || share) {
            // Do not leave a bearer key in the address bar/history.
            history.replaceState(null, "", window.location.pathname);
            this.pendingAttach = code
                ? { kind: "code", value: normalizeCode(code) }
                : { kind: "share", value: share! };
            this.open();
            return;
        }

        const stored = this.loadDevice();
        if (stored) {
            this.hostId = stored.hostId;
            this.pendingAttach = { kind: "token", value: stored.token, hostId: stored.hostId };
            this.open();
            return;
        }

        this.setState("need-pairing");
    }

    attachCode(code: string): void {
        const normalized = normalizeCode(code);
        if (!normalized) {
            this.setState("need-pairing", t('STR_ACE_Tacphone_RemoteAccess_PairingErrorInvalidCode'));
            return;
        }

        this.pendingAttach = { kind: "code", value: normalized };
        this.setState("attaching");
        this.open();
    }

    retry(): void {
        this.clearRetryTimer();
        this.open(true);
    }

    /** Opens the relay socket and wires its lifecycle to the session. */
    open(silent = false): void {
        if (!this.pendingAttach) {
            this.setState("need-pairing");
            return;
        }

        this.clearRetryTimer();
        this.transport.markNotReady();
        if (!silent) this.setState("attaching");

        const socket = new WebSocket(`wss://${window.location.host}/ws`);
        socket.binaryType = "arraybuffer";
        this.transport.socket = socket;

        socket.onopen = () => {
            this.sendAttach();
        };

        socket.onmessage = (event) => {
            this.transport.deliverMessage(event.data);
        };

        socket.onclose = () => {
            this.transport.markNotReady();
            this.transport.clearTerrain();
            // Keep queued requests: they flush again after the next attach.
            this.transport.notifyConnectionChange(false);

            if (this.state === "rejected") return;
            if (!this.pendingAttach) {
                this.setState("need-pairing");
                return;
            }

            this.setState("host-offline");
            this.scheduleRetry();
        };

        socket.onerror = () => {
            // onclose follows and schedules the retry.
            console.log("[error] TacPhone relay socket error");
        };
    }

    private clearRetryTimer(): void {
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    private scheduleRetry(): void {
        if (this.retryTimer !== null) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.open(true);
        }, REMOTE_RETRY_MS);
    }

    private loadDevice(): { hostId: string; token: string } | null {
        try {
            const raw = localStorage.getItem(DEVICE_STORAGE_PREFIX + window.location.host);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as { hostId?: string; token?: string };
            if (!parsed?.token) return null;
            return { hostId: parsed.hostId ?? "", token: parsed.token };
        } catch (error) {
            console.warn("Could not read the stored TacPhone device token:", error);
            return null;
        }
    }

    private saveDevice(hostId: string, token: string): void {
        try {
            localStorage.setItem(
                DEVICE_STORAGE_PREFIX + window.location.host,
                JSON.stringify({ hostId, token }),
            );
        } catch (error) {
            console.warn("Could not persist the TacPhone device token:", error);
        }
    }

    private sendAttach(): void {
        if (!this.pendingAttach) return;

        const frame: Record<string, unknown> = { t: "attach", proto: 1, role: "client" };

        if (this.pendingAttach.kind === "token") {
            frame.deviceToken = this.pendingAttach.value;
            if (this.pendingAttach.hostId) frame.hostId = this.pendingAttach.hostId;
        } else if (this.pendingAttach.kind === "code") {
            frame.code = this.pendingAttach.value;
        } else {
            frame.share = this.pendingAttach.value;
        }

        try {
            this.transport.socket.send(JSON.stringify(frame));
        } catch (error) {
            console.error("Could not send the TacPhone attach frame:", error);
        }
    }

    handleRemoteControl(frame: any): void {
        switch (frame.t) {
            case "attach-ok": {
                const token: string | undefined = frame.deviceToken;
                const hostId: string = frame.hostId ?? this.hostId ?? "";

                // The relay can switch its game host without closing this socket;
                // terrain cached for the old host must not survive that.
                if (hostId !== this.hostId) {
                    this.transport.clearTerrain();
                }

                if (token) {
                    this.hostId = hostId;
                    this.pendingAttach = { kind: "token", value: token, hostId };
                    this.saveDevice(hostId, token);
                }

                this.transport.markReady();
                this.setState("connected");
                this.transport.settleReady();
                this.transport.flushQueue();
                this.transport.notifyConnectionChange(true);
                break;
            }

            case "host-offline":
                this.setState("host-offline", t('STR_ACE_Tacphone_RemoteAccess_PairingErrorHostOffline'));
                this.transport.socket?.close();
                break;

            case "rejected":
                this.setState("rejected", t('STR_ACE_Tacphone_RemoteAccess_PairingErrorRejected', frame.reason ?? t('STR_ACE_Tacphone_RemoteAccess_PairingErrorUnknownReason')));
                this.pendingAttach = null;
                this.transport.socket?.close();
                break;

            case "peer-kicked":
                this.setState("host-offline", t('STR_ACE_Tacphone_RemoteAccess_PairingErrorSessionEnded'));
                this.transport.socket?.close();
                break;

            case "ping":
                // The relay drops peers that do not answer its keepalive.
                try {
                    this.transport.socket?.send(JSON.stringify({ t: "pong" }));
                } catch (error) {
                    console.warn("Could not answer the TacPhone relay ping:", error);
                }
                break;

            case "pong":
                break;

            default:
                // Keep this visible: an unexpected control frame means the server and
                // page disagree about the protocol version.
                console.warn("Unknown TacPhone relay control frame:", frame);
                break;
        }
    }
}

/** Normalises a pairing code: uppercase, alphanumerics only. */
function normalizeCode(code: string): string {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
