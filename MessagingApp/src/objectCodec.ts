/**
 * Storage form of chat objects.
 *
 * The game script keeps every message in memory, so a large object payload
 * (a route, a document, a photo) must not be stored as raw JSON. Messenger
 * encodes `{ data, action }` once on the way to the game and decodes it again
 * on the way back:
 *
 * ```
 * {
 *     kind, version, preview,            // plain, so cards render without data
 *     __tacphoneObject: {
 *         v: 1, codec: 'gzip', enc: 'base64', d: '<gzip+base64 of {data, action}>',
 *     },
 * }
 * ```
 *
 * Objects that are already encoded are left alone, so forwarding a message
 * never compresses it twice. Small payloads and payloads that do not shrink
 * stay plain. `ChatStore` always stores and emits decoded `ChatObject`s; a
 * renderer never sees an envelope.
 */

import type { ChatObject, ChatObjectAction, ChatObjectPreview } from './api';

/** Property that marks a stored envelope. */
export const OBJECT_ENVELOPE_KEY = '__tacphoneObject';

/** Envelope schema version. */
export const OBJECT_ENVELOPE_VERSION = 1;

/** Below this JSON length a payload stays plain; gzip would not pay off. */
export const MIN_COMPRESS_JSON_CHARS = 512;

/**
 * Upper bound for the encoded objects of one message, measured in JSON
 * characters. The game stores messages in memory and the bridge passes text,
 * so an oversized payload is rejected instead of silently truncated.
 */
export const MAX_ENCODED_MESSAGE_CHARS = 96 * 1024;

/** Result of {@link checkEncodedObjects}. */
export interface EncodedObjectSize {
    /** True when the objects fit into {@link MAX_ENCODED_MESSAGE_CHARS}. */
    ok: boolean;
    /** Measured JSON size of the stored objects, in characters. */
    chars: number;
    /** The limit `chars` was compared against. */
    limit: number;
}

/** Decoded payloads kept in memory before the oldest one is dropped. */
const DECODE_CACHE_LIMIT = 100;

interface StoredEnvelope {
    v: number;
    codec: string;
    enc: string;
    d: string;
}

interface DecodedPayload {
    data?: unknown;
    action?: ChatObjectAction;
}

/** Bounded cache keyed by the base64 payload, so sync chunks decode once. */
const decodeCache = new Map<string, DecodedPayload>();

function getUtils(): Window['TacPhone']['utils'] | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }

    return window.TacPhone?.utils;
}

function readEnvelope(object: Record<string, unknown>): StoredEnvelope | undefined {
    const candidate = object[OBJECT_ENVELOPE_KEY];
    if (!candidate || typeof candidate !== 'object') {
        return undefined;
    }

    const envelope = candidate as Partial<StoredEnvelope>;
    if (
        envelope.v !== OBJECT_ENVELOPE_VERSION
        || envelope.codec !== 'gzip'
        || envelope.enc !== 'base64'
        || typeof envelope.d !== 'string'
        || envelope.d === ''
    ) {
        return undefined;
    }

    return {
        v: envelope.v,
        codec: envelope.codec,
        enc: envelope.enc,
        d: envelope.d,
    };
}

/** True when the value already carries a stored envelope. */
export function isStoredChatObject(value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && readEnvelope(value as Record<string, unknown>));
}

/** Keeps only the plain fields of a stored envelope. */
function readPreviewFields(object: Record<string, unknown>): ChatObject {
    const stored = {
        kind: typeof object.kind === 'string' ? object.kind : '',
        version: typeof object.version === 'number' ? object.version : 0,
    } as unknown as ChatObject;

    if (object.preview && typeof object.preview === 'object') {
        stored.preview = object.preview as ChatObjectPreview;
    }

    return stored;
}

function cacheDecoded(key: string, payload: DecodedPayload): void {
    if (decodeCache.size >= DECODE_CACHE_LIMIT) {
        const oldest = decodeCache.keys().next();
        if (!oldest.done) {
            decodeCache.delete(oldest.value);
        }
    }

    decodeCache.set(key, payload);
}

/** Drops every cached payload; called from `ChatStore.reset()`. */
export function resetObjectDecodeCache(): void {
    decodeCache.clear();
}

/**
 * JSON size of the objects as they would be stored. Objects that are already
 * encoded count with their base64 envelope, which is the form the game keeps.
 */
