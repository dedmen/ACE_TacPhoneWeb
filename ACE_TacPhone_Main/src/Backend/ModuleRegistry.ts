// Loads the runtime module dependencies an app declares in its game config and
// imports app modules through es-module-shims.
//
// A native import map has to exist before the first module is fetched and cannot
// be extended afterwards, so dependencies that are only known at runtime need
// the shim. Host shared modules stay on the native import map; only app and
// dependency modules go through `importShim`.
//
// Identical file content is imported once: the dedupe key is the SHA-256 of the
// raw game file text in the in-game browser, and the normalized game path
// everywhere else (where SHA-256 is skipped entirely). Per-app versions of the
// same specifier are expressed with import-map scopes keyed by the blob URL of
// the app or dependency module.

import "es-module-shims";
import {
    APP_BUNDLE_CODEC_GZIP,
    APP_BUNDLE_MARKER,
    APP_BUNDLE_VERSION,
    parseAppBundleHeader,
} from "@ace-tacphone/build/bundle-format";

import { decompressFromBase64 } from "./Compression";
import { IsArma, networking } from "./Networking";
import { sha256Hex as sha256HexJs } from "./Sha256";

/** One dependency as returned by `GetAvailableApps`. */
export interface DependencyDeclaration {
    /** Bare module specifier the dependency provides. */
    name: string;
    /** Packaged file inside the game PBO. */
    file: string;
}

/** One entry of the file manifest sent to the relay. */
export interface FileHash {
    path: string;
    hash: string;
}

type ImportMapInput = {
    imports?: Record<string, string>;
    scopes?: Record<string, Record<string, string>>;
};

interface ContentEntry {
    /** Blob URL of the decoded module source. */
    url: string;
    /** Bare specifiers the module imports; used for scope conflict checks. */
    imports: Set<string>;
    /** App keys that declared this dependency. */
    owners: Set<string>;
    /** Declared specifier, for diagnostics. */
    name: string;
    /** Game file, for diagnostics. */
    file: string;
}

interface UniqueDependency {
    id: string;
    name: string;
    file: string;
    owners: string[];
}

/** One adapter entry exported by a facade core module. */
interface FacadeEntry {
    default?: string;
    named?: Record<string, string>;
}

