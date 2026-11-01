/**
 * Minimal TacPhone WebSocket client for the shared test harness.
 *
 * This is the one copy used by the host, Map and Messenger Node suites (the app
 * test folders import it from `ACE_TacPhone_Main/test/lib/ws-client.mjs`).
 *
 * Wire format:
 *   request  -> { k: "<unique key>", d: { a: "<app>", c: "...", ... } }
 *   reply    -> { k: "<same key>", d: <result> }
 *   push     -> { k: "command", d: { a: "<app>", c: "...", ... } }
 *
 * The client defaults to `a: "main"`; pass `options.app` for the connection's
 * default app and `{ app }` per request to override it. Binary frames (the
 * public relay sends raw JSON as binary) are decoded as UTF-8 by RawWebSocket.
 *
 * The TacPhone web host rejects WebSocket handshakes without an allowed
 * `Origin` header, so this uses a small RFC 6455 client over `https.request()`
 * instead of Node's built-in WebSocket.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

export const DEFAULT_URL = 'wss://localhost:8001/ws';
export const MAIN_APP = 'main';

export class WsError extends Error {
    constructor(message, options = {}) {
        super(message, options);
        this.name = 'WsError';
    }
}

export class WsTimeoutError extends WsError {
    constructor(message, details = {}) {
        super(message);
        this.name = 'WsTimeoutError';
        this.details = details;
    }
}

/** Origin a browser page served by the same host would send. */
export function originFor(url) {
    const parsed = new URL(url);
    const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:';

    return `${scheme}//${parsed.host}`;
}

/** Reads a text frame from any message shape the transports use. */
function decodeMessageData(data) {
    if (typeof data === 'string') {
        return data;
    }

    if (data instanceof ArrayBuffer) {
        return new TextDecoder().decode(data);
    }

    if (ArrayBuffer.isView(data)) {
        return new TextDecoder().decode(data);
    }

    if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return data.text();
    }

    return String(data);
}

function certificateHint(message) {
    if (!/certificate|self.signed|unable to verify|altname|cert_/i.test(message)) {
        return '';
    }

    return (
        '\n  The local TacPhone certificate is not trusted by Node.' +
        '\n  Trust the certificate or point NODE_EXTRA_CA_CERTS at its PEM file, for example:' +
        '\n    $env:NODE_EXTRA_CA_CERTS = "C:\\path\\to\\tacphone-localhost.pem"' +
        '\n  Do not disable certificate verification for the suite.'
    );
}

class RawWebSocket extends EventEmitter {
    constructor(socket, head) {
        super();
        this._socket = socket;
        this._buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
        this._closed = false;
        this._closeEmitted = false;

        socket.on('data', chunk => this._feed(chunk));
        socket.on('close', () => this._emitClose(1006, ''));
        socket.on('error', () => this._emitClose(1006, ''));

        if (this._buffer.length > 0) {
            queueMicrotask(() => this._feed(Buffer.alloc(0)));
        }
    }

    addEventListener(type, handler) {
        this.on(type, handler);
    }

    send(text) {
        if (this._closed) throw new Error('WebSocket is closed');

        const payload = Buffer.from(text, 'utf8');
        const mask = randomBytes(4);
        const length = payload.length;

        let header;
        if (length < 126) {
            header = Buffer.alloc(2);
            header[1] = 0x80 | length;
        } else if (length < 65536) {
            header = Buffer.alloc(4);
            header[1] = 0x80 | 126;
            header.writeUInt16BE(length, 2);
        } else {
            header = Buffer.alloc(10);
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(length), 2);
        }

        header[0] = 0x81; // FIN + text

        const masked = Buffer.alloc(length);
        for (let index = 0; index < length; index += 1) {
            masked[index] = payload[index] ^ mask[index % 4];
        }

