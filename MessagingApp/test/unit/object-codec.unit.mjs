/**
 * Unit tests for the Messenger chat-object codec (`MessagingApp/src/objectCodec.ts`).
 *
 * Game-free: `window.TacPhone.utils` is stubbed with `node:zlib` for the
 * duration of `run()` and deleted again in `finally`, so importing this module
 * never depends on a browser or on the game.
 *
 * The codec decides the *stored* shape of a chat object: small payloads stay
 * plain, large ones become a `{ kind, version, preview, __tacphoneObject: { d } }`
 * envelope, decoding restores `data`/`action`, and a message whose stored
 * objects exceed `MAX_ENCODED_MESSAGE_CHARS` must be rejected.
 */

import zlib from 'node:zlib';

import {
    deepEqual,
    equal,
    isNumber,
    isString,
    ok,
} from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    MAX_ENCODED_MESSAGE_CHARS,
    MIN_COMPRESS_JSON_CHARS,
    OBJECT_ENVELOPE_KEY,
    checkEncodedObjects,
    decodeChatObjectsFromStorage,
    encodeChatObjectsForStorage,
    measureEncodedObjects,
    resetObjectDecodeCache,
} from '../../src/objectCodec.ts';

export const name = 'object-codec';
export const description = 'Chat object codec: envelope, decode, cache, size limit';

/** ~2 KB of JSON that gzip compresses well, above MIN_COMPRESS_JSON_CHARS. */
function largeObject() {
    const data = {
        v: 1,
        origin: [1024, 2048],
        waypoints: [0, 0, 420, 260],
        legs: Array.from({ length: 24 }, (_, index) => ({
            mode: 'ground',
            kind: 'road',
            points: [index * 10, 0, index * 10 + 10, 5],
            eta: 12 + index,
        })),
    };

    return {
        kind: 'map.gps_route',
        version: 1,
        data,
        preview: { title: 'Route', subtitle: '2.4 km', color: '#22d3ee' },
        action: {
            service: 'map',
            panelId: 'ACE_TacPhone_Map_GPS',
            method: 'openSharedRoute',
            args: [data],
            policy: 'ask',
        },
    };
}

/** Deterministic pseudo-random base64-ish text; no `Math.random()`. */
function highEntropyText(length) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let state = 0x2f6e2b1;
    let text = '';

    for (let index = 0; index < length; index += 1) {
        state = (state * 1664525 + 1013904223) >>> 0;
        text += alphabet[state % alphabet.length];
    }

    return text;
}

