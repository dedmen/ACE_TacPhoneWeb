// Host localization service (`window.TacPhone.localization`).
//
// Two tables exist:
//   - the bundled default table, parsed from the add-on stringtable at build
//     time and compressed into the host bundle. It is what the pre-connection
//     UI (remote pairing, loading, fatal error) shows.
//   - the live table, built from the add-on `stringtable.xml` once the game is
//     reachable and from the stringtables of apps that ship in other add-ons.
//
// When the file load fails the page keeps the bundled table and asks the game
// for individual keys (`Localization.Get`, at most 100 per request). Nothing is
// loaded or parsed in SQF.

import DEFAULT_STRINGS_B64 from 'virtual:tacphone-stringtable'

import { decompressFromBase64 } from './Compression'
import { normalizeGamePath, withTimeout } from './Internal'
import { networking } from './Networking'
import {
    browserLanguageTag,
    gameLanguageTag,
    parseStringtable,
    pickLanguage,
    type LanguageTable,
    type StringTable,
} from './Stringtable'

/** How long one game/file request may take before it counts as failed. */
const LOAD_TIMEOUT_MS = 10_000

/** Maximum keys per `Localization.Get` request, as specified by the game side. */
const ON_DEMAND_BATCH = 100

/**
 * HEMTT compiles `stringtable.xml` into `stringtable.bin`, so the source XML is
 * not in the game files. Keep the runtime file loader for when it returns, but
 * do not run it: the whole table is bundled into the host at build time and the
 * game language reported by `Localization.Info` selects the language block.
 */
const LOAD_STRINGTABLE_FILE = false

/** Prefix of every log line this module writes. */
const LOG_PREFIX = 'TacPhone localization:'

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** The one localization service of this page. */
export class Localization {
    /** Parsed bundled table (`language tag -> key -> text`). */
    private defaults: StringTable = {}

    /** Active table; falls back to the bundled table until the game answers. */
    private active: LanguageTable = new Map()

    /** True once a table from the game replaced the bundled defaults. */
    private gameTableLoaded = false

    /** Tag of the active table, e.g. "English" or "German". */
    private blockTag = 'English'

    /** Language name reported by the game; the tag name before that. */
    private languageName = 'English'

    private readonly listeners = new Set<() => void>()
    private readonly loadedPaths = new Set<string>()
    private readonly loadingPaths = new Map<string, Promise<void>>()

    private defaultsPromise: Promise<void> | undefined
    private readyPromise: Promise<void> | undefined

    /** Keys queued for an on-demand lookup. */
    private readonly pendingKeys = new Set<string>()
    /** Keys already requested; avoids asking twice. */
    private readonly askedKeys = new Set<string>()
    /** Keys the game could not translate; never asked again. */
    private readonly missingKeys = new Set<string>()

    private flushScheduled = false
    private flushing = false
    private connected = false
    private announceScheduled = false
    private warnedOnDemand = false

    constructor() {
        networking.OnConnectionChange(connected => {
            this.connected = connected
            if (connected && this.pendingKeys.size > 0)
                this.scheduleFlush()
        })
    }

    // -----------------------------------------------------------------------
    // Defaults (bundled table)
    // -----------------------------------------------------------------------

    /** Decodes the bundled table and picks the browser language. Idempotent. */
    loadDefaults(): Promise<void> {
        this.defaultsPromise ??= this.readDefaults()
        return this.defaultsPromise
    }

    private async readDefaults(): Promise<void> {
        try {
            const json = await decompressFromBase64(DEFAULT_STRINGS_B64)
            this.defaults = JSON.parse(json) as StringTable
        } catch (error) {
            console.error(`${LOG_PREFIX} the bundled string table could not be read.`, error)
            this.defaults = {}
        }

        this.applyBrowserLanguage()
    }

    private applyBrowserLanguage(): void {
        // A late loadDefaults() must not replace an already loaded game table.
        if (this.gameTableLoaded)
            return

        const tag = browserLanguageTag()
        this.blockTag = tag
        this.languageName = tag
        this.active = pickLanguage(this.defaults, tag)
    }

    // -----------------------------------------------------------------------
    // Game table and app stringtables
    // -----------------------------------------------------------------------

