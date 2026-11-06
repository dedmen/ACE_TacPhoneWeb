// In-game hub for every remote TacPhone client.
//
// The relay WebSocket and the debug LAN extension are only dumb pipes: SQF
// forwards their raw transport strings here and this manager owns the relay
// protocol state, peer bookkeeping, request/response correlation, terrain and
// texture production, and interest aggregation.
//
// Everything the hub sends through SQF is a normal `main` request, exactly as if
// the in-game browser had made it. Remote requests are therefore rewritten to a
// fresh A3API key and correlated back to the originating relay/LAN client.

import { decodeGameText } from "./GameText";
import { encodeTerrainChunks } from "./TerrainCache";
import type { TerrainData } from "./Types";
import { RelayPeers } from "./RelayPeers";
import { buildRelayStatus, PROTOCOL_VERSION, type RelayState } from "./RelayStatus";

const RELAY_PREFIX = "RELAY:";
const WEBHOST_PREFIX = "WEBHOST:";
const WEBHOST_DISCONNECT_PREFIX = "WEBHOST_DISCONNECT:";

const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type Transport = "relay" | "webhost";

type Identity = {
    hostId: string;
    secret: string;
};

type PendingRemoteRequest = {
    transport: Transport;
    clientId: string;
    originalKey: string;
};

type Frame = Record<string, unknown>;

/** The narrow surface the hub needs from `NetworkingA3`. */
export interface RelayNetworking {
    /** Sends a request to SQF without hub interception or timeout. */
    RequestDirect(data: object): Promise<object>;
    /**
     * Sends a request to SQF and reports the generated A3API key before the
     * request is dispatched, so the hub can correlate the eventual reply.
     */
    RequestTracked(
        data: object,
        onKey: (key: string) => void,
        timeoutMs: number,
    ): Promise<object>;
    LoadGameTerrain(config: object): Promise<TerrainData>;
    LoadGameFileTexture(path: string, maxSize: number): Promise<string>;
}

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Decodes a transport payload: base64 of UTF-8 text, repaired like a game reply. */
function decodeTransportPayload(payload: string): string | null {
    try {
        return decodeGameText(atob(payload));
    } catch (error) {
        console.warn("[TacPhone] Could not base64-decode a transport payload:", error);
        return null;
    }
}

/**
 * Owns the native relay session and the debug LAN clients.
 *
 * `NetworkingA3` forwards `RELAY:` / `WEBHOST:` transport strings here and lets
 * it intercept the host's `main` commands. All state is page-local: the hub is
 * the only component that knows which remote client is attached.
 */
export class RelayManager {
    private readonly net: RelayNetworking;
    private readonly isDebug: () => boolean;

    private running = false;
    private authSent = false;
    private state: RelayState = "idle";
    private hostId = "";
    private webBase = "";
    private error = "";
    private identity: Identity | null = null;
    private fileManifest: unknown[] = [];

    private code = "";
    private codeExpiresAt = 0;
    private codeTtl = 0;
    private shareKey = "";
    private shareUrl = "";
    private shareExpiresAt = 0;

    private readonly peers: RelayPeers;
    private readonly pendingRemoteRequests = new Map<string, PendingRemoteRequest>();

    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    public constructor(net: RelayNetworking, isDebug: () => boolean) {
        this.net = net;
        this.isDebug = isDebug;
        this.peers = new RelayPeers({
            send: (data) => this.net.RequestDirect(data),
        });
    }

    // ---------------------------------------------------------------------
    // Transport input
    // ---------------------------------------------------------------------

    /** Handles one raw string forwarded by SQF (`RELAY:` / `WEBHOST:`). */
    public OnTransportMessage(raw: string): void {
        if (typeof raw !== "string" || raw.length === 0) return;

        if (raw.startsWith(WEBHOST_DISCONNECT_PREFIX)) {
            this.removeWebhostClient(raw.slice(WEBHOST_DISCONNECT_PREFIX.length));
            return;
        }

        if (raw.startsWith(WEBHOST_PREFIX)) {
            this.handleWebhostMessage(decodeTransportPayload(raw.slice(WEBHOST_PREFIX.length)));
            return;
        }

        if (raw.startsWith(RELAY_PREFIX)) {
            this.handleRelayMessage(decodeTransportPayload(raw.slice(RELAY_PREFIX.length)));
            return;
        }

        console.warn("[TacPhone] Unexpected transport message prefix:", raw.slice(0, 32));
    }

