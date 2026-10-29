// Host-side directory of the panels (tabs) that are currently open.
//
// Apps use `window.PanelDirectory` to enumerate the open panels, find out which
// app runs in each of them, activate one, or open a new app panel either as a
// docked tab or (the default) as a floating popup. The global is also declared
// in src/TacPhoneMain.ts, which is the source of dist/TacPhoneMain.d.ts.
//
// The exported surface is deliberately panel-library agnostic: no React import,
// and no flexlayout-react type is part of an exported interface. flexlayout is
// only used inside the implementation so the panel library can be swapped later
// without changing app code.
//
// Host lifecycle (WP2): App.tsx calls attach(model) with the model it renders
// and detach() on unmount; Panels/PanelHost.tsx calls createInstance() in the
// panel binding constructor and disposeInstance() when it unmounts.

import { Actions, DockLocation, Model, TabNode, TabSetNode } from "flexlayout-react";
import type { Action, IJsonRowNode, ILayoutType, Node as FlexNode } from "flexlayout-react";

/** Tab component used by the app chooser; such a tab has no app of its own. */
const APP_CHOOSER_COMPONENT = "AppChooser";

/** Share of the main layout covered by a default floating popup. */
const FLOAT_SIZE_RATIO = 0.6;
/** Minimum size of a default floating popup, in layout pixels. */
const FLOAT_MIN_WIDTH = 320;
const FLOAT_MIN_HEIGHT = 240;
/** Cascade applied to each consecutive popup so two popups do not overlap exactly. */
const FLOAT_CASCADE_OFFSET = 24;
const FLOAT_CASCADE_STEPS = 10;
/** Used while the main layout has not been rendered yet (its root rect is empty). */
const FALLBACK_LAYOUT_WIDTH = 800;
const FALLBACK_LAYOUT_HEIGHT = 600;

/** Rectangle in the coordinates of the layout that contains the node. */
export interface PanelRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** How PanelDirectory.open() places a new panel. */
export type PanelPlacement = "float" | "tab";

/** Options for PanelDirectory.open(). */
export interface OpenPanelOptions {
    /** "float" (default) opens a floating popup, "tab" adds a docked tab. */
    placement?: PanelPlacement;
    /** Select the new tab. Default true. */
    select?: boolean;
    /** "tab" only: target tabset id. Defaults to the active tabset, then the first one. */
    tabsetId?: string;
    /** "float" only: popup rectangle; individual fields override the default placement. */
    rect?: Partial<PanelRect>;
    /** Stored in the tab config, so it is persisted with the layout. */
    config?: unknown;
}

/** Result of a successful PanelDirectory.open(). */
export interface OpenPanelResult {
    /** Id of the created tab node. */
    tabId: string;
    /** Model.MAIN_LAYOUT_ID for "tab", the sub-layout id for "float". */
    layoutId: string;
    /** Id of the tabset that now holds the new tab. */
    tabSetId: string;
}

/** Snapshot of one open panel. */
export interface PanelInfo {
    /** Present only while the tab content is mounted, i.e. while its app is running. */
    instanceId?: string;
    /** Id of the tab node; stable across layout save/load. */
    tabId: string;
    /** Id of the tabset that holds the tab; undefined for border tabs. */
    tabSetId?: string;
    /** Main layout id or the id of a floating/window sub-layout. */
    layoutId: string;
    /** AppPanelInfo.id; undefined for an unassigned app chooser tab. */
    panelId?: string;
    /** AppDirectory app name that owns panelId. */
    appName?: string;
    /** Tab title (a user rename wins), falling back to the panel default title. */
    title: string;
    /** True while a PanelInstance exists for this tab, i.e. its app content is running. */
    mounted: boolean;
    /** True when this is the selected tab of its tabset. */
    isSelected: boolean;
    /** True when this tab's tabset is the active/focused tabset of its layout. */
    isActive: boolean;
    /** True while the tab content is rendered. */
    isVisible: boolean;
    /** True when the panel lives in a floating popup sub-layout. */
    isFloating: boolean;
    /** True when the panel lives in a native window popout sub-layout (not supported in game). */
    isPoppedOut: boolean;
    /** Rect of the tabset in the coordinates of its own layout. */
    rect: PanelRect;
    /** rect.width * rect.height. */
    area: number;
}

