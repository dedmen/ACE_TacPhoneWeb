// Terrain request caching, SVG splitting, chunk encoding and progressive reply
// assembly.
//
// Kept apart from `Networking.ts` so the transports only own their request /
// response plumbing. Nothing here touches the socket, A3API or the DOM (except
// the `DOMParser` used to split the SVG, which is why only the in-game page runs
// that path).

import { compressAndToBase64, decompressFromBase64 } from "./Compression";
import type {
    TerrainData,
    TerrainLayer,
    TerrainLayerListener,
    TerrainLayerProgress,
} from "./Types";

/** Target maximum size of one terrain chunk's base64 payload. */
const MAX_TERRAIN_CHUNK_CHARS = 6 * 1024 * 1024;

/**
 * Default lifetime of a completed terrain result.
 *
 * The websocket transport passes `0`: a relay host can change without this
 * socket reconnecting, so a completed result must never be reused. Only an
 * in-flight request is shared, which absorbs React StrictMode's double mount.
 * The in-game transport uses `Infinity`: its page is recreated whenever the
 * game terrain changes.
 */
export const TERRAIN_CACHE_TTL_MS = 5000;

/**
 * A pending request older than this is considered stuck and is not reused.
 * A3API has no cancellation, so a hung game reply would otherwise poison every
 * later terrain request for the rest of the page session.
 */
const TERRAIN_PENDING_STALE_MS = 3000;

/**
 * How long the remote transport waits for the first terrain frame (the game has
 * to generate and split the whole SVG before it can compress the first layer).
 */
export const TERRAIN_INITIAL_TIMEOUT_MS = 120_000;

/**
 * Idle timeout between terrain frames. Every received chunk restarts it, so a
 * slow but progressing transfer (a multi-megabyte layer takes a long time to
 * gzip) is never cut off by a fixed total timeout.
 */
export const TERRAIN_CHUNK_IDLE_TIMEOUT_MS = 60_000;

interface TerrainCacheEntry {
    promise: Promise<TerrainData>;
    settled: boolean;
    startedAt: number;
    expiresAt: number;
    /** Progressive listeners attached while the request is in flight. */
    listeners: Set<TerrainLayerListener>;
}

/**
 * Coalesces identical terrain requests and caches the result.
 *
 * `request` receives a `notify` callback that forwards one decoded layer to
 * every listener currently attached to this config's entry, so a second caller
 * that attaches mid-transfer still sees the remaining layers.
 *
 * `completedTtlMs` is 0 when a completed result must never be reused (a game
 * host change cannot be detected), or `Infinity` when the host is recreated
 * together with the terrain. `keepOnlyLast` drops every other config's entry so
 * the cache holds at most one full terrain result.
 */
export class TerrainRequestCache {
    private readonly entries = new Map<string, TerrainCacheEntry>();
    private readonly completedTtlMs: number;
    private readonly keepOnlyLast: boolean;

    public constructor(
        completedTtlMs: number = TERRAIN_CACHE_TTL_MS,
        keepOnlyLast = false,
    ) {
        this.completedTtlMs = completedTtlMs;
        this.keepOnlyLast = keepOnlyLast;
    }