    /** Handles a relay lifecycle event reported by SQF. */
    public OnRelayEvent(event: string, _detail?: unknown): void {
        if (!this.running) return;

        switch (event) {
            case "established":
                this.reconnectAttempt = 0;

                // The engine can deliver onWebsocketEstablished more than once
                // for the same socket. Only the first one may send auth.
                if (!this.authSent) {
                    this.authSent = true;
                    this.sendAuth();
                }
                break;

            case "lost":
                this.handleRelayLost();
                break;

            default:
                console.warn("[TacPhone] Unknown relay event:", event);
                break;
        }
    }

    private handleRelayMessage(text: string | null): void {
        if (!text || !this.running) return;

        // Control frames are JSON objects with `t`; application data is
        // `<peerId>\n<payload>`. Check the control shape first.
        if (text.trimStart().startsWith("{")) {
            try {
                const frame = JSON.parse(text) as unknown;
                if (frame && typeof frame === "object" && typeof (frame as Frame).t === "string") {
                    this.handleRelayControl(frame as Frame);
                    return;
                }
            } catch (error) {
                console.warn("[TacPhone] Invalid relay control frame:", error);
                return;
            }
        }

        const separator = text.indexOf("\n");
        if (separator <= 0) {
            console.warn("[TacPhone] Invalid relay application frame");
            return;
        }

        this.handleApplicationData("relay", text.slice(0, separator), text.slice(separator + 1));
    }

    private handleWebhostMessage(text: string | null): void {
        if (!text) return;

        let message: Frame;
        try {
            message = JSON.parse(text) as Frame;
        } catch (error) {
            console.warn("[TacPhone] Invalid webhost request:", error);
            return;
        }

        if (!message || typeof message !== "object") return;

        const clientId = asString(message.s);
        if (!clientId) {
            console.warn("[TacPhone] Webhost request without a client id");
            return;
        }

        // The first forwarded request is the LAN client's connect signal.
        this.peers.addLanClient(clientId);

        if (typeof message.k === "string") {
            this.handleRequest("webhost", clientId, message.k, message.d);
        }
    }

    private handleApplicationData(transport: Transport, clientId: string, payload: string): void {
        if (!clientId || !payload) return;

        let message: Frame;
        try {
            message = JSON.parse(payload) as Frame;
        } catch (error) {
            console.warn("[TacPhone] Invalid remote application payload:", error);
            return;
        }

        if (!message || typeof message !== "object") return;
        if (typeof message.k !== "string") return;

        this.handleRequest(transport, clientId, message.k, message.d);
    }

    // ---------------------------------------------------------------------
    // Relay control frames
    // ---------------------------------------------------------------------

    private handleRelayControl(frame: Frame): void {
        if (!this.running) return;

        switch (frame.t) {
            case "auth-ok":
                this.handleAuthOk(frame);
                break;

            case "peer-joined": {
                const id = asString(frame.peerId);
                if (!id) break;
                this.peers.registerRelayPeer({
                    id,
                    label: asString(frame.label),
                    via: asString(frame.via),
                    connectedAt: asString(frame.connectedAt),
                    firstSeenAt: asString(frame.firstSeenAt),
                });
                break;
            }

            case "peer-left": {
                const id = asString(frame.peerId);
                if (id) this.removeRelayPeer(id);
                break;
            }

            case "code": {
                const expiresIn = Math.max(0, asNumber(frame.expiresIn));
                this.code = asString(frame.code);
                this.codeTtl = expiresIn;
                this.codeExpiresAt = Date.now() + expiresIn * 1000;
                break;
            }

            case "code-used":
                this.code = "";
                this.codeTtl = 0;
                this.codeExpiresAt = 0;
                break;

            case "share": {
                const expiresIn = Math.max(0, asNumber(frame.expiresIn));
                this.shareKey = asString(frame.key);
                this.shareUrl = asString(frame.url);
                this.shareExpiresAt = Date.now() + expiresIn * 1000;
                break;
            }

            case "share-revoked":
                this.shareKey = "";
                this.shareUrl = "";
                this.shareExpiresAt = 0;
                break;

            case "error":
                this.error = asString(frame.message) || asString(frame.code);
                break;

            case "ping":
                // The relay drops hosts that do not answer its keepalive.
                this.sendRelay({ t: "pong" });
                break;

            case "pong":
                break;

            case "send-result": {
                const unknown = frame.unknown;
                if (Array.isArray(unknown) && unknown.length > 0) {
                    console.warn("[TacPhone] Relay could not deliver to:", unknown);
                }
                break;
            }

            default:
                console.warn("[TacPhone] Unknown relay control frame:", frame.t);
                break;
        }
    }