        this._socket.write(Buffer.concat([header, mask, masked]));
    }

    close(code = 1000, reason = '') {
        if (this._closed) return;
        this._closed = true;

        const reasonBytes = Buffer.from(reason, 'utf8');
        const payload = Buffer.alloc(2 + reasonBytes.length);
        payload.writeUInt16BE(code, 0);
        reasonBytes.copy(payload, 2);

        const mask = randomBytes(4);
        const header = Buffer.from([0x88, 0x80 | payload.length]);
        const masked = Buffer.alloc(payload.length);
        for (let index = 0; index < payload.length; index += 1) {
            masked[index] = payload[index] ^ mask[index % 4];
        }

        try {
            this._socket.write(Buffer.concat([header, mask, masked]));
        } catch {
            // The peer may already be gone.
        }

        this._socket.end();
        this._emitClose(code, reason);
    }

    /** Simulates a killed browser: drop the TCP socket without a close frame. */
    abort() {
        if (this._closeEmitted) return;

        this._closed = true;
        try {
            this._socket.destroy();
        } catch {
            // Already gone.
        }
        this._emitClose(1006, 'aborted');
    }

    _emitClose(code, reason) {
        if (this._closeEmitted) return;

        this._closed = true;
        this._closeEmitted = true;
        this.emit('close', { code, reason });
    }

    _feed(chunk) {
        if (chunk.length > 0) this._buffer = Buffer.concat([this._buffer, chunk]);

        while (this._buffer.length >= 2) {
            const first = this._buffer[0];
            const second = this._buffer[1];
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;

            if (length === 126) {
                if (this._buffer.length < 4) return;
                length = this._buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (this._buffer.length < 10) return;
                length = Number(this._buffer.readBigUInt64BE(2));
                offset = 10;
            }

            if (masked) offset += 4;
            if (this._buffer.length < offset + length) return;

            const payload = this._buffer.subarray(offset, offset + length);
            this._buffer = this._buffer.subarray(offset + length);

            if (opcode === 0x8) {
                const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
                this._emitClose(code, reason);
                return;
            }

            if (opcode === 0x9) {
                const mask = randomBytes(4);
                const header = Buffer.from([0x8a, 0x80 | payload.length]);
                const maskedPayload = Buffer.alloc(payload.length);
                for (let index = 0; index < payload.length; index += 1) {
                    maskedPayload[index] = payload[index] ^ mask[index % 4];
                }
                this._socket.write(Buffer.concat([header, mask, maskedPayload]));
                continue;
            }

            if (opcode === 0x1 || opcode === 0x0 || opcode === 0x2) {
                this.emit('message', { data: payload.toString('utf8') });
            }
        }
    }
}

/** Request/reply client for one WebSocket connection. */
export class WsClient {
    constructor(url = DEFAULT_URL, options = {}) {
        this.url = url;
        this.app = options.app || MAIN_APP;
        this.name = options.name || 'main';
        this.origin = options.origin || originFor(url);
        this.connectTimeout = options.connectTimeout ?? 8000;
        this.requestTimeout = options.requestTimeout ?? 8000;
        this.pushTimeout = options.pushTimeout ?? 8000;
        this.debug = Boolean(options.debug);
        /** Public relay share key; when set, attach before treating the socket as open. */
        this.shareKey = options.shareKey || null;

        this._socket = null;
        this._open = false;
        this._openPromise = null;
        this._nextRequestId = 0;
        this._pending = new Map();
        this._pushes = [];
        this._waiters = new Set();
        this._attachPending = null;
        /** Peer id reported by the relay on attach. */
        this.remotePeerId = null;
    }

    get isOpen() {
        return this._open;
    }

    /** Number of queued pushes not yet consumed by waitForPush(). */
    get pendingPushCount() {
        return this._pushes.length;
    }

    async open() {
        if (this._open) return this;

        if (this._openPromise) {
            await this._openPromise;
            return this;
        }

        this._openPromise = this._connect();

        try {
            await this._openPromise;
            return this;
        } finally {
            this._openPromise = null;
        }
    }