    /**
     * Loads the host stringtable and merges it into the active table.
     * Never rejects: a failure keeps the bundled table and enables on-demand
     * lookups, and logs one warning that survives release builds.
     */
    whenReady(): Promise<void> {
        this.readyPromise ??= this.loadHost().catch(error => {
            console.warn(`${LOG_PREFIX} could not load the host stringtable:`, error)
        })

        return this.readyPromise
    }

    private async loadHost(): Promise<void> {
        await networking.WhenReady()

        const info = await withTimeout(
            networking.Request({ a: 'main', c: 'Localization.Info' }),
            LOAD_TIMEOUT_MS,
            'Localization.Info',
        )

        if (typeof info !== 'object' || info === null)
            throw new Error('Localization.Info returned no object')

        const data = info as Record<string, unknown>
        const language = typeof data.language === 'string' ? data.language.trim() : ''
        const path = typeof data.stringtable === 'string' ? data.stringtable.trim() : ''

        const tag = gameLanguageTag(language) ?? 'English'

        if (language.length > 0 && gameLanguageTag(language) === undefined) {
            console.warn(`${LOG_PREFIX} unknown game language "${language}"; using English strings.`)
        }

        this.blockTag = tag
        this.languageName = language.length > 0 ? language : tag

        if (!LOAD_STRINGTABLE_FILE) {
            // The table bundled into the host already contains every language
            // from the build-time stringtable.xml; select the game language.
            this.active = pickLanguage(this.defaults, tag)
            this.gameTableLoaded = true
            this.announce()
            return
        }

        if (path.length === 0)
            throw new Error('Localization.Info returned no stringtable path')

        await this.loadTable(path, tag, true)
    }

    /**
     * Loads the stringtables of apps that ship in other add-ons. Paths already
     * loaded (including the host stringtable) are skipped. Never rejects.
     */
    async loadStringtables(paths: readonly string[]): Promise<void> {
        const unique = [...new Set(paths.map(path => path.trim()).filter(path => path.length > 0))]

        if (unique.length === 0)
            return

        // The XML files are not in the game files while HEMTT compiles
        // stringtables to .bin. Third-party app keys still resolve through the
        // on-demand `Localization.Get` fallback.
        if (!LOAD_STRINGTABLE_FILE)
            return

        // App paths must be read in the game language, so never resolve them in
        // the browser language because the host table is still pending.
        await this.whenReady()

        await Promise.all(unique.map(path => this.loadTable(path, this.blockTag, false)))
    }

    /** Loads one file, parses it and merges (or replaces) the active table. */
    private loadTable(path: string, tag: string, replace: boolean): Promise<void> {
        const key = normalizeGamePath(path)

        if (this.loadedPaths.has(key))
            return Promise.resolve()

        let loading = this.loadingPaths.get(key)
        if (loading)
            return loading

        loading = this.readTable(path, tag, replace)
        this.loadingPaths.set(key, loading)

        return loading.finally(() => {
            this.loadingPaths.delete(key)
        })
    }

    private async readTable(path: string, tag: string, replace: boolean): Promise<void> {
        try {
            const xml = await withTimeout(
                networking.LoadGameFileText(path),
                LOAD_TIMEOUT_MS,
                `reading stringtable "${path}"`,
            )

            const parsed = parseStringtable(xml)
            const table = pickLanguage(parsed, tag)

            if (table.size === 0)
                throw new Error('no usable translations')

            if (replace || this.active.size === 0) {
                this.active = table

                if (replace) {
                    this.gameTableLoaded = true
                    // Values learned before the game table arrived may be gone
                    // from the new table (or the table itself changed); allow a
                    // fresh on-demand lookup for them.
                    this.askedKeys.clear()
                    this.missingKeys.clear()
                }
            } else {
                for (const [key, text] of table)
                    this.active.set(key, text)
            }

            this.loadedPaths.add(normalizeGamePath(path))
            this.announce()
        } catch (error) {
            // A failed file load is expected to be recoverable: keep whatever is
            // loaded and let the on-demand lookups fill the gaps. warn() survives
            // the release build, unlike log/debug/info.
            console.warn(
                `${LOG_PREFIX} could not load stringtable "${path}"; `
                + `using the bundled defaults and on-demand lookups. (${errorMessage(error)})`,
            )
        }
    }