    private handleAuthOk(frame: Frame): void {
        const hostId = asString(frame.hostId);
        if (hostId) this.hostId = hostId;

        const secret = asString(frame.secret);
        if (secret && (this.identity?.secret !== secret || this.identity?.hostId !== this.hostId)) {
            this.identity = { hostId: this.hostId, secret };
            void this.net.RequestDirect({
                a: "main",
                c: "RemoteAccess.SetAuthIdentity",
                identity: JSON.stringify(this.identity),
            }).catch((requestError) => {
                console.warn("[TacPhone] Could not store the relay identity:", requestError);
            });
        }

        this.state = "online";
        this.error = "";
        this.reconnectAttempt = 0;

        // The manifest lets the relay cache app/dependency files it already has.
        if (this.fileManifest.length > 0) {
            this.sendRelay({ t: "files", files: this.fileManifest });
        }
    }

    private handleRelayLost(): void {
        this.authSent = false;

        // Peer ids from the old socket are never reused, so every relay client
        // and its in-flight requests are gone.
        const relayClients = new Set(this.peers.relayPeerIds());
        for (const pending of this.pendingRemoteRequests.values()) {
            if (pending.transport === "relay") relayClients.add(pending.clientId);
        }

        this.peers.clearRelayPeers();
        for (const [key, pending] of [...this.pendingRemoteRequests]) {
            if (pending.transport === "relay") this.pendingRemoteRequests.delete(key);
        }
        for (const clientId of relayClients) {
            this.peers.clearClientInterests(clientId);
            void this.net.RequestDirect({
                a: "main",
                c: "Client.Disconnected",
                clientId,
            }).catch((error) => {
                console.warn("[TacPhone] Could not report a lost relay client:", error);
            });
        }

        this.code = "";
        this.codeTtl = 0;
        this.codeExpiresAt = 0;
        this.state = "connecting";
        this.error = "";
        this.scheduleReconnect();
    }

    private sendAuth(): void {
        const frame: Frame = {
            t: "auth",
            proto: PROTOCOL_VERSION,
            role: "game",
            label: "TacPhone",
        };

        if (this.identity?.hostId) frame.hostId = this.identity.hostId;
        if (this.identity?.secret) frame.secret = this.identity.secret;

        this.sendRelay(frame);
    }

    // ---------------------------------------------------------------------
    // Local panel commands (`NetworkingA3.Request` interception)
    // ---------------------------------------------------------------------

    /**
     * Handles a request made by the in-game page itself.
     *
     * Returns `null` when the request must go to SQF unchanged.
     */
    public TryHandleLocalRequest(data: object): Promise<object> | null {
        const request = data as Frame;
        if (request.a !== "main") return null;

        const command = asString(request.c);

        if (command === "Interest.Set" || command === "Interest.Clear") {
            return Promise.resolve(this.handleLocalInterest(request));
        }

        if (command === "Debug.RemoteAccess") {
            return this.handleLocalDebug(request);
        }

        if (command.startsWith("RemoteAccess.")) {
            return this.handleLocalRemoteAccess(command.slice("RemoteAccess.".length), request);
        }

        return null;
    }