/**
 * Live handle for one mounted app content, delivered to apps through the
 * PanelContext. API registration goes through window.AppApi, not through this
 * handle, to keep the two modules decoupled.
 */
export interface PanelInstance {
    /** Host counter id, e.g. "panel-7"; new on every mount. */
    readonly instanceId: string;
    /** Tab the content is rendered in. */
    readonly tabId: string;
    /** Current snapshot of this panel. */
    getInfo(): PanelInfo;
    /** Persisted config of the tab, as stored in the saved layout. */
    getConfig(): unknown;
    /** Selects the tab and focuses its tabset (and brings a popup to the front). */
    activate(): boolean;
    /** Switches the app shown in the tab; undefined means "no app assigned". */
    setApp(panelId: string | undefined): void;
}

interface InstanceRecord {
    instanceId: string;
    tabId: string;
    /** Override set through PanelInstance.setApp(); undefined means "use the tab". */
    panelId: string | undefined;
    handle: PanelInstance;
}

function toPanelRect(rect: { x: number; y: number; width: number; height: number } | undefined): PanelRect {
    if (!rect)
        return { x: 0, y: 0, width: 0, height: 0 };

    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function newTabId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
        return crypto.randomUUID();

    return `panel-tab-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

function tabTitle(tab: TabNode): string {
    const name: unknown = tab.getName();
    return typeof name === "string" ? name : "";
}

/**
 * Resolves the app panel id of a tab: the live instance override wins, then the
 * tab component (unless it is the app chooser), then the persisted tab config.
 */
function tabPanelId(tab: TabNode): string | undefined {
    const component: unknown = tab.getComponent();
    if (typeof component === "string" && component.length > 0 && component !== APP_CHOOSER_COMPONENT)
        return component;

    const config: unknown = tab.getConfig();
    if (typeof config === "object" && config !== null && !Array.isArray(config)) {
        const panelId = (config as { panelId?: unknown }).panelId;
        if (typeof panelId === "string" && panelId.length > 0)
            return panelId;
    }

    return undefined;
}

/** Deterministic "is this panel bigger" comparison: area, then top-left reading order. */
function isBiggerPanel(candidate: PanelInfo, current: PanelInfo): boolean {
    if (candidate.area !== current.area)
        return candidate.area > current.area;

    if (candidate.rect.y !== current.rect.y)
        return candidate.rect.y < current.rect.y;

    if (candidate.rect.x !== current.rect.x)
        return candidate.rect.x < current.rect.x;

    return candidate.tabId < current.tabId;
}

/** Minimal snapshot for an instance whose tab no longer exists (or no model is attached). */
function orphanInfo(tabId: string): PanelInfo {
    return {
        tabId,
        layoutId: Model.MAIN_LAYOUT_ID,
        title: "",
        mounted: false,
        isSelected: false,
        isActive: false,
        isVisible: false,
        isFloating: false,
        isPoppedOut: false,
        rect: toPanelRect(undefined),
        area: 0
    };
}

/** The handle an app receives through PanelContext; keeps the directory as the single source of truth. */
class PanelInstanceHandle implements PanelInstance {
    readonly instanceId: string;
    readonly tabId: string;

    private readonly directory: PanelDirectory;

    constructor(directory: PanelDirectory, instanceId: string, tabId: string) {
        this.directory = directory;
        this.instanceId = instanceId;
        this.tabId = tabId;
    }

    /** Current snapshot of this panel. */
    getInfo(): PanelInfo {
        return this.directory.get(this.instanceId) ?? orphanInfo(this.tabId);
    }

    /** Persisted config of the tab, as stored in the saved layout. */
    getConfig(): unknown {
        return this.directory.getPanelConfig(this.tabId);
    }

    /** Selects the tab and focuses its tabset. */
    activate(): boolean {
        return this.directory.activate(this.instanceId);
    }

    /** Switches the app shown in the tab. */
    setApp(panelId: string | undefined): void {
        this.directory.setPanelId(this.instanceId, panelId);
    }
}

/**
 * Directory of the open panels of the current layout.
 *
 * One instance lives at module scope as `window.PanelDirectory`; the host
 * attaches the flexlayout model it renders to it, and apps read the panel list
 * from it. Every method is safe to call before a model is attached.
 */
export class PanelDirectory {
    private model: Model | undefined;
    private readonly listeners = new Set<(panels: PanelInfo[]) => void>();
    private readonly instances = new Map<string, InstanceRecord>();
    private readonly instanceByTab = new Map<string, string>();
    private instanceCounter = 0;
    private lastFocusedTabId: string | undefined;
    private subLayoutTypes: Map<string, ILayoutType> | undefined;
    private notifyHandle: number | undefined;
    private resizeListening = false;
    private notifying = false;
    private floatCascade = 0;

    private readonly handleModelChange = (action: Action): void => {
        this.trackFocus(action);
        this.invalidateSubLayouts();
        this.scheduleNotify();
    };

    private readonly handleWindowResize = (): void => {
        this.scheduleNotify();
    };

    /**
     * Attaches the directory to the layout model. Detaches the previous model
     * first, so calling this twice with the same model does not add duplicate
     * listeners.
     *
     * Host-only. The parameter is typed as `unknown` on purpose: the public
     * declaration must not leak the panel library's `Model` type into app
     * types. Pass the flexlayout `Model` instance the host renders.
     */
    attach(model: unknown): void {
        const layout = model as Model;

        if (this.model === layout)
            return;

        this.detach();

        this.model = layout;
        this.invalidateSubLayouts();
        layout.addChangeListener(this.handleModelChange);

        if (!this.resizeListening) {
            window.addEventListener("resize", this.handleWindowResize);
            this.resizeListening = true;
        }

        this.notifyChanged();
    }

    /** Stops listening to the layout model and to window resizes. Instances are kept. */
    detach(): void {
        if (this.model) {
            this.model.removeChangeListener(this.handleModelChange);
            this.model = undefined;
        }

        if (this.resizeListening) {
            window.removeEventListener("resize", this.handleWindowResize);
            this.resizeListening = false;
        }

        this.cancelScheduledNotify();
        this.invalidateSubLayouts();
        this.lastFocusedTabId = undefined;
    }

    /** Every open panel: the main layout, its borders, and every floating/window sub-layout. */
    list(): PanelInfo[] {
        const model = this.model;
        if (!model)
            return [];

        const layoutTypes = this.subLayouts();
        const tabs: TabNode[] = [];
        const seen = new Set<string>();

        const collect = (node: FlexNode): void => {
            if (!(node instanceof TabNode) || seen.has(node.getId()))
                return;

            seen.add(node.getId());
            tabs.push(node);
        };

        // visitNodes() currently walks every layout; the explicit per-layout pass keeps
        // this correct if that ever narrows to the main layout only.
        model.visitNodes(collect);
        for (const layoutId of layoutTypes.keys())
            model.visitLayoutNodes(layoutId, collect);

        return tabs.map(tab => this.describe(tab, layoutTypes));
    }

    /** Snapshot of the panel of one mounted instance. */
    get(instanceId: string): PanelInfo | undefined {
        return this.list().find(panel => panel.instanceId === instanceId);
    }

    /** Every panel that runs the given app panel id, in no particular order. */
    find(panelId: string): PanelInfo[] {
        return this.list().filter(panel => panel.panelId === panelId);
    }

    /**
     * The last focused tab, following the user across the main layout and the
     * floating popups. Falls back to the active tabset of the main layout, then
     * to any active tabset, then to the first selected panel.
     */
    focused(): PanelInfo | undefined {
        const panels = this.list();
        if (panels.length === 0)
            return undefined;

        const lastFocused = this.lastFocusedTabId;
        if (lastFocused) {
            const match = panels.find(panel => panel.tabId === lastFocused);
            if (match)
                return match;
        }

        const byActiveTabset = (layoutId: string): PanelInfo | undefined => {
            const selectedTabId = this.model?.getActiveTabset(layoutId)?.getSelectedNode()?.getId();
            if (!selectedTabId)
                return undefined;

            return panels.find(panel => panel.tabId === selectedTabId);
        };

        const main = byActiveTabset(Model.MAIN_LAYOUT_ID);
        if (main)
            return main;

        const active = panels.find(panel => panel.isActive && panel.isSelected);
        if (active)
            return active;

        return panels.find(panel => panel.isSelected) ?? panels[0];
    }

    /**
     * The biggest panel of the main layout, optionally restricted to one app
     * panel id. Floating popups are excluded in this pass (D5): areas of separate
     * layouts are not comparable.
     */
    largest(panelId?: string): PanelInfo | undefined {
        let biggest: PanelInfo | undefined;

        for (const panel of this.list()) {
            if (panel.isFloating || panel.isPoppedOut || panel.area <= 0)
                continue;

            if (panelId !== undefined && panel.panelId !== panelId)
                continue;

            if (!biggest || isBiggerPanel(panel, biggest))
                biggest = panel;
        }

        return biggest;
    }

    /**
     * Selects the tab of the given instance and makes its tabset active, bringing
     * a floating popup to the front. Returns false for an unknown id instead of
     * throwing; a tab id is accepted as a convenience when it has no instance yet.
     */
    activate(instanceId: string): boolean {
        const model = this.model;
        if (!model)
            return false;

        const tab = this.resolveTab(model, instanceId);
        if (!tab)
            return false;

        const layoutId = tab.getLayoutId();
        const parent = tab.getParent();
        const tabSetId = parent instanceof TabSetNode ? parent.getId() : undefined;

        try {
            if (layoutId !== Model.MAIN_LAYOUT_ID)
                model.doAction(Actions.movePopoutToFront(layoutId));

            model.doAction(Actions.selectTab(tab.getId()));

            if (tabSetId)
                model.doAction(Actions.setActiveTabset(tabSetId, layoutId));
        } catch (error) {
            console.error(`TacPhone failed to activate panel "${instanceId}":`, error);
            return false;
        }

        this.lastFocusedTabId = tab.getId();
        this.notifyChanged();
        return true;
    }

    /**
     * Opens the given app panel. Placement defaults to a centered floating popup
     * ("float"); "tab" adds a docked tab instead. Returns undefined for an unknown
     * panel id or when no model is attached.
     */
    open(panelId: string, options: OpenPanelOptions = {}): OpenPanelResult | undefined {
        const model = this.model;
        if (!model) {
            console.warn(`TacPhone cannot open panel "${panelId}": no layout model is attached.`);
            return undefined;
        }

        const panel = window.AppDirectory?.knownPanels?.get(panelId);
        if (!panel) {
            console.warn(`TacPhone cannot open unknown panel "${panelId}".`);
            return undefined;
        }

        const title = this.defaultTitle(panelId) || panelId;
        const select = options.select ?? true;

        try {
            if ((options.placement ?? "float") === "float")
                return this.openFloat(model, panelId, title, options, select);

            return this.openTab(model, panelId, title, options, select);
        } catch (error) {
            console.error(`TacPhone failed to open panel "${panelId}":`, error);
            return undefined;
        }
    }

    /** Subscribes to panel changes. Returns an unsubscribe function. */
    onDidChange(listener: (panels: PanelInfo[]) => void): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Creates the runtime instance for a mounting tab and returns its handle.
     * Called by the host's panel binding, never by apps.
     */
    createInstance(tabId: string, panelId?: string): PanelInstance {
        const previousInstanceId = this.instanceByTab.get(tabId);
        if (previousInstanceId) {
            console.warn(`TacPhone panel tab "${tabId}" already has an instance; replacing it.`);
            this.disposeInstance(previousInstanceId);
        }

        const instanceId = `panel-${++this.instanceCounter}`;
        const handle = new PanelInstanceHandle(this, instanceId, tabId);

        this.instances.set(instanceId, { instanceId, tabId, panelId, handle });
        this.instanceByTab.set(tabId, instanceId);
        this.notifyChanged();

        return handle;
    }

    /** Removes the runtime instance of an unmounting tab. Unknown ids are ignored. */
    disposeInstance(instanceId: string): void {
        const record = this.instances.get(instanceId);
        if (!record)
            return;

        this.instances.delete(instanceId);

        if (this.instanceByTab.get(record.tabId) === instanceId)
            this.instanceByTab.delete(record.tabId);

        this.notifyChanged();
    }

    /** Sets the app panel id an instance shows; used when a tab switches app. */
    setPanelId(instanceId: string, panelId: string | undefined): void {
        const record = this.instances.get(instanceId);
        if (!record || record.panelId === panelId)
            return;

        record.panelId = panelId;
        this.notifyChanged();
    }

    /**
     * Returns the persisted config of a tab, or undefined when the tab/model is
     * unknown. Used by the app chooser to restore the app of a saved layout.
     */
    getPanelConfig(tabId: string): unknown {
        const node = this.model?.getNodeById(tabId);
        if (!(node instanceof TabNode))
            return undefined;

        return node.getConfig();
    }

    /**
     * Stores the config of a tab in the layout model. The host's app chooser uses
     * this to persist which app its tab runs, so the panel directory can report
     * (and a restored layout can keep) an app that is not mounted. Unknown tab
     * ids are ignored.
     */
    setPanelConfig(tabId: string, config: unknown): void {
        const model = this.model;
        if (!model)
            return;

        if (!(model.getNodeById(tabId) instanceof TabNode))
            return;

        try {
            model.doAction(Actions.updateNodeAttributes(tabId, { config }));
        } catch (error) {
            console.error(`TacPhone failed to update the config of tab "${tabId}":`, error);
        }
    }

    /** Notifies every listener with a fresh panel list. Listener failures are contained. */
    notifyChanged(): void {
        if (this.listeners.size === 0)
            return;

        // A listener may call back into the directory; one notification is enough.
        if (this.notifying)
            return;

        this.cancelScheduledNotify();
        this.notifying = true;

        try {
            const panels = this.list();

            for (const listener of [...this.listeners]) {
                try {
                    listener(panels);
                } catch (error) {
                    console.error("TacPhone panel directory listener failed:", error);
                }
            }
        } finally {
            this.notifying = false;
        }
    }

    private describe(tab: TabNode, layoutTypes: Map<string, ILayoutType>): PanelInfo {
        const tabId = tab.getId();
        const layoutId = tab.getLayoutId();
        const layoutType = layoutId === Model.MAIN_LAYOUT_ID ? undefined : layoutTypes.get(layoutId);
        const parent = tab.getParent();
        const tabSet = parent instanceof TabSetNode ? parent : undefined;
        const instanceId = this.instanceByTab.get(tabId);
        const instance = instanceId ? this.instances.get(instanceId) : undefined;
        const panelId = instance?.panelId ?? tabPanelId(tab);
        const rect = toPanelRect(parent?.getRect());

        return {
            instanceId,
            tabId,
            tabSetId: tabSet?.getId(),
            layoutId,
            panelId,
            appName: panelId ? this.appNameForPanel(panelId) : undefined,
            title: tabTitle(tab) || this.defaultTitle(panelId),
            mounted: instance !== undefined,
            isSelected: tab.isSelected(),
            isActive: tabSet ? tabSet.isActive() : false,
            isVisible: tab.isVisible() === true,
            isFloating: layoutType === "float",
            isPoppedOut: layoutType === "window",
            rect,
            area: rect.width * rect.height
        };
    }

    private openFloat(model: Model, panelId: string, title: string, options: OpenPanelOptions, select: boolean): OpenPanelResult {
        const tabId = newTabId();
        const rect = this.nextFloatRect(model, options.rect);

        const layout: IJsonRowNode = {
            type: "row",
            children: [{
                type: "tabset",
                children: [{
                    type: "tab",
                    id: tabId,
                    component: panelId,
                    name: title,
                    config: options.config
                }]
            }]
        };

        const layoutId = model.doAction(Actions.createSubLayout(layout, rect, "float")) as string;
        const parent = model.getNodeById(tabId)?.getParent();
        const tabSetId = parent instanceof TabSetNode ? parent.getId() : "";

        if (select) {
            model.doAction(Actions.selectTab(tabId));
            if (tabSetId)
                model.doAction(Actions.setActiveTabset(tabSetId, layoutId));

            this.lastFocusedTabId = tabId;
        }

        model.doAction(Actions.movePopoutToFront(layoutId));
        this.invalidateSubLayouts();
        this.notifyChanged();

        return { tabId, layoutId, tabSetId };
    }

    private openTab(model: Model, panelId: string, title: string, options: OpenPanelOptions, select: boolean): OpenPanelResult {
        const tabId = newTabId();
        const tabSetId = this.resolveTabSetId(model, options.tabsetId);

        model.doAction(Actions.addTab({
            id: tabId,
            component: panelId,
            name: title,
            config: options.config
        }, tabSetId, DockLocation.CENTER, -1, select));

        if (select)
            this.lastFocusedTabId = tabId;

        this.notifyChanged();

        return { tabId, layoutId: Model.MAIN_LAYOUT_ID, tabSetId };
    }

    private resolveTabSetId(model: Model, requested: string | undefined): string {
        if (requested) {
            const node = model.getNodeById(requested);
            if (node instanceof TabSetNode)
                return requested;

            console.warn(`TacPhone panel target "${requested}" is not a tabset; using the active tabset instead.`);
        }

        const active = model.getActiveTabset();
        if (active)
            return active.getId();

        const first = model.getFirstTabSet();
        if (first)
            return first.getId();

        const root = model.getRootRow();
        if (root)
            return root.getId();

        throw new Error("the layout model has no root row");
    }

    /**
     * Default rectangle of a floating popup: centered, 60% of the main layout,
     * at least 320x240, clamped to the main layout, cascaded for every consecutive
     * popup, with caller-supplied fields applied last.
     */
    private nextFloatRect(model: Model, overrides: Partial<PanelRect> | undefined): PanelRect {
        const root = model.getRootRow()?.getRect();
        const main: PanelRect = root && root.width > 0 && root.height > 0
            ? { x: Math.round(root.x), y: Math.round(root.y), width: Math.round(root.width), height: Math.round(root.height) }
            : { x: 0, y: 0, width: FALLBACK_LAYOUT_WIDTH, height: FALLBACK_LAYOUT_HEIGHT };

        const width = Math.min(main.width, Math.max(FLOAT_MIN_WIDTH, Math.round(main.width * FLOAT_SIZE_RATIO)));
        const height = Math.min(main.height, Math.max(FLOAT_MIN_HEIGHT, Math.round(main.height * FLOAT_SIZE_RATIO)));

        const cascade = (this.floatCascade % FLOAT_CASCADE_STEPS) * FLOAT_CASCADE_OFFSET;
        this.floatCascade += 1;

        const rect: PanelRect = {
            x: Math.round(main.x + (main.width - width) / 2) + cascade,
            y: Math.round(main.y + (main.height - height) / 2) + cascade,
            width,
            height
        };

        if (typeof overrides?.x === "number")
            rect.x = overrides.x;
        if (typeof overrides?.y === "number")
            rect.y = overrides.y;
        if (typeof overrides?.width === "number")
            rect.width = overrides.width;
        if (typeof overrides?.height === "number")
            rect.height = overrides.height;

        // Keep the popup inside the main layout: the in-game browser has a small viewport.
        rect.width = Math.min(Math.max(1, Math.round(rect.width)), main.width);
        rect.height = Math.min(Math.max(1, Math.round(rect.height)), main.height);
        rect.x = Math.min(Math.max(rect.x, main.x), main.x + main.width - rect.width);
        rect.y = Math.min(Math.max(rect.y, main.y), main.y + main.height - rect.height);

        return rect;
    }

    private resolveTab(model: Model, id: string): TabNode | undefined {
        // Instance ids are the public handle; a tab id is accepted for tabs that are not mounted.
        const instance = this.instances.get(id);
        const node = model.getNodeById(instance ? instance.tabId : id);
        return node instanceof TabNode ? node : undefined;
    }

    private trackFocus(action: Action): void {
        const model = this.model;
        if (!model)
            return;

        if (action.type === Actions.SELECT_TAB) {
            const tabId: unknown = action.data?.tabNode;
            if (typeof tabId === "string")
                this.lastFocusedTabId = tabId;

            return;
        }

        if (action.type !== Actions.SET_ACTIVE_TABSET)
            return;

        const tabSetId: unknown = action.data?.tabsetNode;
        if (typeof tabSetId !== "string")
            return;

        const tabSet = model.getNodeById(tabSetId);
        const selected = tabSet instanceof TabSetNode ? tabSet.getSelectedNode() : undefined;
        if (selected instanceof TabNode)
            this.lastFocusedTabId = selected.getId();
    }

    /**
     * Layout type per sub-layout id, keyed as in model.toJson().subLayouts.
     * flexlayout has no public "get layout ids" call, so this is cached per model
     * change instead of being recomputed for every list().
     */
    private subLayouts(): Map<string, ILayoutType> {
        if (this.subLayoutTypes)
            return this.subLayoutTypes;

        const types = new Map<string, ILayoutType>();
        const model = this.model;

        if (model) {
            try {
                const subLayouts = model.toJson().subLayouts;
                if (subLayouts) {
                    for (const layoutId of Object.keys(subLayouts))
                        types.set(layoutId, subLayouts[layoutId].type ?? "float");
                }
            } catch (error) {
                console.error("TacPhone failed to read the layout sub-layouts:", error);
            }
        }

        this.subLayoutTypes = types;
        return types;
    }

    private invalidateSubLayouts(): void {
        this.subLayoutTypes = undefined;
    }

    private appNameForPanel(panelId: string): string | undefined {
        try {
            return window.AppDirectory?.appNameForPanel(panelId);
        } catch (error) {
            console.error(`TacPhone failed to resolve the app of panel "${panelId}":`, error);
            return undefined;
        }
    }

    private defaultTitle(panelId: string | undefined): string {
        if (!panelId)
            return "";

        const panel = window.AppDirectory?.knownPanels?.get(panelId);
        if (!panel)
            return "";

        try {
            const title: unknown = panel.GetDefaultTitle();
            return typeof title === "string" ? title : "";
        } catch (error) {
            console.error(`TacPhone panel "${panelId}" failed in GetDefaultTitle():`, error);
            return "";
        }
    }

    /** Model-driven notifications are rAF-throttled so a splitter drag does not spam apps. */
    private scheduleNotify(): void {
        if (this.notifyHandle !== undefined)
            return;

        this.notifyHandle = window.requestAnimationFrame(() => {
            this.notifyHandle = undefined;
            this.notifyChanged();
        });
    }

    private cancelScheduledNotify(): void {
        if (this.notifyHandle === undefined)
            return;

        window.cancelAnimationFrame(this.notifyHandle);
        this.notifyHandle = undefined;
    }
}

declare global {
    interface Window {
        // Panel directory of the current layout. App.tsx attaches the model (WP2).
        PanelDirectory: PanelDirectory;
    }
}

window.PanelDirectory = new PanelDirectory();
