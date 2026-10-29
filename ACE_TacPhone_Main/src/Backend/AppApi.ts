// Host-side registry of the runtime APIs that apps expose to each other.
//
// Apps register a versioned service from their panel lifecycle through
// `window.AppApi.register(panel, { service, version, api })`; other apps look the
// service up with `resolve()` (synchronous snapshot) or `resolveAsync()` (routing)
// and call it. Because one app can be open in several panels, the registry is
// keyed by panel instance and service, never by service alone.
//
// This is page-local plumbing: it never goes through Networking/SQF, the game can
// never reach it, and it is not a security boundary (every app in the page can
// call every API).
//
// flexlayout mounts only the selected tab of a tabset, so an app that is open but
// in the background has no registration yet. resolveAsync() therefore activates a
// candidate and waits for its registration (bounded by waitMs) instead of polling.
//
// Host lifecycle: nothing to wire up. The module creates `window.AppApi` at module
// scope and subscribes to PanelDirectory.onDidChange to drop registrations of
// panels that are gone.

import type { PanelInfo, PanelInstance, PanelPlacement } from "./PanelDirectory";

/** Time resolveAsync() waits for a panel to mount and register its API. */
const DEFAULT_WAIT_MS = 3000;
/** Hard cap for caller-supplied waits, so a routing call cannot hang forever. */
const MAX_WAIT_MS = 30000;

/** One service registration of one mounted panel. */
export interface AppApiRegistration<T = unknown> {
    /** Stable, app-chosen, lowercase service name: "map", "messenger", ... */
    service: string;
    /** Integer major version of the API. */
    version: number;
    /** What other apps receive from resolve()/resolveAll()/getApi(). */
    api: T;
}

/** One registered provider of a service, with a fresh snapshot of its panel. */
export interface AppServiceInfo {
    /** Service name the panel registered. */
    service: string;
    /** Version the panel registered. */
    version: number;
    /** Fresh PanelInfo of the panel that provides the API. */
    instance: PanelInfo;
    /** The api passed to register(). */
    api: unknown;
}

/** How resolve()/resolveAsync() pick between several panels of the same service. */
export type TargetPolicy = "auto" | "focused" | "largest" | "first" | "ask";

/** What to route to: one service, optionally narrowed to a version, panel or instance. */
export interface TargetOptions {
    /** Service to find, e.g. "map". */
    service: string;
    /** Default "auto": focused panel, then the largest, then the only candidate. */
    policy?: TargetPolicy;
    /** Requested major version; without it the highest registered version wins. */
    version?: number;
    /** Restrict candidates to one app panel id, e.g. "ACE_TacPhone_Map". */
    panelId?: string;
    /** Explicit target; wins over the policy. Accepts an instance id or a tab id. */
    instanceId?: string;
    /** Open the app when no panel provides it yet. Needs panelId. */
    openIfMissing?: boolean;
    /** Placement used with openIfMissing; default "float" (a floating popup). */
    placement?: PanelPlacement;
    /** Activate the target panel before returning and waiting. Default true. */
    activate?: boolean;
    /** How long to wait for a panel to mount and register its API. Default 3000. */
    waitMs?: number;
}

/**
 * Ask the user (or the host) which panel should receive the request. Return the
 * instanceId (or tabId) of one of the candidates, or undefined to cancel.
 */
export type TargetChooser = (
    request: { service: string; candidates: PanelInfo[]; reason?: string }
) => Promise<string | undefined> | string | undefined;

/** One (panel instance, service) registration. Identity is used to detect stale disposers. */
interface RegistrationEntry {
    service: string;
    version: number;
    api: unknown;
    instanceId: string;
}

/** Validated service name, or undefined for an empty/invalid one. */
function normalizeService(service: string | undefined): string | undefined {
    if (typeof service !== "string")
        return undefined;

    const trimmed = service.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}

/** Bounded wait budget; a missing or negative value means the default. */
function normalizeWait(waitMs: number | undefined): number {
    if (typeof waitMs !== "number" || !Number.isFinite(waitMs) || waitMs < 0)
        return DEFAULT_WAIT_MS;

    return Math.min(waitMs, MAX_WAIT_MS);
}