    public load(
        config: object,
        request: (notify: (progress: TerrainLayerProgress) => void) => Promise<TerrainData>,
        onLayer?: TerrainLayerListener,
    ): Promise<TerrainData> {
        const key = JSON.stringify(config);
        const now = Date.now();
        const existing = this.entries.get(key);
        const reusable = existing && (existing.settled
            ? now < existing.expiresAt
            : now - existing.startedAt < TERRAIN_PENDING_STALE_MS);
        if (reusable && existing) {
            console.log(
                `[TacPhone terrain] cache hit for the same config`
                + ` (${existing.settled ? 'complete' : 'in flight'})`,
            );

            if (onLayer) {
                existing.listeners.add(onLayer);
                const detach = (): void => {
                    existing.listeners.delete(onLayer);
                };
                existing.promise.then(detach, detach);
            }

            return existing.promise;
        }
        if (existing) {
            this.entries.delete(key);
        }
        if (this.keepOnlyLast) {
            this.entries.clear();
        }

        const listeners = new Set<TerrainLayerListener>();
        if (onLayer) {
            listeners.add(onLayer);
        }

        const notify = (progress: TerrainLayerProgress): void => {
            for (const listener of [...listeners]) {
                try {
                    listener(progress);
                } catch (error) {
                    // A failing app listener must not abort the terrain transfer.
                    console.error("TacPhone terrain layer listener failed:", error);
                }
            }
        };

        // Start in a microtask so a synchronous throw in `request` becomes a
        // rejection and the entry can be cleaned up like any other failure.
        const promise = Promise.resolve().then(() => request(notify));
        const entry: TerrainCacheEntry = {
            promise,
            settled: false,
            startedAt: now,
            expiresAt: 0,
            listeners,
        };
        this.entries.set(key, entry);

        promise.then(
            () => {
                entry.settled = true;
                entry.expiresAt = this.completedTtlMs === Number.POSITIVE_INFINITY
                    ? Number.POSITIVE_INFINITY
                    : Date.now() + this.completedTtlMs;
                entry.listeners.clear();

                // Do not keep a full terrain result alive longer than its TTL.
                // The in-game transport (Infinity) intentionally keeps it.
                if (this.completedTtlMs === 0) {
                    if (this.entries.get(key) === entry) {
                        this.entries.delete(key);
                    }
                } else if (Number.isFinite(this.completedTtlMs)) {
                    setTimeout(() => {
                        if (this.entries.get(key) === entry) {
                            this.entries.delete(key);
                        }
                    }, this.completedTtlMs);
                }
            },
            () => {
                if (this.entries.get(key) === entry) {
                    this.entries.delete(key);
                }
            },
        );

        return promise;
    }

    /** Drops every cached/in-flight entry. Used when the game host can change. */
    public clear(): void {
        this.entries.clear();
    }
}

/**
 * Splits a whole terrain SVG into standalone per-layer SVG documents.
 *
 * Host-internal producer helper: the game response is the only place that has
 * the DOM, so the layer split happens here instead of in an app.
 */
export function splitTerrainSVG(svgText: string): TerrainData {
    const svgDoc = (new DOMParser()).parseFromString(svgText, "image/svg+xml");
    const rootSvg = svgDoc.documentElement;

    if (rootSvg.tagName.toLowerCase() !== "svg")
        throw new Error("The terrain response is not a valid SVG document.");

    // The terrain size lives on the root <svg>; the Map uses it for tiling/scaling.
    const widthAttribute = rootSvg.getAttribute("width");
    const heightAttribute = rootSvg.getAttribute("height");
    const width = Number(widthAttribute);
    const height = Number(heightAttribute);

    if (
        widthAttribute === null ||
        heightAttribute === null ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
    ) {
        throw new Error("The terrain SVG is missing a valid width or height.");
    }

    // <defs> is shared by every layer, so each standalone document gets its own copy.
    const originalDefs = rootSvg.querySelector("defs");
    if (!originalDefs)
        throw new Error("The terrain SVG is missing its <defs> section.");

    const layerElements = rootSvg.querySelectorAll("svg > g");
    if (layerElements.length === 0)
        throw new Error("The terrain SVG does not contain any layers.");

    const serializer = new XMLSerializer();

    // Serialize the shared shell (root attributes + <defs>) once. Only the layer
    // element differs between documents; cloning and re-serializing a
    // multi-megabyte <defs> for every layer was the expensive part here.
    const shell = rootSvg.cloneNode(false) as Element;
    shell.appendChild(originalDefs.cloneNode(true));
    const shellText = serializer.serializeToString(shell);
    const closingTag = "</svg>";
    const prefix = shellText.endsWith(closingTag)
        ? shellText.slice(0, -closingTag.length)
        : shellText;

    const layers: TerrainLayer[] = [];

    layerElements.forEach((layer, index) => {
        layers.push({
            name: layer.id || `Layer ${index + 1}`,
            svg: prefix + serializer.serializeToString(layer) + closingTag,
        });
    });

    return { width, height, layers };
}

/** Splits a base64 string into fragments of at most `maxChars` characters. */
function splitBase64(data: string, maxChars: number): string[] {
    if (maxChars <= 0) throw new Error("The terrain chunk size must be positive.");

    const parts: string[] = [];
    for (let offset = 0; offset < data.length; offset += maxChars)
        parts.push(data.slice(offset, offset + maxChars));

    return parts;
}