/** Bare specifiers the module imports or re-exports. */
const IMPORT_PATTERN = /(?:^|[^\w$])(?:import|export)\s*(?:[^'"]*?\bfrom\s*)?["']([^"']+)["']/g;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isBareSpecifier(specifier: string): boolean {
    return !specifier.startsWith(".")
        && !specifier.startsWith("/")
        && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier);
}

function collectBareImports(source: string): Set<string> {
    const specifiers = new Set<string>();

    for (const match of source.matchAll(IMPORT_PATTERN)) {
        if (isBareSpecifier(match[1]))
            specifiers.add(match[1]);
    }

    return specifiers;
}

function normalizeGamePath(path: string): string {
    return path.replaceAll("/", "\\").replace(/^\\+/, "").toLowerCase();
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && Object.values(value).every(entry => typeof entry === "string");
}

/** Reads the `__tacphoneFacade` manifest a facade core module exports. */
function readFacadeMap(namespace: unknown): Map<string, FacadeEntry> | undefined {
    if (typeof namespace !== "object" || namespace === null)
        return undefined;

    const raw = (namespace as { __tacphoneFacade?: unknown }).__tacphoneFacade;

    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return undefined;

    const facade = new Map<string, FacadeEntry>();

    for (const [specifier, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null || Array.isArray(value))
            continue;

        const candidate = value as { default?: unknown; named?: unknown };
        const entry: FacadeEntry = {};

        if (typeof candidate.default === "string")
            entry.default = candidate.default;

        if (isRecordOfStrings(candidate.named))
            entry.named = candidate.named;

        if (entry.default || (entry.named && Object.keys(entry.named).length > 0))
            facade.set(specifier, entry);
    }

    return facade.size > 0 ? facade : undefined;
}

/**
 * Builds the tiny module that re-exports one facade entry from the core file.
 *
 * The adapter imports the core by its declared specifier; a scope keyed by the
 * adapter URL pins it to the exact core version, so two apps can ship different
 * cores without coordinating.
 */
function buildAdapterSource(
    coreSpecifier: string,
    defaultBinding: string | undefined,
    named: Record<string, string>,
): string {
    const bindings = new Set<string>();

    if (defaultBinding)
        bindings.add(defaultBinding);

    for (const binding of Object.values(named))
        bindings.add(binding);

    const lines = [`import { ${[...bindings].join(", ")} } from ${JSON.stringify(coreSpecifier)};`];

    if (defaultBinding)
        lines.push(`export default ${defaultBinding};`);

    for (const [name, binding] of Object.entries(named)) {
        const exported = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
        lines.push(`export { ${binding} as ${exported} };`);
    }

    return lines.join("\n");
}

/**
 * SHA-256 of the raw game file text, lowercase hex.
 *
 * `crypto.subtle` is only available in a secure context, and the in-game page is
 * loaded from a `blob:` URL, so the in-game browser always takes the JavaScript
 * fallback in `Sha256.ts`. When `crypto.subtle` is available it is preferred.
 * Returns undefined only if hashing itself fails; the caller leaves that file out
 * of the manifest and loading continues.
 */
async function sha256Hex(text: string): Promise<string | undefined> {
    const subtle = globalThis.crypto?.subtle;

    if (subtle) {
        try {
            const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
            return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
        } catch (error) {
            console.warn("TacPhone: crypto.subtle hashing failed; using the JavaScript fallback.", error);
        }
    }

    try {
        return sha256HexJs(text);
    } catch (error) {
        console.warn("TacPhone could not hash a game file:", error);
        return undefined;
    }
}

/**
 * SHA-256 of a game file's raw text, or undefined outside the in-game browser.
 *
 * Shared by the dependency loader and the app directory so both halves of the
 * file manifest use the same hash.
 */
export async function hashGameFile(path: string, text: string): Promise<string | undefined> {
    if (!IsArma())
        return undefined;

    const hash = await sha256Hex(text);

    if (!hash)
        console.warn(`TacPhone could not hash "${path}"; it is left out of the file manifest.`);

    return hash;
}

/** Unpacks a dependency file that may be a plain ESM module or a bundle. */
async function decodeDependencySource(text: string, name: string, file: string): Promise<string> {
    if (!text.startsWith(APP_BUNDLE_MARKER))
        return text;

    const header = parseAppBundleHeader(text);

    if ("error" in header)
        throw new Error(
            `Dependency "${name}" file "${file}" has an invalid TacPhone bundle header (${header.error}).`,
        );

    if (header.version !== APP_BUNDLE_VERSION)
        throw new Error(
            `Dependency "${name}" file "${file}" uses bundle format version ${header.version}, `
            + `but this host reads version ${APP_BUNDLE_VERSION}.`,
        );

    if (header.codec !== APP_BUNDLE_CODEC_GZIP)
        throw new Error(
            `Dependency "${name}" file "${file}" uses bundle codec "${header.codec}", `
            + `but this host only reads "${APP_BUNDLE_CODEC_GZIP}".`,
        );

    return decompressFromBase64(header.payload);
}

/**
 * Owns the dependency content pool, the per-app specifier mappings and the
 * import map registered with es-module-shims.
 *
 * One instance is reused for every `LoadAvailableApps()`; `registerDependencies`
 * resets it first, so a retry cannot keep stale mappings.
 */
export class ModuleRegistry {
    private readonly contentByKey = new Map<string, ContentEntry>();
    private readonly resolvedById = new Map<string, ContentEntry>();
    private readonly importedEntries = new Set<ContentEntry>();
    private readonly namespaces = new Map<ContentEntry, unknown>();
    private readonly hashes = new Map<string, string>();
    private readonly mappingsByApp = new Map<string, Map<string, string>>();
    private readonly specifierUrls = new Map<string, Set<string>>();
    private readonly failed = new Map<string, string>();

    private shimSeeded = false;

    /** Stable id of one declaration, independent of the app that declared it. */
    static dependencyId(dependency: DependencyDeclaration): string {
        return `${dependency.name}\u0000${dependency.file}`;
    }

    /** Drops the previous load's state. Blob URLs are kept alive on purpose. */
    private reset(): void {
        this.contentByKey.clear();
        this.resolvedById.clear();
        this.importedEntries.clear();
        this.namespaces.clear();
        this.hashes.clear();
        this.mappingsByApp.clear();
        this.specifierUrls.clear();
        this.failed.clear();
    }

    /**
     * Reads every declared dependency, imports the modules in declaration order
     * and registers the resulting import map.
     *
     * All file reads start in parallel. Each file's hash starts as soon as its
     * text arrives, so later files hash while earlier modules load; the hashes
     * are all awaited before this method returns so the file manifest is complete.
     *
     * Returns the declarations that failed, keyed by `dependencyId`. A failed
     * dependency fails only the apps that declared it.
     */
    async registerDependencies(
        apps: Array<{ key: string; dependencies: DependencyDeclaration[] }>,
    ): Promise<ReadonlyMap<string, string>> {
        this.reset();

        const unique: UniqueDependency[] = [];
        const indexById = new Map<string, number>();

        for (const app of apps) {
            for (const dependency of app.dependencies) {
                const id = ModuleRegistry.dependencyId(dependency);
                let index = indexById.get(id);

                if (index === undefined) {
                    index = unique.length;
                    indexById.set(id, index);
                    unique.push({ id, name: dependency.name, file: dependency.file, owners: [] });
                }

                unique[index].owners.push(app.key);
            }
        }

        if (unique.length === 0)
            return this.failed;

        // Start every read at once; processing below stays in declaration order.
        const reads = unique.map(entry => networking.LoadGameFileText(entry.file));
        const hashPromises: Array<Promise<unknown>> = [];

        for (let i = 0; i < unique.length; i++) {
            const dependency = unique[i];

            let text: string;
            try {
                text = await reads[i];
            } catch (error) {
                this.failed.set(
                    dependency.id,
                    `could not read "${dependency.file}": ${errorMessage(error)}`,
                );
                continue;
            }

            // Start hashing immediately. The promise is awaited only when the
            // dedupe decision for this file has to be made, and once more at the
            // end of the load so the manifest is complete before returning.
            const hashPromise = this.recordHash(dependency.file, text);
            hashPromises.push(hashPromise);

            const key = await this.dedupeKey(dependency.file, hashPromise);
            let entry = this.contentByKey.get(key);

            if (!entry) {
                let source: string;
                try {
                    source = await decodeDependencySource(text, dependency.name, dependency.file);
                } catch (error) {
                    this.failed.set(dependency.id, errorMessage(error));
                    continue;
                }

                entry = {
                    url: URL.createObjectURL(new Blob([source], { type: "application/javascript" })),
                    imports: collectBareImports(source),
                    owners: new Set(),
                    name: dependency.name,
                    file: dependency.file,
                };
                this.contentByKey.set(key, entry);
            }

            this.resolvedById.set(dependency.id, entry);

            for (const owner of dependency.owners) {
                entry.owners.add(owner);

                let mapping = this.mappingsByApp.get(owner);
                if (!mapping) {
                    mapping = new Map();
                    this.mappingsByApp.set(owner, mapping);
                }

                mapping.set(dependency.name, entry.url);
            }

            let urls = this.specifierUrls.get(dependency.name);
            if (!urls) {
                urls = new Set();
                this.specifierUrls.set(dependency.name, urls);
            }

            urls.add(entry.url);
        }

        // Register every mapping before the first dependency executes, so a
        // transitive import always resolves through the shim.
        const shim = this.seedShim();
        shim.addImportMap(this.buildImportMap());

        // Import in declaration order. A shared content entry is imported once.
        for (const dependency of unique) {
            if (this.failed.has(dependency.id))
                continue;

            const entry = this.resolvedById.get(dependency.id);
            if (!entry || this.importedEntries.has(entry))
                continue;

            this.importedEntries.add(entry);

            try {
                const namespace = await shim(entry.url);
                this.namespaces.set(entry, namespace);
            } catch (error) {
                const message = `failed to import "${dependency.name}" (${dependency.file}): ${errorMessage(error)}`;

                for (const other of unique) {
                    if (this.resolvedById.get(other.id) === entry)
                        this.failed.set(other.id, message);
                }
            }
        }

        // Facade cores are imported now, so their manifests can be expanded into
        // per-specifier adapters before any app module runs.
        this.registerFacades(shim);

        // The manifest must be complete before the loader returns.
        await Promise.all(hashPromises);

        return this.failed;
    }

    /** Imports an app module, with its own specifier scope registered first. */
    async importApp(url: string, appKey: string): Promise<unknown> {
        const shim = this.seedShim();
        const mapping = this.mappingsByApp.get(appKey);

        if (mapping && mapping.size > 0) {
            const scope: Record<string, string> = {};
            for (const [specifier, target] of mapping)
                scope[specifier] = target;

            shim.addImportMap({ scopes: { [url]: scope } });
        }

        try {
            return await shim(url);
        } catch (error) {
            throw new Error(`TacPhone failed to import an app module: ${errorMessage(error)}`, { cause: error });
        }
    }

    /** Hashes of the dependency files read during the last load. */
    getFileHashes(): FileHash[] {
        return [...this.hashes]
            .map(([path, hash]) => ({ path, hash }))
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    /** Error of one declaration, if it failed during the last load. */
    dependencyError(dependency: DependencyDeclaration): string | undefined {
        return this.failed.get(ModuleRegistry.dependencyId(dependency));
    }

    private async recordHash(file: string, text: string): Promise<string | undefined> {
        const hash = await hashGameFile(file, text);
        if (hash)
            this.hashes.set(file, hash);

        return hash;
    }

    private async dedupeKey(file: string, hashPromise: Promise<string | undefined>): Promise<string> {
        const hash = await hashPromise;
        return hash ? `sha256:${hash}` : `path:${normalizeGamePath(file)}`;
    }

    /**
     * Expands every loaded facade core into one adapter module per specifier.
     *
     * A facade core is a single file that re-exports a subpath-heavy library
     * (`ol/Map`, `ol/style`, ...) and publishes `__tacphoneFacade` mapping each
     * facade specifier to its exported bindings. The host turns that into tiny
     * adapter modules so the app can import `tacphone-ol/Map` normally, while the
     * core itself stays one shared dependency file.
     *
     * Apps that declared the core get the facade specifiers in their own scope,
     * so two apps can ship different cores without coordinating.
     */
    private registerFacades(shim: typeof importShim): void {
        const imports: Record<string, string> = {};
        const scopes: Record<string, Record<string, string>> = {};
        const urlsBySpecifier = new Map<string, Set<string>>();

        for (const [entry, namespace] of this.namespaces) {
            const facade = readFacadeMap(namespace);

            if (!facade)
                continue;

            for (const [specifier, facadeEntry] of facade) {
                const source = buildAdapterSource(entry.name, facadeEntry.default, facadeEntry.named ?? {});
                const adapterUrl = URL.createObjectURL(
                    new Blob([source], { type: "application/javascript" }),
                );

                // The adapter imports the core by its declared specifier; this
                // scope pins it to the exact core file of the app that owns it.
                scopes[adapterUrl] = { [entry.name]: entry.url };

                let urls = urlsBySpecifier.get(specifier);
                if (!urls) {
                    urls = new Set();
                    urlsBySpecifier.set(specifier, urls);
                }

                urls.add(adapterUrl);

                for (const owner of entry.owners) {
                    let mapping = this.mappingsByApp.get(owner);
                    if (!mapping) {
                        mapping = new Map();
                        this.mappingsByApp.set(owner, mapping);
                    }

                    mapping.set(specifier, adapterUrl);
                }
            }
        }

        // Only a specifier with a single adapter everywhere can be global; the
        // per-app scope above is what resolves the rest.
        for (const [specifier, urls] of urlsBySpecifier) {
            if (urls.size === 1 && !(specifier in imports))
                imports[specifier] = [...urls][0];
        }

        if (Object.keys(imports).length === 0 && Object.keys(scopes).length === 0)
            return;

        try {
            shim.addImportMap({ imports, scopes });
        } catch (error) {
            console.warn("TacPhone could not register the facade adapters:", error);
        }
    }

    private seedShim(): typeof importShim {
        const shim = window.importShim;

        if (!shim) {
            throw new Error(
                "TacPhone could not initialize es-module-shims; app dependencies and app modules cannot load.",
            );
        }

        if (!this.shimSeeded) {
            this.shimSeeded = true;

            // The host itself uses the native import map. The shim has its own
            // map, so seed it with the same shared-module entries.
            const native = document.querySelector<HTMLScriptElement>('script[type="importmap"]');
            if (native?.textContent) {
                try {
                    shim.addImportMap(JSON.parse(native.textContent) as ImportMapInput);
                } catch (error) {
                    console.warn("TacPhone could not seed es-module-shims with the host import map:", error);
                }
            }
        }

        return shim;
    }

    private buildImportMap(): ImportMapInput {
        const imports: Record<string, string> = {};

        // A specifier with one version everywhere needs no scope.
        for (const [specifier, urls] of this.specifierUrls) {
            if (urls.size === 1)
                imports[specifier] = [...urls][0];
        }

        const scopes: Record<string, Record<string, string>> = {};

        // A dependency module that is shared by several apps must see the same
        // version of every specifier it imports from each of them.
        for (const entry of this.contentByKey.values()) {
            const scope = this.scopeForOwners(entry.owners, entry.imports, entry.name);

            if (Object.keys(scope).length > 0)
                scopes[entry.url] = scope;
        }

        return { imports, scopes };
    }

    private scopeForOwners(
        owners: Iterable<string>,
        needed: Set<string>,
        moduleName: string,
    ): Record<string, string> {
        const scope: Record<string, string> = {};

        for (const specifier of needed) {
            // A single global version resolves without a scope.
            if (this.specifierUrls.get(specifier)?.size === 1)
                continue;

            let chosen: string | undefined;
            let chosenOwner: string | undefined;

            for (const owner of owners) {
                const url = this.mappingsByApp.get(owner)?.get(specifier);
                if (!url)
                    continue;

                if (chosen && chosen !== url) {
                    throw new Error(
                        `TacPhone dependency "${moduleName}" is shared by apps that need different versions `
                        + `of "${specifier}" (${chosenOwner} and ${owner}). `
                        + "Ship a separate copy of the dependency file for one of the apps, or align the versions.",
                    );
                }

                chosen = url;
                chosenOwner = owner;
            }

            if (chosen)
                scope[specifier] = chosen;
        }

        return scope;
    }
}

/** The one module registry of this page. */
export const moduleRegistry = new ModuleRegistry();