/** Suffix for log lines, so a caller's reason shows up next to the failure. */
function describeReason(reason: string | undefined): string {
    return reason ? ` (${reason})` : "";
}

/**
 * Registry of the APIs apps expose to each other, and the target routing that
 * picks the right panel when an app is open more than once.
 *
 * One instance lives at module scope as `window.AppApi`. Every lookup is
 * read-only and safe before a layout is attached; only register() throws, and
 * only for a programming error in the registering app.
 */
export class AppApiRegistry {
    /** Registrations per panel instance id, then per service name. */
    private readonly registrations = new Map<string, Map<string, RegistrationEntry>>();
    private readonly listeners = new Set<(services: AppServiceInfo[]) => void>();
    private targetChooser: TargetChooser | undefined;
    private unsubscribePanels: (() => void) | undefined;
    private warnedSyncAsk = false;
    private notifying = false;

    /** Drops registrations of closed panels and forwards the new panel snapshot. */
    private readonly handlePanelsChanged = (panels: PanelInfo[]): void => {
        const live = new Set<string>();
        for (const panel of panels) {
            if (panel.instanceId)
                live.add(panel.instanceId);
        }

        for (const instanceId of [...this.registrations.keys()]) {
            if (!live.has(instanceId))
                this.registrations.delete(instanceId);
        }

        // Panel rects, focus and titles are part of AppServiceInfo.instance, so a
        // panel change is a service change even when no registration moved.
        this.notifyChanged();
    };

    /**
     * Registers the API of one mounted panel.
     *
     * Call it from the app lifecycle (useEffect / componentDidMount) with the
     * instance delivered through the panel context, and call the returned
     * function when that content unmounts. Re-registering the same service on the
     * same panel replaces the previous registration with a warning; a dispose
     * function from an earlier registration is a no-op.
     *
     * Throws on a missing instance or an invalid service/version, which are
     * programming errors of the registering app.
     */
    register(instance: PanelInstance, registration: AppApiRegistration): () => void {
        const instanceId = instance?.instanceId;
        if (typeof instanceId !== "string" || instanceId.length === 0)
            throw new Error("TacPhone AppApi.register() needs the panel instance delivered through the panel context.");

        const service = normalizeService(registration?.service);
        if (!service)
            throw new Error("TacPhone AppApi.register() needs a non-empty \"service\" name.");

        const version = registration.version;
        if (!Number.isInteger(version) || version < 1)
            throw new Error(`TacPhone AppApi.register() needs an integer version >= 1 for service "${service}".`);

        this.ensurePanelSubscription();

        const entry: RegistrationEntry = { service, version, api: registration.api, instanceId };

        let byService = this.registrations.get(instanceId);
        if (!byService) {
            byService = new Map<string, RegistrationEntry>();
            this.registrations.set(instanceId, byService);
        } else if (byService.has(service)) {
            console.warn(`TacPhone AppApi: panel "${instanceId}" already registered service "${service}"; replacing it.`);
        }

        byService.set(service, entry);
        this.notifyChanged();

        let disposed = false;
        return () => {
            if (disposed)
                return;

            disposed = true;
            this.unregister(entry);
        };
    }

    /** Every registered service, optionally restricted to one service name. */
    list(service?: string): AppServiceInfo[] {
        this.ensurePanelSubscription();

        const panels = window.PanelDirectory?.list() ?? [];
        const byInstance = new Map<string, PanelInfo>();
        for (const panel of panels) {
            if (panel.instanceId)
                byInstance.set(panel.instanceId, panel);
        }

        const services: AppServiceInfo[] = [];
        for (const [instanceId, byService] of this.registrations) {
            const instance = byInstance.get(instanceId);
            // Stale: the panel is gone. The panel listener removes the entry.
            if (!instance)
                continue;

            for (const entry of byService.values()) {
                if (service !== undefined && entry.service !== service)
                    continue;

                services.push({ service: entry.service, version: entry.version, instance, api: entry.api });
            }
        }

        return services;
    }