/** Hands every layer of a complete terrain to a progressive listener. */
export function notifyTerrainLayers(
    terrain: TerrainData,
    notify: (progress: TerrainLayerProgress) => void,
): void {
    terrain.layers.forEach((layer, index) => {
        notify({
            layer,
            index,
            count: terrain.layers.length,
            width: terrain.width,
            height: terrain.height,
        });
    });
}

/**
 * Decodes a complete websocket terrain reply into a `TerrainData`.
 *
 * The current host sends layers that were already decompressed while the
 * transfer was in flight (`svg`); older hosts send one base64 payload per layer
 * (`data`). A legacy whole-SVG reply is still decompressed and split locally.
 */
export async function readTerrainReply(
    result: unknown,
    notify: (progress: TerrainLayerProgress) => void,
): Promise<TerrainData> {
    if (typeof result === "string") {
        const terrain = splitTerrainSVG(await decompressFromBase64(result));
        notifyTerrainLayers(terrain, notify);
        return terrain;
    }

    if (result && typeof result === "object") {
        const payload = result as { width?: unknown; height?: unknown; layers?: unknown };
        const { width, height, layers } = payload;

        if (
            typeof width === "number" && Number.isFinite(width) && width > 0
            && typeof height === "number" && Number.isFinite(height) && height > 0
            && Array.isArray(layers)
        ) {
            const decoded: TerrainLayer[] = [];

            for (const entry of layers) {
                if (!entry || typeof entry !== "object")
                    throw new Error("The terrain reply contains an invalid layer.");

                const { name, data, svg } = entry as {
                    name?: unknown;
                    data?: unknown;
                    svg?: unknown;
                };

                if (typeof name !== "string")
                    throw new Error("The terrain reply contains an invalid layer payload.");

                // Layers decoded while the transfer was in flight arrive as
                // text; older hosts send base64 and are decoded here. An empty
                // text layer is still a valid layer.
                if (typeof svg === "string") {
                    decoded.push({ name, svg });
                } else if (typeof data === "string" && data.length > 0) {
                    decoded.push({ name, svg: await decompressFromBase64(data) });
                } else {
                    throw new Error("The terrain reply contains an invalid layer payload.");
                }
            }

            return { width, height, layers: decoded };
        }
    }

    throw new Error("The terrain reply has an unexpected format.");
}

/** One compressed piece of one terrain layer, ready to send to the game. */
export interface TerrainLayerChunk {
    index: number;
    count: number;
    part: number;
    parts: number;
    name: string;
    width: number;
    height: number;
    data: string;
    /** True for the very last chunk of the whole terrain. */
    last: boolean;
}

/**
 * Compresses and fragments every terrain layer, one layer at a time to bound
 * peak memory. The caller sends each yielded chunk and awaits its acknowledgement.
 */
export async function* encodeTerrainChunks(
    terrain: TerrainData,
    debug: boolean,
): AsyncGenerator<TerrainLayerChunk> {
    const count = terrain.layers.length;

    for (let index = 0; index < count; index++) {
        const layer = terrain.layers[index];
        const data = await compressAndToBase64(layer.svg);
        const parts = splitBase64(data, MAX_TERRAIN_CHUNK_CHARS);

        if (debug) {
            // Release builds strip console.log, so use console.warn for the
            // runtime diagnostic.
            const rawBytes = new TextEncoder().encode(layer.svg).byteLength;
            const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
            const compressedBytes = Math.max(
                0,
                Math.floor((data.length * 3) / 4) - padding,
            );
            const ratio = compressedBytes > 0 ? rawBytes / compressedBytes : 0;
            const saved = rawBytes > 0 ? (1 - compressedBytes / rawBytes) * 100 : 0;
            const message =
                `[TacPhone] Terrain layer ${index + 1}/${count} "${layer.name}": ` +
                `${rawBytes} B SVG -> ${compressedBytes} B gzip ` +
                `(${data.length} base64 chars, ${parts.length} chunk(s)), ` +
                `ratio ${ratio.toFixed(2)}x, ${saved.toFixed(1)}% saved`;

            console.warn(message);
        }

        for (let part = 0; part < parts.length; part++) {
            yield {
                index,
                count,
                part,
                parts: parts.length,
                name: layer.name,
                width: terrain.width,
                height: terrain.height,
                data: parts[part],
                last: index === count - 1 && part === parts.length - 1,
            };
        }
    }
}