    _connect() {
        return new Promise((resolve, reject) => {
            const parsed = new URL(this.url);
            const secure = parsed.protocol === 'wss:';
            const requestImpl = secure ? https : http;
            const key = randomBytes(16).toString('base64');
            const expectedAccept = createHash('sha1')
                .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
                .digest('base64');

            let settled = false;
            let socket = null;

            const timer = setTimeout(() => {
                if (settled) return;

                settled = true;
                this._socket = null;
                socket?.destroy();

                reject(
                    new WsTimeoutError(
                        `Timed out after ${this.connectTimeout} ms connecting to ${this.url}.` +
                            '\n  Is Arma running with the TacPhone web host on port 8001?',
                    ),
                );
            }, this.connectTimeout);

            const request = requestImpl.request({
                host: parsed.hostname,
                port: parsed.port || (secure ? 443 : 80),
                path: `${parsed.pathname}${parsed.search}`,
                method: 'GET',
                headers: {
                    Connection: 'Upgrade',
                    Upgrade: 'websocket',
                    'Sec-WebSocket-Version': '13',
                    'Sec-WebSocket-Key': key,
                    Origin: this.origin,
                },
            });

            request.on('upgrade', (response, upgradedSocket, head) => {
                if (settled) {
                    upgradedSocket.destroy();
                    return;
                }

                const accept = response.headers['sec-websocket-accept'];
                if (accept !== expectedAccept) {
                    settled = true;
                    clearTimeout(timer);
                    upgradedSocket.destroy();
                    reject(new WsError(`WebSocket handshake failed: unexpected Sec-WebSocket-Accept ${accept}`));
                    return;
                }

                socket = new RawWebSocket(upgradedSocket, head);
                this._socket = socket;

                socket.on('message', event => {
                    this._handleData(event.data);
                });
                socket.on('close', event => {
                    const description =
                        `WebSocket to ${this.url} closed (code ${event.code}` +
                        `${event.reason ? `, reason ${JSON.stringify(event.reason)}` : ''}).`;

                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        this._attachPending = null;
                        this._socket = null;
                        this._open = false;
                        reject(
                            new WsError(
                                `${description}\n` +
                                    '  The TacPhone web host rejected the handshake before it opened. ' +
                                    `This client sent Origin: ${this.origin}.` +
                                    certificateHint(description),
                            ),
                        );
                        return;
                    }

                    if (this._socket !== socket) return;

                    this._open = false;
                    this._socket = null;
                    this._rejectAll(new WsError(description));
                });

                if (!this.shareKey) {
                    settled = true;
                    clearTimeout(timer);
                    this._open = true;
                    resolve();
                    return;
                }

                // Public relay: attach with the share key before treating the
                // client as open. Control frames arrive in _handleText.
                this._attachPending = {
                    resolve: () => {
                        this._attachPending = null;
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        this._open = true;
                        resolve();
                    },
                    reject: error => {
                        this._attachPending = null;
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        this._socket = null;
                        this._open = false;
                        reject(error);
                    },
                };

                try {
                    socket.send(JSON.stringify({
                        t: 'attach',
                        proto: 1,
                        role: 'client',
                        share: this.shareKey,
                    }));
                } catch (error) {
                    this._attachPending.reject(
                        new WsError(`Could not send the relay attach frame: ${error.message}`, { cause: error }),
                    );
                }
            });

            request.on('response', response => {
                if (settled) return;

                settled = true;
                clearTimeout(timer);
                this._socket = null;
                this._open = false;
                response.resume();

                reject(
                    new WsError(
                        `WebSocket handshake to ${this.url} was rejected with HTTP ${response.statusCode}.` +
                            (response.statusCode === 403
                                ? `\n  The host rejected Origin ${this.origin}.`
                                : '') +
                            certificateHint(''),
                    ),
                );
            });

            request.on('error', error => {
                if (settled) return;

                settled = true;
                clearTimeout(timer);
                this._socket = null;
                this._open = false;

                reject(
                    new WsError(
                        `Could not connect to ${this.url}: ${error.message}` +
                            certificateHint(error.message),
                        { cause: error },
                    ),
                );
            });

            request.end();
        });
    }

    _handleData(raw) {
        const decoded = decodeMessageData(raw);

        if (typeof decoded !== 'string') {
            void decoded
                .then(text => this._handleText(text))
                .catch(error => {
                    if (this.debug) {
                        console.warn(`[${this.name}] could not read binary frame:`, error);
                    }
                });
            return;
        }

        this._handleText(decoded);
    }

    _handleText(text) {
        let frame;

        try {
            frame = JSON.parse(text);
        } catch {
            if (this.debug) console.warn(`[${this.name}] ignoring invalid JSON:`, text);
            return;
        }

        if (!frame || typeof frame !== 'object') return;

        if (typeof frame.t === 'string') {
            switch (frame.t) {
                case 'attach-ok':
                    if (typeof frame.peerId === 'string')
                        this.remotePeerId = frame.peerId;
                    this._attachPending?.resolve();
                    return;

                case 'rejected':
                case 'host-offline':
                    this._attachPending?.reject(
                        new WsError(
                            `Relay attach failed: ${frame.t}` +
                                `${frame.reason ? ` (${frame.reason})` : ''}`,
                        ),
                    );
                    return;

                case 'ping':
                    try {
                        this._socket?.send(JSON.stringify({ t: 'pong' }));
                    } catch {
                        // The socket may be closing.
                    }
                    return;

                default:
                    return;
            }
        }

        if (frame.k === 'command') {
            const data = frame.d;

            if (this.debug) {
                console.log(`[${this.name}] push`, data?.c, data);
            }

            this._pushes.push({ command: data?.c, receivedAt: Date.now(), data });

            if (this._pushes.length > 2000) {
                this._pushes.splice(0, this._pushes.length - 2000);
            }

            this._flushWaiters();
            return;
        }

        if (typeof frame.k !== 'string') return;

        const pending = this._pending.get(frame.k);
        if (!pending) {
            if (this.debug) {
                console.warn(`[${this.name}] reply for unknown key`, frame.k, frame.d);
            }
            return;
        }

        this._pending.delete(frame.k);
        clearTimeout(pending.timer);

        if (this.debug) {
            console.log(`[${this.name}] reply`, pending.command, frame.d);
        }

        pending.resolve(frame.d);
    }

    _matches(entry, command, predicate) {
        if (command && entry.command !== command) return false;
        return predicate ? Boolean(predicate(entry.data, entry)) : true;
    }

    _flushWaiters() {
        for (const waiter of [...this._waiters]) {
            let matchedIndex = -1;
            let predicateError;

            for (let index = 0; index < this._pushes.length; index += 1) {
                try {
                    if (this._matches(this._pushes[index], waiter.command, waiter.predicate)) {
                        matchedIndex = index;
                        break;
                    }
                } catch (error) {
                    predicateError = error;
                    break;
                }
            }

            if (predicateError) {
                clearTimeout(waiter.timer);
                this._waiters.delete(waiter);
                waiter.reject(predicateError);
                continue;
            }

            if (matchedIndex < 0) continue;

            const [entry] = this._pushes.splice(matchedIndex, 1);
            clearTimeout(waiter.timer);
            this._waiters.delete(waiter);
            waiter.resolve(entry.data);
        }
    }

    /** Waits for one game push. */
    waitForPush(command, predicate, timeout) {
        if (typeof command === 'function') {
            timeout = predicate;
            predicate = command;
            command = null;
        }

        if (typeof predicate === 'number') {
            timeout = predicate;
            predicate = undefined;
        }

        const waitTimeout = timeout ?? this.pushTimeout;
        const expected = command || 'any command';

        // Check already queued pushes first. A predicate that throws rejects the
        // wait instead of being swallowed.
        for (let index = 0; index < this._pushes.length; index += 1) {
            let matched = false;

            try {
                matched = this._matches(this._pushes[index], command, predicate);
            } catch (error) {
                return Promise.reject(error);
            }

            if (matched) {
                const [entry] = this._pushes.splice(index, 1);
                return Promise.resolve(entry.data);
            }
        }

        return new Promise((resolve, reject) => {
            const waiter = { command: command || null, predicate, resolve, reject, timer: null };

            waiter.timer = setTimeout(() => {
                this._waiters.delete(waiter);
                reject(
                    new WsTimeoutError(
                        `Timed out after ${waitTimeout} ms waiting for push "${expected}".`,
                        { command, timeout: waitTimeout },
                    ),
                );
            }, waitTimeout);

            this._waiters.add(waiter);
        });
    }

    /** Alias for {@link waitForPush}; both names are used in scenario files. */
    waitForCommand(command, predicate, timeout) {
        return this.waitForPush(command, predicate, timeout);
    }

    /** Sends one `{ k, d }` request and resolves with the matching reply. */
    async request(command, payload = {}, options = {}) {
        if (!this._open) {
            await this.open();
        }

        if (!this._socket) {
            throw new WsError(`Cannot send "${command}": the WebSocket is not connected.`);
        }

        const key = options.key || `${this.name}-${++this._nextRequestId}-${randomUUID().slice(0, 8)}`;
        const timeout = options.timeout ?? this.requestTimeout;
        const app = options.app || this.app;

        const frame = {
            k: key,
            d: {
                a: app,
                c: command,
                ...payload,
            },
        };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(key);
                reject(
                    new WsTimeoutError(
                        `Timed out after ${timeout} ms waiting for the reply to "${command}" (key ${key}).`,
                        { command, key, timeout },
                    ),
                );
            }, timeout);

            this._pending.set(key, { command, resolve, reject, timer });

            try {
                this._socket.send(JSON.stringify(frame));

                if (this.debug) {
                    console.log(`[${this.name}] request`, command, frame.d);
                }
            } catch (error) {
                this._pending.delete(key);
                clearTimeout(timer);
                reject(new WsError(`Could not send "${command}": ${error.message}`, { cause: error }));
            }
        });
    }

    /** Removes queued pushes, either all of them or only the listed commands. */
    clearPushes(commands) {
        if (!commands) {
            this._pushes = [];
            return;
        }

        const set = new Set(Array.isArray(commands) ? commands : [commands]);
        this._pushes = this._pushes.filter(entry => !set.has(entry.command));
    }

    _rejectAll(error) {
        for (const pending of this._pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }

        this._pending.clear();

        for (const waiter of this._waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }

        this._waiters.clear();
    }

    /** Closes the connection. Safe to call more than once. */
    async close() {
        const socket = this._socket;

        this._open = false;
        this._socket = null;
        this._attachPending?.reject(new WsError(`WebSocket client "${this.name}" was closed by the test.`));
        this._attachPending = null;
        this._rejectAll(new WsError(`WebSocket client "${this.name}" was closed by the test.`));

        if (!socket) return;

        await new Promise(resolve => {
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                resolve();
            };

            const timer = setTimeout(finish, 1000);
            socket.addEventListener('close', finish);

            try {
                socket.close(1000, 'test client closing');
            } catch {
                finish();
            }
        });
    }

    /** Drops the socket without a close handshake, like a killed browser. */
    abort() {
        const socket = this._socket;

        this._open = false;
        this._socket = null;
        this._attachPending?.reject(new WsError(`WebSocket client "${this.name}" was aborted by the test.`));
        this._attachPending = null;
        this._rejectAll(new WsError(`WebSocket client "${this.name}" was aborted by the test.`));

        try {
            socket?.abort();
        } catch {
            // The socket may already be gone.
        }
    }

    /** Closes and reopens the same logical client, optionally clearing old pushes. */
    async reconnect(options = {}) {
        const { clearPushes = true } = options;

        await this.close();

        if (clearPushes) {
            this.clearPushes();
        }

        await this.open();
        return this;
    }
}

