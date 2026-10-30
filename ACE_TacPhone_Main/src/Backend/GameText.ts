/**
 * The engine moves page scripts through base64 and decodes them with `atob`,
 * which is fast but yields one UTF-16 code unit per byte. Any non-ASCII text the
 * game sends therefore arrives as a UTF-8 byte stream stored in a JS string:
 * "Кa32" arrives as "Ð\u009aa32".
 *
 * This reverses that decode only where text can occur:
 * - a single scan skips strings without high bytes (pure ASCII, including the
 *   base64 texture/blob payloads, is returned unchanged and not copied);
 * - only contiguous runs of high bytes are decoded, so a large mostly-ASCII
 *   payload such as a 30 MB terrain SVG costs one scan plus a copy of its text,
 *   not a per-character conversion;
 * - a run that is not valid UTF-8 is kept as-is, so text that was already
 *   decoded correctly is not damaged.
 *
 * Never pass arbitrary binary through this: `LoadGameFileTexture` returns raw
 * bytes, not text.
 */

const NON_ASCII_BYTE = /[\u0080-\u00ff]/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeGameText(text: string): string {
    if (!NON_ASCII_BYTE.test(text)) {
        return text;
    }

    let result = "";
    let copied = 0;
    let index = 0;

    while (index < text.length) {
        const code = text.charCodeAt(index);

        // ASCII, or a code point that was not produced by the byte path.
        if (code < 0x80 || code > 0xff) {
            index++;
            continue;
        }

        result += text.slice(copied, index);

        const start = index;
        while (index < text.length) {
            const next = text.charCodeAt(index);
            if (next < 0x80 || next > 0xff) break;
            index++;
        }

        const bytes = new Uint8Array(index - start);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = text.charCodeAt(start + i);
        }

        try {
            result += utf8Decoder.decode(bytes);
        } catch {
            // Not UTF-8, e.g. an ANSI character that was decoded correctly already.
            result += text.slice(start, index);
        }

        copied = index;
    }

    return copied === 0 ? text : result + text.slice(copied);
}

/** Applies `decodeGameText` to every string in a freshly parsed message. */
export function decodeGameTextDeep<T>(value: T): T {
    if (typeof value === "string") {
        return decodeGameText(value) as T;
    }

    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            value[i] = decodeGameTextDeep(value[i]);
        }

        return value;
    }

    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record)) {
            record[key] = decodeGameTextDeep(record[key]);
        }
    }

    return value;
}