export function measureEncodedObjects(objects: ChatObject[]): number {
    let total = 0;

    for (const object of objects) {
        try {
            total += JSON.stringify(object)?.length ?? 0;
        } catch (error) {
            console.warn('Messaging: could not measure a chat object:', error);
        }
    }

    return total;
}

/**
 * Checks the stored form of `objects` against {@link MAX_ENCODED_MESSAGE_CHARS}.
 *
 * Call this after {@link encodeChatObjectsForStorage}: an envelope counts with
 * its base64 payload, which is the form the game keeps.
 */
export function checkEncodedObjects(objects: ChatObject[]): EncodedObjectSize {
    const chars = measureEncodedObjects(objects);

    return {
        ok: chars <= MAX_ENCODED_MESSAGE_CHARS,
        chars,
        limit: MAX_ENCODED_MESSAGE_CHARS,
    };
}

async function encodeObject(object: ChatObject): Promise<ChatObject> {
    if (!object || typeof object !== 'object') {
        return object;
    }

    // Already encoded (forwarded message or a second pass): leave it alone.
    if (isStoredChatObject(object)) {
        return object;
    }

    const payloadJson = JSON.stringify({
        data: object.data,
        action: object.action,
    });

    if (payloadJson.length < MIN_COMPRESS_JSON_CHARS) {
        return object;
    }

    const utils = getUtils();
    if (!utils || typeof utils.compressAndToBase64 !== 'function') {
        return object;
    }

    try {
        const encoded = await utils.compressAndToBase64(payloadJson);

        // A gzip header plus base64 can be larger than tiny JSON; keep the
        // plain object in that case so the game stores the smaller form.
        if (typeof encoded !== 'string' || encoded === '' || encoded.length >= payloadJson.length) {
            return object;
        }

        const stored = {
            kind: object.kind,
            version: object.version,
            ...(object.preview === undefined ? {} : { preview: object.preview }),
            [OBJECT_ENVELOPE_KEY]: {
                v: OBJECT_ENVELOPE_VERSION,
                codec: 'gzip',
                enc: 'base64',
                d: encoded,
            } satisfies StoredEnvelope,
        };

        return stored as unknown as ChatObject;
    } catch (error) {
        console.warn('Messaging: could not compress a chat object:', error);

        return object;
    }
}

/**
 * Encodes a copy of the objects for the `SendMessage` request. The caller keeps
 * its own raw objects, so the optimistic message shows real data immediately.
 */
export async function encodeChatObjectsForStorage(objects: ChatObject[]): Promise<ChatObject[]> {
    if (!Array.isArray(objects) || objects.length === 0) {
        return [];
    }

    return Promise.all(objects.map(object => encodeObject(object)));
}

async function decodeObject(value: unknown): Promise<ChatObject> {
    if (!value || typeof value !== 'object') {
        return value as ChatObject;
    }

    const object = value as Record<string, unknown>;
    const envelope = readEnvelope(object);

    if (!envelope) {
        // Plain payload (small, uncompressible or older): use it as it is.
        return value as ChatObject;
    }

    const base = readPreviewFields(object);
    const cached = decodeCache.get(envelope.d);
    if (cached) {
        if (cached.data !== undefined) {
            base.data = cached.data;
        }
        if (cached.action !== undefined) {
            base.action = cached.action;
        }

        return base;
    }

    const utils = getUtils();
    if (!utils || typeof utils.decompressFromBase64 !== 'function') {
        return base;
    }

    try {
        const json = await utils.decompressFromBase64(envelope.d);
        const parsed = JSON.parse(json) as DecodedPayload;

        cacheDecoded(envelope.d, parsed);

        if (parsed.data !== undefined) {
            base.data = parsed.data;
        }
        if (parsed.action !== undefined) {
            base.action = parsed.action;
        }

        return base;
    } catch (error) {
        // A payload that cannot be decoded still renders its stored preview.
        console.warn('Messaging: could not decode a stored chat object:', error);

        return base;
    }
}

/**
 * Decodes objects received from the game. Never rejects: a broken payload
 * falls back to `{ kind, version, preview }`.
 */
export async function decodeChatObjectsFromStorage(objects: unknown): Promise<ChatObject[]> {
    if (!Array.isArray(objects) || objects.length === 0) {
        return [];
    }

    return Promise.all(objects.map(value => decodeObject(value)));
}