export async function run() {
    // -- window stub -------------------------------------------------------
    const hadWindow = 'window' in globalThis;
    const previousWindow = globalThis.window;
    const previousWarn = console.warn;

    /** Counters observed by the tests; reset by the helpers below. */
    const counters = { decompress: 0 };
    let warnCount = 0;

    const defaultUtils = {
        compressAndToBase64: async (text) =>
            zlib.gzipSync(Buffer.from(text, 'utf8')).toString('base64'),
        decompressFromBase64: async (base64) => {
            counters.decompress += 1;
            return zlib.gunzipSync(Buffer.from(base64, 'base64')).toString('utf8');
        },
    };

    const installUtils = (utils = defaultUtils) => {
        globalThis.window = { TacPhone: { utils } };
    };

    try {
        resetObjectDecodeCache();
        warnCount = 0;
        console.warn = () => {
            warnCount += 1;
        };

        // 1. Small payloads stay plain, and keep their identity.
        installUtils();
        const small = [{
            kind: 'map.marker',
            version: 1,
            data: { name: 'Test', position: [100, 200] },
            preview: { title: 'Test' },
        }];
        const smallPayloadChars = JSON.stringify({ data: small[0].data, action: small[0].action }).length;
        ok(
            smallPayloadChars < MIN_COMPRESS_JSON_CHARS,
            `the case needs a payload below ${MIN_COMPRESS_JSON_CHARS} chars, got ${smallPayloadChars}`,
        );

        const encodedSmall = await encodeChatObjectsForStorage(small);
        equal(encodedSmall.length, 1);
        ok(
            encodedSmall[0] === small[0],
            'a small payload must be returned as the same object reference',
        );
        ok(!(OBJECT_ENVELOPE_KEY in encodedSmall[0]), 'a small payload must not get an envelope');

        // 2. A large payload becomes a gzip envelope that keeps the preview.
        const large = [largeObject()];
        const largePayloadChars = JSON.stringify({
            data: large[0].data,
            action: large[0].action,
        }).length;
        ok(largePayloadChars >= MIN_COMPRESS_JSON_CHARS, 'the case needs a payload above the threshold');

        const encodedLarge = await encodeChatObjectsForStorage(large);
        const envelope = encodedLarge[0][OBJECT_ENVELOPE_KEY];
        ok(envelope, 'a large payload must be stored as an envelope');
        equal(envelope.v, 1, 'envelope version');
        equal(envelope.codec, 'gzip', 'envelope codec');
        equal(envelope.enc, 'base64', 'envelope encoding');
        isString(envelope.d, 'envelope payload must be a string');
        ok(envelope.d.length > 0, 'envelope payload must not be empty');
        equal(encodedLarge[0].kind, large[0].kind, 'kind is kept plain');
        equal(encodedLarge[0].version, large[0].version, 'version is kept plain');
        deepEqual(encodedLarge[0].preview, large[0].preview, 'preview is kept plain');
        equal(encodedLarge[0].data, undefined, 'the stored shape must not keep data');
        equal(encodedLarge[0].action, undefined, 'the stored shape must not keep the action');

        // 3. Decoding restores data and action.
        const decodedLarge = await decodeChatObjectsFromStorage(encodedLarge);
        equal(decodedLarge.length, 1);
        deepEqual(decodedLarge[0].data, large[0].data, 'decode restores data');
        deepEqual(decodedLarge[0].action, large[0].action, 'decode restores the action');
        ok(!(OBJECT_ENVELOPE_KEY in decodedLarge[0]), 'a decoded object must not expose the envelope');
        deepEqual(decodedLarge[0].preview, large[0].preview, 'decode keeps the preview');

        // 4. A payload that does not get smaller stays plain.
        installUtils({
            compressAndToBase64: async (text) => `${text}${text}`,
            decompressFromBase64: defaultUtils.decompressFromBase64,
        });
        const notSmaller = await encodeChatObjectsForStorage(large);
        ok(
            notSmaller[0] === large[0],
            'a payload whose encoded form is not shorter must stay plain',
        );

        // Genuine gzip on high-entropy text: either it still pays off (then the
        // envelope must be shorter, never larger) or the object stays plain.
        installUtils();
        const entropyInput = [{
            kind: 'map.marker',
            version: 1,
            data: { blob: highEntropyText(600) },
        }];
        const entropyPayloadChars = JSON.stringify({
            data: entropyInput[0].data,
            action: entropyInput[0].action,
        }).length;
        const encodedEntropy = await encodeChatObjectsForStorage(entropyInput);
        if (OBJECT_ENVELOPE_KEY in encodedEntropy[0]) {
            ok(
                encodedEntropy[0][OBJECT_ENVELOPE_KEY].d.length < entropyPayloadChars,
                'an envelope must always be smaller than the payload it replaces',
            );
        } else {
            ok(encodedEntropy[0] === entropyInput[0], 'an uncompressible payload stays plain');
        }

        // 5. Oversized object sets are rejected by the size helper.
        const huge = [{
            kind: 'map.gps_route',
            version: 1,
            data: { blob: 'a'.repeat(MAX_ENCODED_MESSAGE_CHARS + 1024) },
        }];
        const hugeSize = checkEncodedObjects(huge);
        equal(hugeSize.ok, false, 'a payload above the limit must be rejected');
        ok(hugeSize.chars > hugeSize.limit, 'chars must exceed the reported limit');
        equal(hugeSize.limit, MAX_ENCODED_MESSAGE_CHARS, 'the reported limit is the constant');
        isNumber(hugeSize.chars, 'chars is a number');
        equal(hugeSize.chars, measureEncodedObjects(huge), 'chars is the measured JSON size');

        const normalRoute = [{
            kind: 'map.gps_route',
            version: 1,
            data: large[0].data,
            preview: large[0].preview,
        }];
        const normalSize = checkEncodedObjects(normalRoute);
        equal(normalSize.ok, true, 'a normal route object must pass');

        // 6. A corrupted payload keeps its preview and warns once.
        warnCount = 0;
        const corrupted = [{
            kind: 'map.gps_route',
            version: 1,
            preview: { title: 'Route' },
            [OBJECT_ENVELOPE_KEY]: { v: 1, codec: 'gzip', enc: 'base64', d: 'bm90LWd6aXA=' },
        }];
        const decodedCorrupted = await decodeChatObjectsFromStorage(corrupted);
        equal(decodedCorrupted.length, 1, 'a corrupted payload must still resolve');
        equal(decodedCorrupted[0].kind, 'map.gps_route', 'kind survives a corrupted payload');
        equal(decodedCorrupted[0].version, 1, 'version survives a corrupted payload');
        deepEqual(decodedCorrupted[0].preview, { title: 'Route' }, 'preview survives a corrupted payload');
        equal(decodedCorrupted[0].data, undefined, 'no data is restored from a corrupted payload');
        equal(decodedCorrupted[0].action, undefined, 'no action is restored from a corrupted payload');
        equal(warnCount, 1, 'a corrupted payload warns exactly once');

        // 7. Forwarding an encoded object is idempotent.
        const forwarded = await encodeChatObjectsForStorage(encodedLarge);
        ok(forwarded[0] === encodedLarge[0], 'an encoded object must be forwarded unchanged');
        equal(
            forwarded[0][OBJECT_ENVELOPE_KEY].d,
            encodedLarge[0][OBJECT_ENVELOPE_KEY].d,
            'forwarding must not re-encode',
        );
        const forwardedDecoded = await decodeChatObjectsFromStorage(forwarded);
        deepEqual(forwardedDecoded[0].data, large[0].data, 'a forwarded object still decodes');

        // 8. Decoding the same payload twice decompresses once.
        resetObjectDecodeCache();
        counters.decompress = 0;
        await decodeChatObjectsFromStorage(encodedLarge);
        await decodeChatObjectsFromStorage(encodedLarge);
        equal(counters.decompress, 1, 'the second decode must hit the cache');

        // 9. Resetting the cache forces a new decompression.
        resetObjectDecodeCache();
        counters.decompress = 0;
        await decodeChatObjectsFromStorage(encodedLarge);
        equal(counters.decompress, 1, 'a cache reset must force a decode');

        // 10. The cache keeps the 100 newest payloads.
        resetObjectDecodeCache();
        counters.decompress = 0;
        const set = [];
        for (let index = 0; index < 101; index += 1) {
            const [stored] = await encodeChatObjectsForStorage([{
                kind: 'test.payload',
                version: 1,
                data: { index, blob: 'x'.repeat(600) },
            }]);
            ok(OBJECT_ENVELOPE_KEY in stored, `payload ${index} must become an envelope`);
            set.push(stored);
        }

        for (const stored of set) {
            await decodeChatObjectsFromStorage([stored]);
        }
        equal(counters.decompress, 101, 'every distinct payload is decoded once');

        await decodeChatObjectsFromStorage([set[0]]);
        equal(
            counters.decompress,
            102,
            'after 101 payloads the oldest entry is evicted, so it decodes again',
        );

        // 11. Without `window.TacPhone.utils` nothing is compressed or decoded.
        installUtils();
        const storedWithUtils = await encodeChatObjectsForStorage(large);
        ok(OBJECT_ENVELOPE_KEY in storedWithUtils[0], 'the setup object must be an envelope');

        globalThis.window = { TacPhone: {} };
        const plainWithoutUtils = await encodeChatObjectsForStorage(large);
        ok(plainWithoutUtils[0] === large[0], 'without utils a large object stays plain');

        resetObjectDecodeCache();
        const decodedWithoutUtils = await decodeChatObjectsFromStorage(storedWithUtils);
        equal(decodedWithoutUtils[0].data, undefined, 'without utils an envelope yields no data');
        equal(decodedWithoutUtils[0].kind, storedWithUtils[0].kind, 'without utils the preview is kept');
        deepEqual(decodedWithoutUtils[0].preview, large[0].preview, 'without utils the preview is kept');

        // 12. Degenerate input.
        deepEqual(await encodeChatObjectsForStorage([]), [], 'encoding nothing yields nothing');
        deepEqual(await encodeChatObjectsForStorage(null), [], 'encoding null yields nothing');
        deepEqual(await encodeChatObjectsForStorage(undefined), [], 'encoding undefined yields nothing');
        deepEqual(await decodeChatObjectsFromStorage(undefined), [], 'decoding undefined yields nothing');
        deepEqual(await decodeChatObjectsFromStorage('nope'), [], 'decoding a string yields nothing');
    } finally {
        console.warn = previousWarn;
        resetObjectDecodeCache();

        if (hadWindow) {
            globalThis.window = previousWindow;
        } else {
            delete globalThis.window;
        }
    }
}