/** Layers of one in-flight multi-frame terrain reply. */
interface TerrainTransferLayer {
    name: string;
    expectedParts: number;
    parts: string[];
    /** Decoded SVG once this layer is complete. */
    svg?: string;
    /** In-flight decode of this layer. */
    decoding?: Promise<string>;
}

interface TerrainTransfer {
    count: number;
    width: number;
    height: number;
    layers: TerrainTransferLayer[];
    /** Set once the last layer arrived and the reply is being assembled. */
    finishing?: boolean;
}

/** What the websocket transport provides to the assembler. */
export interface TerrainTransferSink {
    /** False when the request was already rejected; its frames are dropped. */
    isPending(key: string): boolean;
    /** A valid frame arrived: restart the request's idle timeout. */
    onProgress(key: string): void;
    /** The transfer cannot continue; reject the pending request. */
    onError(key: string, error: Error): void;
    /** Every layer arrived and decoded; resolve the pending request. */
    onComplete(key: string, terrain: TerrainData): void;
}

/**
 * Buffers the `ReplyRequestTerrainSVG` frames of a websocket terrain request.
 *
 * Each layer is decompressed as soon as its last part arrives and is handed to
 * the request's progressive listener. The full `TerrainData` is reported only
 * after every layer has decoded.
 */
export class TerrainTransferAssembler {
    private readonly transfers = new Map<string, TerrainTransfer>();
    private readonly progress = new Map<string, TerrainLayerListener>();
    private readonly sink: TerrainTransferSink;

    public constructor(sink: TerrainTransferSink) {
        this.sink = sink;
    }

    /** Attaches the progressive listener for one request key. */
    public register(key: string, notify: TerrainLayerListener): void {
        this.progress.set(key, notify);
    }

    /** Drops the state of one request; safe for non-terrain keys. */
    public forget(key: string): void {
        this.transfers.delete(key);
        this.progress.delete(key);
    }

    /** Drops every transfer. Used when the game host can change. */
    public clear(): void {
        this.transfers.clear();
        this.progress.clear();
    }