    // -----------------------------------------------------------------------
    // Lookups
    // -----------------------------------------------------------------------

    /** Translated text with `%1`..`%9` substituted; the key when unknown. */
    t(key: string, ...args: Array<string | number>): string {
        const text = this.active.get(key.toUpperCase())

        if (text === undefined) {
            this.queueKey(key)
            return key
        }

        if (args.length === 0)
            return text

        return text.replace(/%(\d)/g, (match, index: string) => {
            const value = args[Number(index) - 1]
            return value === undefined ? match : String(value)
        })
    }

    /** True when the active table has the key. */
    has(key: string): boolean {
        return this.active.has(key.toUpperCase())
    }

    /** Active language name ("English", "Deutsch", ...). */
    language(): string {
        return this.languageName
    }

    /** Subscribes to table changes; returns the unsubscribe function. */
    onDidChange(listener: () => void): () => void {
        this.listeners.add(listener)

        return () => {
            this.listeners.delete(listener)
        }
    }

    /** Waits until `keys` were requested on demand, when the transport allows it. */
    async load(keys: readonly string[]): Promise<void> {
        for (const key of keys) {
            if (!this.active.has(key.toUpperCase()))
                this.queueKey(key)
        }

        await this.flush()
    }

    /** Coalesces change notifications into one microtask. */
    private announce(): void {
        if (this.announceScheduled)
            return

        this.announceScheduled = true
        queueMicrotask(() => {
            this.announceScheduled = false

            for (const listener of [...this.listeners]) {
                try {
                    listener()
                } catch (error) {
                    console.error(`${LOG_PREFIX} change listener failed:`, error)
                }
            }
        })
    }

    // -----------------------------------------------------------------------
    // On-demand fallback
    // -----------------------------------------------------------------------

    private queueKey(key: string): void {
        const upper = key.toUpperCase()

        if (this.missingKeys.has(upper) || this.askedKeys.has(upper) || this.pendingKeys.has(upper))
            return

        this.pendingKeys.add(upper)
        this.scheduleFlush()
    }

    private scheduleFlush(): void {
        if (this.flushScheduled || this.pendingKeys.size === 0 || !this.connected)
            return

        this.flushScheduled = true
        setTimeout(() => {
            this.flushScheduled = false
            void this.flush()
        }, 0)
    }

    /** Requests queued keys in batches of at most 100. Safe to call directly. */
    private async flush(): Promise<void> {
        if (this.flushing || !this.connected || this.pendingKeys.size === 0)
            return

        const keys = [...this.pendingKeys].slice(0, ON_DEMAND_BATCH)
        for (const key of keys) {
            this.pendingKeys.delete(key)
            this.askedKeys.add(key)
        }

        this.flushing = true

        try {
            const result = await withTimeout(
                networking.Request({ a: 'main', c: 'Localization.Get', keys }),
                LOAD_TIMEOUT_MS,
                'Localization.Get',
            )

            if (typeof result !== 'object' || result === null)
                throw new Error('Localization.Get returned no object')

            let added = false

            for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
                if (typeof value !== 'string' || value.length === 0)
                    continue

                const upper = key.toUpperCase()
                if (!this.active.has(upper)) {
                    this.active.set(upper, value)
                    added = true
                }
            }

            for (const key of keys) {
                if (!this.active.has(key))
                    this.missingKeys.add(key)
            }

            if (added)
                this.announce()
        } catch (error) {
            // Retry on the next connection or the next lookup; do not leak one
            // warning per render for the same batch.
            for (const key of keys) {
                this.askedKeys.delete(key)
                this.pendingKeys.add(key)
            }

            if (!this.warnedOnDemand) {
                this.warnedOnDemand = true
                console.warn(`${LOG_PREFIX} on-demand string lookup failed; will retry.`, error)
            }
        } finally {
            this.flushing = false

            if (this.pendingKeys.size > 0)
                this.scheduleFlush()
        }
    }
}

/** The one localization service of this page. */
export const localization = new Localization()