    private handleLocalInterest(request: Frame): object {
        if (request.c === "Interest.Clear") {
            this.peers.clearClientInterests("local");
            return { ok: true };
        }

        const interest = asString(request.interest);
        if (!interest) {
            return { ok: false, error: "invalid interest name" };
        }

        this.peers.applyInterest("local", interest, request.active === true);
        return { ok: true };
    }

    private handleLocalDebug(request: Frame): Promise<object> {
        if (!this.isDebug()) {
            return Promise.resolve({ ok: false, error: "debug mode is disabled" });
        }

        return this.handleDebugAction(request);
    }

    private handleLocalRemoteAccess(
        subcommand: string,
        request: Frame,
    ): Promise<object> | null {
        switch (subcommand) {
            case "Start":
                return this.start(request.files);

            case "Stop":
                return this.stop();

            case "Status":
                return Promise.resolve(this.status());

            case "NewCode":
                return this.requireOnline(() => this.sendRelay({ t: "code-new" }));

            case "ShareCreate": {
                const ttlSeconds = Math.max(60, Math.min(86_400, asNumber(request.ttlSeconds) || 3600));
                return this.requireOnline(() => this.sendRelay({ t: "share-create", ttlSeconds }));
            }

            case "ShareRevoke":
                return this.requireOnline(() => this.sendRelay({ t: "share-revoke" }));

            case "Kick": {
                const peerId = asString(request.peerId);
                if (!peerId) return Promise.resolve({ ok: false, error: "missing peer id" });
                return this.requireOnline(() => this.sendRelay({ t: "kick", peerId }));
            }

            // Internal commands. The panel never calls them; they belong to SQF.
            case "CopyToClipboard":
            case "GetAuthIdentity":
            case "SetAuthIdentity":
            case "Forward":
                return null;

            default:
                return Promise.resolve({
                    ok: false,
                    error: `unknown remote access command: ${subcommand}`,
                });
        }
    }

    private requireOnline(action: () => void): Promise<object> {
        if (this.state !== "online") {
            return Promise.resolve({ ok: false, error: "relay not connected" });
        }

        action();
        return Promise.resolve({ ok: true });
    }

    private async handleDebugAction(request: Frame): Promise<object> {
        const action = (asString(request.action) || "status").toLowerCase();

        switch (action) {
            case "start":
                return this.start();

            case "stop":
                return this.stop();

            case "status":
                return this.status();

            case "share": {
                const ttlSeconds = Math.max(60, Math.min(86_400, asNumber(request.ttlSeconds) || 900));
                if (this.state !== "online") return { ok: false, error: "relay not connected" };
                this.sendRelay({ t: "share-create", ttlSeconds });
                return { ok: true };
            }

            case "revoke":
                if (this.state !== "online") return { ok: false, error: "relay not connected" };
                this.sendRelay({ t: "share-revoke" });
                return { ok: true };

            case "kick": {
                const peerId = asString(request.peerId);
                if (!peerId) return { ok: false, error: "missing peer id" };
                if (this.state !== "online") return { ok: false, error: "relay not connected" };
                this.sendRelay({ t: "kick", peerId });
                return { ok: true };
            }

            default:
                return { ok: false, error: "Unknown remote access action" };
        }
    }

    private async start(files?: unknown): Promise<object> {
        if (Array.isArray(files)) {
            this.fileManifest = files;
        }

        if (this.running && this.state !== "error") {
            // Re-arming an already connected host only refreshes the manifest.
            if (this.state === "online" && this.fileManifest.length > 0) {
                this.sendRelay({ t: "files", files: this.fileManifest });
            }
            return this.status();
        }

        this.running = true;
        this.authSent = false;
        this.state = "connecting";
        this.error = "";
        this.peers.clearRelayPeers();
        this.code = "";
        this.codeTtl = 0;
        this.codeExpiresAt = 0;
        this.shareKey = "";
        this.shareUrl = "";
        this.shareExpiresAt = 0;
        this.reconnectAttempt = 0;
        this.clearReconnectTimer();

        try {
            const raw = await this.net.RequestDirect({
                a: "main",
                c: "RemoteAccess.GetAuthIdentity",
            });
            this.identity = this.parseIdentity(raw);
            if (this.identity?.hostId) this.hostId = this.identity.hostId;
        } catch (identityError) {
            console.warn("[TacPhone] Could not load the relay identity:", identityError);
            this.identity = null;
        }

        // Stop may have raced the identity request.
        if (!this.running) return this.status();

        await this.connect();

        return this.status();
    }