    /**
     * Synchronous lookup of an already registered service.
     *
     * Only mounted panels are considered, so this returns undefined for an app
     * that is open in a background tab. Policy "ask" cannot wait for a user, so it
     * falls back to "auto" (with one warning). Never throws.
     */
    resolve(target: string | TargetOptions): AppServiceInfo | undefined {
        try {
            const options: TargetOptions = typeof target === "string" ? { service: target } : target;
            const service = normalizeService(options?.service);
            if (!service) {
                console.warn("TacPhone AppApi: resolve() needs a non-empty \"service\".");
                return undefined;
            }

            const candidates = this.registeredCandidates(service, options.version, options.panelId, options.instanceId);
            if (candidates.length === 0) {
                console.warn(`TacPhone AppApi: no mounted panel provides service "${service}".`);
                return undefined;
            }

            const policy = options.policy ?? "auto";
            if (policy === "ask" && !this.warnedSyncAsk) {
                console.warn("TacPhone AppApi: policy \"ask\" needs a user decision and is unavailable synchronously; using \"auto\".");
                this.warnedSyncAsk = true;
            }

            const picked = this.pick(candidates, policy === "ask" ? "auto" : policy, true, candidate => candidate.instance);
            if (!picked) {
                console.warn(`TacPhone AppApi: no panel of service "${service}" matches policy "${policy}".`);
                return undefined;
            }

            return picked;
        } catch (error) {
            console.error("TacPhone AppApi: resolve() failed:", error);
            return undefined;
        }
    }

    /**
     * Every registered provider that matches the filters of the target; no policy
     * and no auto-open. Like resolve(), it prefers the highest registered version
     * unless the target asks for one explicitly.
     */
    resolveAll(target: TargetOptions): AppServiceInfo[] {
        try {
            const service = normalizeService(target?.service);
            if (!service) {
                console.warn("TacPhone AppApi: resolveAll() needs a non-empty \"service\".");
                return [];
            }

            return this.registeredCandidates(service, target.version, target.panelId, target.instanceId);
        } catch (error) {
            console.error("TacPhone AppApi: resolveAll() failed:", error);
            return [];
        }
    }

    /**
     * Routing entry point: finds the right panel for a service, mounting it,
     * activating it and opening the app when the target allows that.
     *
     * Order: an explicit instanceId, then the open panels that match, then
     * (openIfMissing) opening the app as a floating popup, then the policy, then
     * activating the chosen panel and waiting up to waitMs for its registration.
     * Never throws: every failure returns undefined with a warning.
     */
    async resolveAsync(target: TargetOptions, reason?: string): Promise<AppServiceInfo | undefined> {
        try {
            const service = normalizeService(target?.service);
            if (!service) {
                console.warn("TacPhone AppApi: resolveAsync() needs a non-empty \"service\".");
                return undefined;
            }

            const waitMs = normalizeWait(target.waitMs);
            const activate = target.activate !== false;
            const context = describeReason(reason);

            // 1. An explicit instance (or tab) wins over every policy.
            if (target.instanceId) {
                const panel = this.panelByInstanceOrTab(target.instanceId);

                if (panel) {
                    if (activate)
                        window.PanelDirectory?.activate(panel.instanceId ?? panel.tabId);

                    const ready = this.registeredForTab(service, panel.tabId, target.version);
                    if (ready)
                        return ready;

                    const waited = await this.waitUntil(waitMs, () => this.registeredForTab(service, panel.tabId, target.version));
                    if (waited)
                        return waited;
                }

                console.warn(`TacPhone AppApi: panel "${target.instanceId}" did not provide service "${service}"${context}.`);
                return undefined;
            }

            // 2. Candidates include background tabs; step 5 mounts them on demand.
            let candidates = this.candidatePanels(service, target.version, target.panelId);

            // 3. Open a missing app (a floating popup by default) and wait for it.
            if (candidates.length === 0 && target.openIfMissing) {
                if (!target.panelId) {
                    console.warn(`TacPhone AppApi: openIfMissing needs a "panelId", so service "${service}" cannot be opened${context}.`);
                    return undefined;
                }

                const opened = window.PanelDirectory?.open(target.panelId, {
                    placement: target.placement ?? "float",
                    select: true
                });

                if (!opened) {
                    console.warn(`TacPhone AppApi: failed to open panel "${target.panelId}" for service "${service}"${context}.`);
                    return undefined;
                }

                // Deliberate: the popup stays open when the app never registers, so
                // the user can see (and close) whatever went wrong in it.
                await this.waitUntil(waitMs, () => this.registeredForTab(service, opened.tabId, target.version));
                candidates = this.candidatePanels(service, target.version, target.panelId);

                if (candidates.length === 0) {
                    console.warn(`TacPhone AppApi: panel "${target.panelId}" did not register service "${service}" within ${waitMs} ms${context}.`);
                    return undefined;
                }
            }

            if (candidates.length === 0) {
                console.warn(`TacPhone AppApi: no panel provides service "${service}"${context}.`);
                return undefined;
            }

            // 4. Policy.
            const chosen = await this.chooseTarget(service, candidates, target, reason);
            if (!chosen) {
                console.warn(`TacPhone AppApi: no panel of service "${service}" was selected${context}.`);
                return undefined;
            }

            // 5. Bring the target to the front, then make sure its API is registered.
            if (activate)
                window.PanelDirectory?.activate(chosen.instanceId ?? chosen.tabId);

            const ready = this.registeredForTab(service, chosen.tabId, target.version);
            if (ready)
                return ready;

            const waited = await this.waitUntil(waitMs, () => this.registeredForTab(service, chosen.tabId, target.version));
            if (waited)
                return waited;

            const available = this.registeredForTab(service, chosen.tabId, undefined);
            const name = chosen.title || chosen.tabId;

            if (available && target.version !== undefined) {
                console.warn(`TacPhone AppApi: panel "${name}" provides service "${service}" version ${available.version}, but version ${target.version} was requested${context}.`);
                return undefined;
            }

            console.warn(`TacPhone AppApi: panel "${name}" did not register service "${service}" within ${waitMs} ms${context}.`);
            return undefined;
        } catch (error) {
            console.error(`TacPhone AppApi: resolving service "${target?.service}" failed:`, error);
            return undefined;
        }
    }