export async function openClient(url = DEFAULT_URL, options = {}) {
    const client = new WsClient(url, options);
    await client.open();
    return client;
}

/**
 * Requests a full chat state and collects the chunked `ChatState.Room` pushes
 * until `ChatState.Done` arrives (Messenger game-side protocol).
 *
 * @returns {Promise<{done: object, rooms: Map<string, {
 *   room: object, messages: object[], chunks: number, receivedChunks: number
 * }>}>}
 */
export async function collectChatState(client, options = {}) {
    const { clearBefore = true, timeout = client.pushTimeout } = options;

    if (clearBefore) {
        client.clearPushes(['ChatState.Room', 'ChatState.Done']);
    }

    const deadline = Date.now() + timeout;
    const rooms = new Map();

    for (;;) {
        const remaining = Math.max(1, deadline - Date.now());
        const push = await client.waitForPush(
            null,
            data => data?.c === 'ChatState.Room' || data?.c === 'ChatState.Done',
            remaining,
        );

        if (push.c === 'ChatState.Done') {
            return { done: push, rooms };
        }

        const roomId = push.room?.id;

        if (!roomId) {
            continue;
        }

        const entry = rooms.get(roomId) || {
            room: push.room,
            messages: [],
            chunks: push.chunks,
            receivedChunks: 0,
        };

        entry.room = push.room;
        entry.chunks = push.chunks;
        entry.receivedChunks += 1;
        entry.messages.push(...(push.messages || []));
        rooms.set(roomId, entry);
    }
}