    private parseIdentity(raw: unknown): Identity | null {
        let value: unknown = raw;

        if (typeof value === "string") {
            if (!value) return null;
            try {
                value = JSON.parse(value);
            } catch {
                return null;
            }
        }

        if (!value || typeof value !== "object") return null;

        const record = value as Frame;
        const hostId = asString(record.hostId) || asString(record.id);
        const secret = asString(record.secret);

        if (!hostId && !secret) return null;

        return { hostId, secret };
    }

    /** Calls SQF `RemoteAccess.Start` and stores the browser base URL. */
    private async connect(): Promise<void> {
        try {
            const result = (await this.net.RequestDirect({
                a: "main",
                c: "RemoteAccess.Start",
            })) as Frame;

            if (result && result.ok === false) {
                this.state = "error";
                this.error = asString(result.error) || "relay start failed";

                if (this.reconnectAttempt > 0) this.scheduleReconnect();
                else this.running = false;
                return;
            }

            if (result) {
                this.webBase = asString(result.webBase) || this.webBase;
                this.hostId = asString(result.hostId) || this.hostId;
            }

            this.state = "connecting";
        } catch (error) {
            this.state = "error";
            this.error = String(error);

            if (this.reconnectAttempt > 0) this.scheduleReconnect();
            else this.running = false;
        }
    }

    private stop(): Promise<object> {
        this.running = false;
        this.authSent = false;
        this.clearReconnectTimer();
        this.reconnectAttempt = 0;

        const relayClients = new Set([...this.peers.relayPeerIds(), ...this.peers.remoteInterestClients()]);

        this.state = "idle";
        this.error = "";
        this.peers.clearRelayPeers();
        this.code = "";
        this.codeTtl = 0;
        this.codeExpiresAt = 0;
        this.shareKey = "";
        this.shareUrl = "";
        this.shareExpiresAt = 0;

        // Stop only ends the relay session. LAN debug requests keep running.
        for (const [key, pending] of [...this.pendingRemoteRequests]) {
            if (pending.transport === "relay") {
                this.pendingRemoteRequests.delete(key);
            }
        }

        for (const clientId of relayClients) {
            this.peers.clearClientInterests(clientId);
            void this.net.RequestDirect({
                a: "main",
                c: "Client.Disconnected",
                clientId,
            }).catch((error) => {
                console.warn("[TacPhone] Could not report a stopped relay client:", error);
            });
        }

        void this.net.RequestDirect({ a: "main", c: "RemoteAccess.Stop" }).catch((error) => {
            console.warn("[TacPhone] Could not stop the relay:", error);
        });

        return Promise.resolve(this.status());
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer !== null || !this.running) return;