    /**
     * Convenience wrapper around resolve(): the API of a mounted service, or
     * undefined. Use resolveAsync() when the panel may be in the background or not
     * open yet.
     */
    getApi<T>(service: string, options?: TargetOptions): T | undefined {
        const info = this.resolve({ ...options, service });
        return info ? info.api as T : undefined;
    }

    /**
     * Calls one method of a service after routing to a provider with resolveAsync().
     *
     * Unlike resolve()/resolveAsync(), this throws: the service being unavailable,
     * the method being missing, and the method itself failing all reach the
     * caller, who can report them.
     */
    async call<T>(service: string, method: string, ...args: unknown[]): Promise<T> {
        const target = await this.resolveAsync({ service });
        if (!target)
            throw new Error(`TacPhone AppApi: cannot call "${service}.${method}()": no panel provides the service.`);

        const api: unknown = target.api;
        if (api === undefined || api === null)
            throw new Error(`TacPhone AppApi: service "${service}" did not expose an API.`);

        const fn = (api as Record<string, unknown>)[method];
        if (typeof fn !== "function")
            throw new Error(`TacPhone AppApi: service "${service}" has no method "${method}".`);

        try {
            return await (fn as (...parameters: unknown[]) => unknown).apply(api, args) as T;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`TacPhone AppApi: service "${service}" failed in "${method}": ${message}`, { cause: error });
        }
    }

    /**
     * Installs the handler policy "ask" calls to let the user pick a panel.
     * Without a handler, "ask" behaves like "auto". Pass undefined to remove it.
     */
    setTargetChooser(chooser: TargetChooser | undefined): void {
        this.targetChooser = chooser;
    }

    /** Subscribes to registration and panel changes. Returns an unsubscribe function. */
    onDidChange(listener: (services: AppServiceInfo[]) => void): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Removes one exact registration; stale or repeated calls do nothing. */
    private unregister(entry: RegistrationEntry): void {
        const byService = this.registrations.get(entry.instanceId);
        if (!byService || byService.get(entry.service) !== entry)
            return;

        byService.delete(entry.service);
        if (byService.size === 0)
            this.registrations.delete(entry.instanceId);

        this.notifyChanged();
    }

    /** Forwards a fresh service list to the listeners; listener failures are contained. */
    private notifyChanged(): void {
        // A listener may call back into the registry; one notification is enough.
        if (this.listeners.size === 0 || this.notifying)
            return;

        this.notifying = true;

        try {
            const services = this.list();

            for (const listener of [...this.listeners]) {
                try {
                    listener(services);
                } catch (error) {
                    console.error("TacPhone AppApi listener failed:", error);
                }
            }
        } finally {
            this.notifying = false;
        }
    }

    /** Subscribes to the panel directory once, so closed panels lose their registrations. */
    private ensurePanelSubscription(): void {
        if (this.unsubscribePanels)
            return;

        const directory = window.PanelDirectory;
        if (!directory)
            return;

        this.unsubscribePanels = directory.onDidChange(this.handlePanelsChanged);
    }

    /** Registered providers of a service after the panel/version/instance filters. */
    private registeredCandidates(service: string, version: number | undefined, panelId: string | undefined, instanceId: string | undefined): AppServiceInfo[] {
        let candidates = this.list(service);

        if (panelId !== undefined)
            candidates = candidates.filter(candidate => candidate.instance.panelId === panelId);

        if (instanceId !== undefined)
            candidates = candidates.filter(candidate => candidate.instance.instanceId === instanceId || candidate.instance.tabId === instanceId);

        if (version !== undefined) {
            return candidates.filter(candidate => {
                if (candidate.version === version)
                    return true;

                console.warn(`TacPhone AppApi: skipping service "${service}" version ${candidate.version}; version ${version} was requested.`);
                return false;
            });
        }

        // No explicit version: prefer the highest one, so a v2 provider wins over a v1.
        let highest = 0;
        for (const candidate of candidates) {
            if (candidate.version > highest)
                highest = candidate.version;
        }

        return highest === 0 ? candidates : candidates.filter(candidate => candidate.version === highest);
    }

    /**
     * Open panels that can provide the service, including background tabs that are
     * not mounted (and therefore not registered) yet.
     */
    private candidatePanels(service: string, version: number | undefined, panelId: string | undefined): PanelInfo[] {
        const panels = window.PanelDirectory?.list() ?? [];

        const candidates = panels.filter(panel => {
            if (panelId !== undefined)
                return panel.panelId === panelId;

            // Without a panel id only a panel that already registered the service counts.
            return panel.instanceId !== undefined && this.registrations.get(panel.instanceId)?.has(service) === true;
        });

        if (version !== undefined) {
            return candidates.filter(panel => {
                const registered = this.registrationFor(panel, service);
                if (!registered || registered.version === version)
                    return true;

                console.warn(`TacPhone AppApi: skipping panel "${panel.title || panel.tabId}" because it provides service "${service}" version ${registered.version}, not ${version}.`);
                return false;
            });
        }

        let highest = 0;
        for (const panel of candidates) {
            const registered = this.registrationFor(panel, service);
            if (registered && registered.version > highest)
                highest = registered.version;
        }

        if (highest === 0)
            return candidates;

        // Unmounted panels are kept: their version is known only once they register.
        return candidates.filter(panel => {
            const registered = this.registrationFor(panel, service);
            return !registered || registered.version === highest;
        });
    }

    /** Registration of one panel for one service, if any. */
    private registrationFor(panel: PanelInfo, service: string): RegistrationEntry | undefined {
        if (!panel.instanceId)
            return undefined;

        return this.registrations.get(panel.instanceId)?.get(service);
    }

    /** Fresh AppServiceInfo for a panel that already registered the service. */
    private registeredForPanel(service: string, panel: PanelInfo, version: number | undefined): AppServiceInfo | undefined {
        const entry = this.registrationFor(panel, service);
        if (!entry)
            return undefined;

        if (version !== undefined && entry.version !== version)
            return undefined;

        return { service: entry.service, version: entry.version, instance: panel, api: entry.api };
    }

    /** Panel snapshot for an instance id, falling back to a bare tab id. */
    private panelByInstanceOrTab(id: string): PanelInfo | undefined {
        const panels = window.PanelDirectory?.list() ?? [];
        return panels.find(panel => panel.instanceId === id) ?? panels.find(panel => panel.tabId === id);
    }

    /** Fresh AppServiceInfo of the panel that owns a tab, if it registered the service. */
    private registeredForTab(service: string, tabId: string, version: number | undefined): AppServiceInfo | undefined {
        const panel = this.panelByInstanceOrTab(tabId);
        return panel ? this.registeredForPanel(service, panel, version) : undefined;
    }

    /**
     * Candidate a policy selects: the focused panel, then the largest one.
     * `allowFirstFallback` is used by the synchronous lookup; the async path only
     * accepts a single candidate as its last resort, because guessing between
     * several panels would route to the wrong one.
     */
    private pick<T>(candidates: T[], policy: TargetPolicy, allowFirstFallback: boolean, panelOf: (candidate: T) => PanelInfo): T | undefined {
        if (candidates.length === 0)
            return undefined;

        if (policy === "first")
            return candidates[0];

        const focusedTabId = window.PanelDirectory?.focused()?.tabId;
        const focusedMatch = focusedTabId === undefined
            ? undefined
            : candidates.find(candidate => panelOf(candidate).tabId === focusedTabId);

        if (policy === "focused")
            return focusedMatch;

        const largestTabId = window.PanelDirectory?.largest()?.tabId;
        const largestMatch = largestTabId === undefined
            ? undefined
            : candidates.find(candidate => panelOf(candidate).tabId === largestTabId);

        if (policy === "largest")
            return largestMatch;

        if (focusedMatch)
            return focusedMatch;

        if (largestMatch)
            return largestMatch;

        return allowFirstFallback || candidates.length === 1 ? candidates[0] : undefined;
    }

    /** Applies the target policy, asking the host when it is "ask". */
    private async chooseTarget(service: string, candidates: PanelInfo[], target: TargetOptions, reason: string | undefined): Promise<PanelInfo | undefined> {
        const policy = target.policy ?? "auto";

        if (policy !== "ask")
            return this.pick(candidates, policy, false, panel => panel);

        const chooser = this.targetChooser;
        if (chooser) {
            let chosen: string | undefined;
            let failed = false;

            try {
                chosen = await chooser({ service, candidates, reason });
            } catch (error) {
                console.error(`TacPhone AppApi: the target chooser failed for service "${service}":`, error);
                failed = true;
            }

            if (!failed) {
                // The user cancelled: a normal outcome, not a failure of the registry.
                if (chosen === undefined)
                    return undefined;

                const match = candidates.find(candidate => candidate.instanceId === chosen || candidate.tabId === chosen);
                if (match)
                    return match;

                console.warn(`TacPhone AppApi: the target chooser returned unknown panel "${chosen}" for service "${service}"; using the automatic policy.`);
            }
        }

        return this.pick(candidates, "auto", false, panel => panel);
    }

    /**
     * Runs `check` until it returns a value or the timeout elapses, whichever comes
     * first. Uses one registry subscription and one timer; registrations and panel
     * changes both notify, so no polling loop is needed.
     */
    private waitUntil<T>(timeoutMs: number, check: () => T | undefined): Promise<T | undefined> {
        const immediate = check();
        if (immediate !== undefined)
            return Promise.resolve(immediate);

        if (timeoutMs <= 0)
            return Promise.resolve(undefined);

        return new Promise<T | undefined>(resolve => {
            let settled = false;
            let timer: number | undefined;
            let unsubscribe: () => void = () => undefined;

            const finish = (value: T | undefined): void => {
                if (settled)
                    return;

                settled = true;
                unsubscribe();

                if (timer !== undefined)
                    window.clearTimeout(timer);

                resolve(value);
            };

            unsubscribe = this.onDidChange(() => {
                let value: T | undefined;

                try {
                    value = check();
                } catch (error) {
                    console.error("TacPhone AppApi: checking a service while waiting failed:", error);
                    value = undefined;
                }

                if (value !== undefined)
                    finish(value);
            });

            // The panel may have registered between the first check and the subscription.
            const current = check();
            if (current !== undefined) {
                finish(current);
                return;
            }

            timer = window.setTimeout(() => finish(undefined), timeoutMs);
        });
    }
}

declare global {
    interface Window {
        // Inter-app service registry and target routing (see Backend/AppApi.ts).
        AppApi: AppApiRegistry;
    }
}

window.AppApi = new AppApiRegistry();