    /**
     * Buffers one terrain frame. Returns true when `data` was a terrain frame
     * (consumed or rejected) so the caller does not treat it as a normal reply.
     */
    public handleChunk(key: unknown, data: unknown): boolean {
        if (typeof key !== "string" || !data || typeof data !== "object") return false;

        const d = data as Record<string, unknown>;
        if (d.c !== "ReplyRequestTerrainSVG") return false;

        // A transfer for a request that is no longer pending can never be consumed.
        if (!this.sink.isPending(key)) return true;

        // The transfer is alive: allow another idle window before giving up.
        this.sink.onProgress(key);

        if (typeof d.error === "string") {
            this.fail(key, new Error(d.error));
            return true;
        }

        const fail = (message: string): true => {
            this.fail(key, new Error(message));
            return true;
        };

        const { count, index, parts, part, name, width, height, data: chunk } = d;

        if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 64)
            return fail("The terrain reply has an invalid layer count.");

        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= (count as number))
            return fail("The terrain reply has an invalid layer index.");

        if (!Number.isInteger(parts) || (parts as number) < 1 || (parts as number) > 64)
            return fail("The terrain reply has an invalid part count.");

        if (!Number.isInteger(part) || (part as number) < 0 || (part as number) >= (parts as number))
            return fail("The terrain reply has an invalid part index.");

        if (typeof width !== "number" || !Number.isFinite(width) || width <= 0
            || typeof height !== "number" || !Number.isFinite(height) || height <= 0)
            return fail("The terrain reply has an invalid size.");

        if (typeof chunk !== "string" || chunk.length === 0)
            return fail("The terrain reply has an empty payload.");

        let transfer = this.transfers.get(key);
        if (!transfer) {
            transfer = { count: count as number, width, height, layers: [] };
            this.transfers.set(key, transfer);
        } else if (
            transfer.count !== (count as number)
            || transfer.width !== width
            || transfer.height !== height
        ) {
            return fail("The terrain reply changed its layer count or size mid-transfer.");
        }

        const layerIndex = index as number;
        const layerParts = parts as number;
        const partIndex = part as number;
        let layer = transfer.layers[layerIndex];

        if (!layer) {
            layer = {
                name: typeof name === "string" ? name : `Layer ${layerIndex + 1}`,
                expectedParts: layerParts,
                parts: [],
            };
            transfer.layers[layerIndex] = layer;
        } else if (layer.expectedParts !== layerParts) {
            return fail("The terrain reply changed its part count mid-transfer.");
        }

        layer.parts[partIndex] = chunk;

        console.log(
            `[TacPhone terrain] chunk layer ${layerIndex + 1}/${count}`
            + ` part ${partIndex + 1}/${layerParts} (${chunk.length} chars)`,
        );

        if (this.isTransferLayerComplete(layer)) {
            // Decode and hand over this layer now. Waiting for the rest of the
            // reply would keep the cheap layers behind the heavy SVGs.
            void this.decodeTransferLayer(key, transfer, layerIndex).catch((error) => {
                if (this.transfers.get(key) === transfer) {
                    this.fail(key, error instanceof Error ? error : new Error(String(error)));
                }
            });
        }

        if (this.isTransferComplete(transfer)) {
            void this.finishTerrainTransfer(key, transfer);
        }

        return true;
    }

    private fail(key: string, error: Error): void {
        this.forget(key);
        this.sink.onError(key, error);
    }

    /** True when every part of one layer arrived (or it was already decoded). */
    private isTransferLayerComplete(layer: TerrainTransferLayer): boolean {
        // Decoding clears `parts` to release the base64 memory. A decoded layer
        // is complete by definition; checking the cleared array would make the
        // whole transfer look incomplete forever.
        if (layer.svg !== undefined) {
            return true;
        }

        for (let part = 0; part < layer.expectedParts; part++) {
            if (typeof layer.parts[part] !== "string") {
                return false;
            }
        }

        return true;
    }

    /** True when every layer and every part of them arrived. */
    private isTransferComplete(transfer: TerrainTransfer): boolean {
        for (let index = 0; index < transfer.count; index++) {
            const entry = transfer.layers[index];
            if (!entry || !this.isTransferLayerComplete(entry)) {
                return false;
            }
        }

        return true;
    }

    /** Decodes one complete layer once and hands it to the progressive listener. */
    private decodeTransferLayer(
        key: string,
        transfer: TerrainTransfer,
        index: number,
    ): Promise<string> {
        const entry = transfer.layers[index];
        if (entry.svg !== undefined) {
            return Promise.resolve(entry.svg);
        }

        if (entry.decoding) {
            return entry.decoding;
        }

        entry.decoding = decompressFromBase64(entry.parts.join("")).then((svg) => {
            entry.svg = svg;
            // Release the base64 parts; only the decoded SVG is needed now.
            entry.parts = [];

            console.log(
                `[TacPhone terrain] layer ${index + 1}/${transfer.count}`
                + ` "${entry.name}" decoded (${svg.length} chars)`,
            );

            const notify = this.progress.get(key);
            if (notify) {
                notify({
                    layer: { name: entry.name, svg },
                    index,
                    count: transfer.count,
                    width: transfer.width,
                    height: transfer.height,
                });
            }

            return svg;
        });

        return entry.decoding;
    }

    /** Resolves the request once every layer has been decoded. */
    private async finishTerrainTransfer(
        key: string,
        transfer: TerrainTransfer,
    ): Promise<void> {
        if (transfer.finishing) {
            return;
        }

        transfer.finishing = true;
        console.log(`[TacPhone terrain] all ${transfer.count} layers arrived; assembling`);

        try {
            const decoded = await Promise.all(
                Array.from(
                    { length: transfer.count },
                    (_, index) => this.decodeTransferLayer(key, transfer, index),
                ),
            );

            console.log(`[TacPhone terrain] reply ready (${transfer.count} layers)`);

            const terrain: TerrainData = {
                width: transfer.width,
                height: transfer.height,
                layers: transfer.layers.map((entry, index) => ({
                    name: entry.name,
                    svg: decoded[index],
                })),
            };

            this.forget(key);
            this.sink.onComplete(key, terrain);
        } catch (error) {
            this.fail(key, error instanceof Error ? error : new Error(String(error)));
        }
    }
}