        const delay = Math.min(
            RECONNECT_MAX_MS,
            RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt, 5),
        );
        this.reconnectAttempt++;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.running) void this.connect();
        }, delay);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private status(): Record<string, unknown> {
        return buildRelayStatus({
            state: this.state,
            hostId: this.hostId,
            webBase: this.webBase,
            error: this.error,
            code: this.code,
            codeTtl: this.codeTtl,
            codeExpiresAt: this.codeExpiresAt,
            shareKey: this.shareKey,
            shareUrl: this.shareUrl,
            shareExpiresAt: this.shareExpiresAt,
            peers: this.peers.relayPeers(),
        });
    }

    // ---------------------------------------------------------------------
    // Remote requests
    // ---------------------------------------------------------------------

    private handleRequest(
        transport: Transport,
        clientId: string,
        originalKey: string,
        data: unknown,
    ): void {
        if (!data || typeof data !== "object") {
            this.reply(transport, clientId, originalKey, {
                ok: false,
                error: "invalid request",
            });
            return;
        }

        const request = data as Frame;
        const command = request.a === "main" ? asString(request.c) : "";

        switch (command) {
            case "RequestTerrainSVG":
                void this.handleTerrainRequest(transport, clientId, originalKey, request);
                return;

            case "RequestTexture":
                void this.handleTextureRequest(transport, clientId, originalKey, request);
                return;

            // Clients never answer these; SQF no longer proxies them.
            case "ReplyRequestTerrainSVG":
            case "ReplyRequestTexture":
                return;

            case "Interest.Set":
            case "Interest.Clear":
                this.handleRemoteInterest(transport, clientId, originalKey, request);
                return;
        }

        // Commands that SQF would only accept from the in-game page must not be
        // laundered through the hub's "local" rewrite.
        if (
            command.startsWith("RemoteAccess.")
            || command === "GetHostLog"
            || command === "WebHost.Send"
            || command === "Client.Disconnected"
        ) {
            this.reply(transport, clientId, originalKey, { ok: false, error: "forbidden" });
            return;
        }

        if (command === "Debug.RemoteAccess") {
            if (!this.isDebug()) {
                this.reply(transport, clientId, originalKey, {
                    ok: false,
                    error: "debug mode is disabled",
                });
                return;
            }

            void this.handleDebugAction(request).then(
                result => this.reply(transport, clientId, originalKey, result),
                error => this.reply(transport, clientId, originalKey, {
                    ok: false,
                    error: String(error),
                }),
            );
            return;
        }

        void this.forwardRequest(transport, clientId, originalKey, request);
    }

    private async forwardRequest(
        transport: Transport,
        clientId: string,
        originalKey: string,
        request: Frame,
    ): Promise<void> {
        let localKey = "";

        // SQF must see exactly what the in-game browser would send: no source
        // metadata, no request key and no silencing hints from a remote client.
        const forwarded = { ...request };
        delete forwarded.__client;
        delete forwarded.__requestKey;
        delete forwarded.__silent;

        try {
            const result = await this.net.RequestTracked(
                forwarded,
                (key) => {
                    localKey = key;
                    this.pendingRemoteRequests.set(key, { transport, clientId, originalKey });
                },
                REQUEST_TIMEOUT_MS,
            );

            this.pendingRemoteRequests.delete(localKey);
            this.reply(transport, clientId, originalKey, result);
        } catch (error) {
            if (localKey) this.pendingRemoteRequests.delete(localKey);
            this.reply(transport, clientId, originalKey, {
                ok: false,
                error: String(error),
            });
        }
    }

    private async handleTerrainRequest(
        transport: Transport,
        clientId: string,
        originalKey: string,
        request: Frame,
    ): Promise<void> {
        const uid = request.uid;

        try {
            const config = request.config && typeof request.config === "object"
                ? request.config
                : {};
            const terrain = await this.net.LoadGameTerrain(config);

            for await (const chunk of encodeTerrainChunks(terrain, this.isDebug())) {
                // Await each chunk so a large terrain transfer does not flood
                // the page->SQF request bridge.
                await this.replyAsync(transport, clientId, originalKey, {
                    a: "main",
                    c: "ReplyRequestTerrainSVG",
                    uid,
                    ...chunk,
                });
            }
        } catch (error) {
            this.reply(transport, clientId, originalKey, {
                a: "main",
                c: "ReplyRequestTerrainSVG",
                uid,
                error: String(error),
            });
        }
    }

    private async handleTextureRequest(
        transport: Transport,
        clientId: string,
        originalKey: string,
        request: Frame,
    ): Promise<void> {
        const path = asString(request.path);
        const maxSize = asNumber(request.maxSize);

        try {
            const texture = await this.net.LoadGameFileTexture(path, maxSize);
            // LoadGameFileTexture's caller expects the texture string itself as
            // the request result, not a ReplyRequestTexture envelope.
            this.reply(transport, clientId, originalKey, texture);
        } catch (error) {
            this.reply(transport, clientId, originalKey, {
                ok: false,
                error: String(error),
            });
        }
    }

    private handleRemoteInterest(
        transport: Transport,
        clientId: string,
        originalKey: string,
        request: Frame,
    ): void {
        if (request.c === "Interest.Clear") {
            this.peers.clearClientInterests(clientId);
            this.reply(transport, clientId, originalKey, { ok: true });
            return;
        }

        const interest = asString(request.interest);
        if (!interest) {
            this.reply(transport, clientId, originalKey, {
                ok: false,
                error: "invalid interest name",
            });
            return;
        }

        this.peers.applyInterest(clientId, interest, request.active === true);
        this.reply(transport, clientId, originalKey, { ok: true });
    }

    // ---------------------------------------------------------------------
    // Client lifecycle
    // ---------------------------------------------------------------------

    private removeRelayPeer(clientId: string): void {
        if (!this.peers.removeRelayPeer(clientId)) return;

        this.dropPendingForClient("relay", clientId);
        this.peers.clearClientInterests(clientId);

        void this.net.RequestDirect({
            a: "main",
            c: "Client.Disconnected",
            clientId,
        }).catch((error) => {
            console.warn("[TacPhone] Could not report a disconnected relay client:", error);
        });
    }

    private removeWebhostClient(clientId: string): void {
        if (!clientId) return;

        this.peers.removeLanClient(clientId);
        this.dropPendingForClient("webhost", clientId);
        this.peers.clearClientInterests(clientId);
    }

    private dropPendingForClient(transport: Transport, clientId: string): void {
        for (const [key, pending] of [...this.pendingRemoteRequests]) {
            if (pending.transport === transport && pending.clientId === clientId) {
                this.pendingRemoteRequests.delete(key);
            }
        }
    }

    // ---------------------------------------------------------------------
    // Outbound routing
    // ---------------------------------------------------------------------

    /** Broadcasts a game-script message to every relay and LAN client. */
    public BroadcastGameMessage(message: object): void {
        const data = JSON.stringify({ k: "command", d: message });
        this.sendRelayData(["*"], data);
        this.sendLan(["*"], data);
    }

    private reply(
        transport: Transport,
        clientId: string,
        originalKey: string,
        data: unknown,
    ): void {
        const payload = JSON.stringify({ k: originalKey, d: data });

        if (transport === "relay") {
            this.sendRelayData([clientId], payload);
            return;
        }

        if (!this.peers.hasLanClient(clientId)) return;
        this.sendLan([clientId], payload);
    }

    /**
     * Same as reply(), but waits for the page->SQF request to be accepted.
     * Used for streamed terrain chunks so their size cannot flood the bridge.
     */
    private async replyAsync(
        transport: Transport,
        clientId: string,
        originalKey: string,
        data: unknown,
    ): Promise<void> {
        const payload = JSON.stringify({ k: originalKey, d: data });

        try {
            if (transport === "relay") {
                if (!this.running || this.state !== "online") return;
                await this.net.RequestDirect({
                    a: "main",
                    c: "RemoteAccess.Forward",
                    data: JSON.stringify({ t: "send", targets: [clientId], data: payload }),
                });
                return;
            }

            if (!this.peers.hasLanClient(clientId)) return;
            await this.net.RequestDirect({
                a: "main",
                c: "WebHost.Send",
                payload: JSON.stringify({ targets: [clientId], data: payload }),
            });
        } catch (error) {
            console.warn("[TacPhone] Could not send a streamed reply:", error);
        }
    }

    private sendRelayData(targets: string[], data: string): void {
        if (!this.running || this.state !== "online") return;
        this.sendRelay({ t: "send", targets, data });
    }

    private sendRelay(frame: object): void {
        if (!this.running) return;

        void this.net.RequestDirect({
            a: "main",
            c: "RemoteAccess.Forward",
            data: JSON.stringify(frame),
        }).catch((error) => {
            console.warn("[TacPhone] Could not forward a relay frame:", error);
        });
    }

    private sendLan(targets: string[], data: string): void {
        if (this.peers.lanClientsCount() === 0) return;

        void this.net.RequestDirect({
            a: "main",
            c: "WebHost.Send",
            payload: JSON.stringify({ targets, data }),
        }).catch((error) => {
            console.warn("[TacPhone] Could not send a LAN frame:", error);
        });
    }
}
