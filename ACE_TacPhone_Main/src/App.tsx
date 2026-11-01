import React from 'react';
import './App.css'
// Installs window.TacPhone before the first panel renders.
import { GetTacPhoneHost } from './Backend/Host'
import { localization } from './Backend/Localization'
import { HOST_BASE_GAME_STRINGS } from './Backend/i18n'
import { appDirectory } from './Backend/AppDirectory'
import { compressAndToBase64, decompressFromBase64 } from './Backend/Compression'
import { appOptions } from './Backend/AppOptions'

import { Actions, AddIcon, BorderNode, DockLocation, Layout, Model, TabNode, TabSetNode, type IJsonModel, type ITabRenderValues, type ITabSetRenderValues } from 'flexlayout-react';
import 'flexlayout-react/style/dark.css';  

const LAYOUT_STORAGE_KEY = 'tacphone.layout';

/** Layout changes are coalesced into at most one save per window. */
const LAYOUT_SAVE_INTERVAL_MS = 5000;

/** Option changes may come from a slider drag; save them sooner than a layout. */
const OPTIONS_SAVE_INTERVAL_MS = 300;

// localStorage is unavailable in the sandboxed in-game browser, so probe it before using it.
function getLayoutStorage(): Storage | undefined {
    try {
        const storage = window.localStorage;
        const testKey = `${LAYOUT_STORAGE_KEY}.test`;
        storage.setItem(testKey, testKey);
        storage.removeItem(testKey);
        return storage;
    } catch {
        return undefined;
    }
}

interface ParsedLayout {
    /** flexlayout model, with the options envelope removed. */
    layout: IJsonModel;
    /** Host option overrides saved next to the layout. */
    options: unknown;
}

/**
 * Parses one saved layout envelope. The `options` key is host data stored next
 * to the flexlayout JSON; it is removed before the model sees it.
 */
function parsePersistedLayout(raw: unknown): ParsedLayout | undefined {
    let layout = raw;

    if (typeof layout === "string") {
        try {
            layout = JSON.parse(layout);
        } catch (error) {
            console.warn("TacPhone layout is not valid JSON.", error);
            return undefined;
        }
    }

    if (typeof layout !== "object" || layout === null || Array.isArray(layout))
        return undefined;

    const candidate = layout as Partial<IJsonModel> & { options?: unknown };
    if (typeof candidate.layout !== "object" || candidate.layout === null)
        return undefined;

    const { options, ...model } = candidate;

    return {
        layout: model as IJsonModel,
        options,
    };
}

function createModelFromLayout(layout: IJsonModel | undefined): Model | undefined {
    if (!layout)
        return undefined;

    try {
        return Model.fromJson(layout);
    } catch (error) {
        console.warn("TacPhone layout is invalid, using the default layout.", error);
        return undefined;
    }
}

function defaultLayout(): IJsonModel {
    return {
        global: {tabEnablePopoutFloatIcon: true, tabEnablePopout: false},
        borders: [],
        layout: {
            type: "row",
            weight: 100,
            children: [
                {
                    type: "tabset",
                    weight: 50,
                    children: [
                        {
                            type: "tab",
                            name: localization.t('STR_ACE_Tacphone_Host_Tab_DefaultOne'),
                            component: "AppChooser",
                        }
                    ]
                },
                {
                    type: "tabset",
                    weight: 50,
                    children: [
                        {
                            type: "tab",
                            name: localization.t('STR_ACE_Tacphone_Host_Tab_DefaultTwo'),
                            component: "AppChooser",
                        }
                    ]
                }
            ]
        }
    };
}

function createLayoutModel(): Model {
    const storage = getLayoutStorage();

    if (storage) {
        try {
            const savedLayout = storage.getItem(LAYOUT_STORAGE_KEY);
            if (savedLayout) {
                const parsed = parsePersistedLayout(savedLayout);
                if (parsed) {
                    // Options are available before any app is loaded, so an app's
                    // init()/first mount can read its stored configuration.
                    appOptions.load(parsed.options);
                    const model = createModelFromLayout(parsed.layout);
                    if (model)
                        return model;
                }
            }
        } catch (error) {
            console.warn("Failed to read the TacPhone layout from local storage.", error);
        }
    }

    return Model.fromJson(defaultLayout());
}

import type { NotificationTapHandler, PanelInstance, TacPhoneNotification } from '@ace-tacphone/api';
import { panelDirectory } from './Backend/PanelDirectory';
import {AppChooserPanel} from './Panels/AppChooserPanel'
import {AppErrorBoundary} from './Panels/AppErrorBoundary'
import {NotificationHost} from './Panels/NotificationHost'
import {PanelBinding} from './Panels/PanelHost'
import {TargetChooserDialog} from './Panels/TargetChooserDialog'


class App extends React.Component<{}, {loading: boolean, error: string | undefined}> {

    private model = createLayoutModel();
    private mounted = false;
    /** In-flight app load; reused so StrictMode cannot load the apps twice. */
    private loadPromise: Promise<void> | undefined;
    /** JSON of the state last written, so an unchanged model does not save again. */
    private savedStateJson: string | undefined;
    /** Pending coalesced save, if any. */
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    /** Time at which the pending save is due; used to shorten a layout save. */
    private saveDeadline: number | undefined;
    /** A layout or option change happened that has not been written yet. */
    private stateDirty = false;
    /** True while an async save is in flight; new changes wait for it. */
    private saving = false;
    /** False until the initial layout/options load finished; blocks accidental overwrites. */
    private persistenceReady = false;
    /** Releases the app options subscription. */
    private unsubscribeOptions: (() => void) | undefined;
    /** Releases the localization subscription. */
    private unsubscribeLocalization: (() => void) | undefined;

    constructor(props: {})
    {
        super(props);
        this.savedStateJson = this.buildStateJson();
        this.state = { loading: true, error: undefined };
    }

    factory = (node: TabNode) => {
        const component = node.getComponent() ?? "";
        // The tab component is the app panel id, except for the app chooser,
        // which picks an app at runtime and reports it through setApp().
        const isChooser = component === "AppChooser";
        const panelId = isChooser ? undefined : component;

        // One panel instance per mounted tab; floating popups use the same factory.
        return (
            <PanelBinding key={node.getId()} tabId={node.getId()} panelId={panelId}>
                {(panel) => isChooser
                    ? <AppChooserPanel panel={panel} node={node} model={this.model} />
                    : this.renderPanelContent(panel, node, component)}
            </PanelBinding>
        );
    }

    /** Renders one app panel with the full AppProps contract. */
    private renderPanelContent(panel: PanelInstance, node: TabNode, panelId: string): React.ReactNode {
        const host = window.TacPhone;
        const panelInfo = host.apps.knownPanels.get(panelId);

        if (!panelInfo)
            return <div>{localization.t('STR_ACE_Tacphone_Host_App_UnknownPanel')} {panelId}/{node.getName()}</div>;

        const AppComponent = panelInfo.appComponent;
        const title = host.apps.getPanelMeta(panelId)?.title ?? panelId;

        return (
            <AppErrorBoundary key={panelId} appName={title}>
                <AppComponent
                    appId={host.apps.appNameForPanel(panelId) ?? panelId}
                    panelId={panelId}
                    node={node}
                    model={this.model}
                    panel={panel}
                />
            </AppErrorBoundary>
        );
    }

    /**
     * Draws the panel icon in the tab header. The host stores the resolved icon in
     * the tab config (see PanelDirectory.setIcon), which flexlayout does not know
     * about, so the leading slot is filled here. TabNode.getIcon() still wins when
     * a layout sets the flexlayout icon attribute.
     */
    onRenderTab = (node: TabNode, renderValues: ITabRenderValues) => {
        if (renderValues.leading !== undefined && renderValues.leading !== null)
            return;

        const icon = this.tabIcon(node);
        if (icon)
            renderValues.leading = <img src={icon} alt="" style={{ width: '1em', height: '1em' }} />;
    }

    /** Icon of the panel a tab runs, as cached by the app directory. */
    private tabIcon(node: TabNode): string | undefined {
        const fromAttribute = node.getIcon();
        if (typeof fromAttribute === "string" && fromAttribute.length > 0)
            return fromAttribute;

        const config: unknown = node.getConfig();
        if (typeof config === "object" && config !== null && !Array.isArray(config)) {
            const fromConfig = (config as { icon?: unknown }).icon;
            if (typeof fromConfig === "string" && fromConfig.length > 0)
                return fromConfig;
        }

        const panelId = this.tabPanelId(node);
        if (!panelId)
            return undefined;

        try {
            return window.TacPhone.apps.getPanelMeta(panelId)?.icon;
        } catch (error) {
            console.error(`TacPhone failed to read the icon of panel "${panelId}":`, error);
            return undefined;
        }
    }

    /** App panel id of a tab: its flexlayout component, or the persisted config of a chooser tab. */
    private tabPanelId(node: TabNode): string | undefined {
        const component = node.getComponent();
        if (typeof component === "string" && component.length > 0 && component !== "AppChooser")
            return component;

        const config: unknown = node.getConfig();
        if (typeof config === "object" && config !== null && !Array.isArray(config)) {
            const panelId = (config as { panelId?: unknown }).panelId;
            if (typeof panelId === "string" && panelId.length > 0)
                return panelId;
        }

        return undefined;
    }

    private loadLayoutFromGame = async (): Promise<Model | undefined> => {
        // With working localStorage the layout is already loaded in createLayoutModel().
        if (getLayoutStorage())
            return undefined;

        try {
            const stored: unknown = await window.TacPhone.networking.Request({a: "main", c: "GetLayout"});

            // The game stores the layout gzipped and base64-encoded; an empty string
            // means nothing was saved yet. An older game may answer with the JSON
            // text or an object, which parsePersistedLayout still accepts.
            if (typeof stored === "string" && stored.length === 0)
                return undefined;

            const json = typeof stored === "string"
                ? await decompressFromBase64(stored)
                : stored;

            const parsed = parsePersistedLayout(json);
            if (!parsed)
                return undefined;

            appOptions.load(parsed.options);
            return createModelFromLayout(parsed.layout);
        } catch (error) {
            console.warn("Failed to request the TacPhone layout from the game.", error);
            return undefined;
        }
    }

    /** Current saved state: the flexlayout model plus every option override. */
    private buildStateJson(): string {
        const layout = this.model.toJson() as IJsonModel & Record<string, unknown>;

        return JSON.stringify({
            ...layout,
            options: appOptions.toJson(),
        });
    }

    /**
     * Marks the saved state dirty and schedules one write. A shorter request
     * (an option change) replaces a longer pending layout save.
     */
    private scheduleSave(delay: number): void {
        this.stateDirty = true;

        if (!this.persistenceReady)
            return;

        const deadline = Date.now() + delay;
        if (this.saveTimer !== undefined) {
            if (this.saveDeadline !== undefined && this.saveDeadline <= deadline)
                return;

            clearTimeout(this.saveTimer);
        }

        this.saveDeadline = deadline;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saveDeadline = undefined;
            void this.saveState();
        }, delay);
    }

    private onLayoutChanged = () => {
        this.scheduleSave(LAYOUT_SAVE_INTERVAL_MS);
    }

    /**
     * Writes the current state once: plain JSON to localStorage when the browser
     * has it, otherwise gzipped + base64 through the game's `main` app.
     */
    private saveState = async (): Promise<void> => {
        if (!this.persistenceReady || !this.stateDirty || this.saving)
            return;

        this.saving = true;
        this.stateDirty = false;

        try {
            const json = this.buildStateJson();
            if (json === this.savedStateJson)
                return;

            this.savedStateJson = json;

            const storage = getLayoutStorage();
            if (storage) {
                try {
                    storage.setItem(LAYOUT_STORAGE_KEY, json);
                    return;
                } catch (error) {
                    console.warn("Failed to save the TacPhone layout to local storage.", error);
                }
            }

            try {
                const layout = await compressAndToBase64(json);
                await window.TacPhone.networking.Request({a: "main", c: "SaveLayout", layout});
            } catch (error) {
                // Retry on the next change instead of silently dropping the state.
                this.savedStateJson = undefined;
                console.warn("Failed to send the TacPhone layout to the game.", error);
            }
        } finally {
            this.saving = false;

            // A change made while the save was in flight gets its own write.
            if (this.stateDirty)
                this.scheduleSave(OPTIONS_SAVE_INTERVAL_MS);
        }
    }

    /** Flushes a change that is still waiting for the save window. */
    private flushPendingSave = (): void => {
        if (this.saveTimer === undefined)
            return;

        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        this.saveDeadline = undefined;
        void this.saveState();
    }

    private handlePageHide = (): void => {
        this.flushPendingSave();
    }

    onRenderTabSet = (node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
        if (node instanceof TabSetNode) {
            renderValues.stickyButtons.push(
                <button
                    key="Add"
                    title={localization.t('str_a3_cfgvehicles_modulecuratoraddeditableobjects_arguments_addcrew_values_yes')}
                    className="flexlayout__tab_toolbar_button"
                    onClick={() => {
                        this.model.doAction(Actions.addTab({
                            component: "AppChooser",
                            name: localization.t('STR_ACE_Tacphone_Host_App_AddedTab')
                        }, node.getId(), DockLocation.CENTER, -1, true));
                    }}
                ><AddIcon/></button>);
        }
    }

    /**
     * Runs a notification tap callback and logs whatever it throws or rejects:
     * one broken action must not break the host UI.
     */
    private runTapHandler = (handler: NotificationTapHandler, notification: TacPhoneNotification): void => {
        try {
            const result: unknown = handler(notification);

            if (result !== null && result !== undefined && typeof (result as { then?: unknown }).then === "function") {
                Promise.resolve(result).catch(error => {
                    console.error("TacPhone notification action failed:", error);
                });
            }
        } catch (error) {
            console.error("TacPhone notification action failed:", error);
        }
    }

    /**
     * Runs the tap action of a notification. NotificationHost dismisses the
     * notification afterwards, so this only resolves the action.
     */
    private onNotificationActivate = (notification: TacPhoneNotification): void => {
        if (typeof notification.action === "function")
            this.runTapHandler(notification.action, notification);
    }

    private loadApps = async () => {
        // StrictMode mounts, unmounts and remounts the host in development: reuse
        // the in-flight load instead of asking the game for the app list twice.
        if (this.loadPromise)
            return this.loadPromise;

        this.loadPromise = this.runLoadApps();
        return this.loadPromise;
    }

    private runLoadApps = async () => {
        this.setState({ loading: true, error: undefined });

        try {
            const host = GetTacPhoneHost();
            await host.networking.WhenReady();

            // Load the add-on stringtable before any UI asks for text. Never
            // rejects: a failed load keeps the bundled table and enables the
            // on-demand lookups.
            await host.localization.whenReady();

            // Base-game keys used by the host are not bundled; ask for them in
            // one batch before the panels render.
            await host.localization.load(HOST_BASE_GAME_STRINGS);

            const [layout] = await Promise.all([
                this.loadLayoutFromGame(),
                host.gameInfo.whenReady()
            ]);

            // The layout from the game replaces the model built in the
            // constructor; the directory must follow it or it reports stale rects.
            if (layout) {
                this.model = layout;
                panelDirectory.attach(this.model);
            }

            // Remember the state that was actually loaded, before apps run their
            // init(). An init() that changes an option then becomes a real change
            // to save instead of being mistaken for already persisted data.
            this.savedStateJson = this.buildStateJson();

            // Load apps only after the global game info is available, so every
            // app's init() can rely on window.TacPhone.gameInfo.get().
            await host.apps.LoadAvailableApps();

            this.persistenceReady = true;

            // Changes made while loading (an app init() migration, for example)
            // are now safe to persist.
            if (this.stateDirty)
                this.scheduleSave(OPTIONS_SAVE_INTERVAL_MS);

            if (this.mounted)
                this.setState({ loading: false, error: undefined });
        } catch (error) {
            console.error("Failed to load TacPhone apps:", error);

            if (this.mounted)
                this.setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
        } finally {
            // A finished load may be retried from the error screen.
            this.loadPromise = undefined;
        }
    }

    componentDidMount(): void {
        this.mounted = true;
        // Attach before the layout renders so the panel directory is populated
        // as soon as the loading screen disappears. attach() is idempotent, so a
        // StrictMode remount does not add a second listener.
        panelDirectory.attach(this.model);

        // Option values are part of the saved layout envelope. The subscription is
        // page-scoped; StrictMode removes and re-adds it with the host lifecycle.
        this.unsubscribeOptions = appOptions.onDidChange(() => {
            this.scheduleSave(OPTIONS_SAVE_INTERVAL_MS);
        });

        // Strings may arrive after the first render (on-demand lookups, app
        // stringtables); re-render so text that was still a key is replaced.
        this.unsubscribeLocalization = localization.onDidChange(() => {
            if (!this.mounted)
                return;

            // Panel titles are cached at registration; a title that was still a
            // raw key becomes readable when its translation arrives.
            appDirectory.refreshPanelTitles();
            this.forceUpdate();
        });

        window.addEventListener('pagehide', this.handlePageHide);

        void this.loadApps();
    }

    componentWillUnmount(): void {
        this.mounted = false;
        panelDirectory.detach();
        window.removeEventListener('pagehide', this.handlePageHide);

        if (this.unsubscribeOptions) {
            this.unsubscribeOptions();
            this.unsubscribeOptions = undefined;
        }

        if (this.unsubscribeLocalization) {
            this.unsubscribeLocalization();
            this.unsubscribeLocalization = undefined;
        }

        this.flushPendingSave();
    }

    render() {
        if (this.state.loading)
            return <div>{localization.t('STR_ACE_Tacphone_Host_App_Loading')}</div>;

        if (this.state.error)
            return (
                <div style={{ padding: 24, color: 'white', backgroundColor: '#2a1111', height: '100%', boxSizing: 'border-box' }}>
                    <h2>{localization.t('STR_ACE_Tacphone_Host_App_LoadFailedTitle')}</h2>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{this.state.error}</pre>
                    <button type="button" onClick={() => void this.loadApps()}>{localization.t('STR_ACE_Tacphone_Common_Retry')}</button>
                </div>
            );

        return (
            <>
            {/* Fixed to the viewport rather than `100vh`: on mobile Chrome the
                dynamic URL bar makes `100vh` taller than the visible area, the
                page becomes scrollable, and drags scroll instead of drawing. */}
            <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
                <Layout
                    model={this.model}
                    factory={this.factory} 

                    onRenderTab={this.onRenderTab}
                    onRenderTabSet={this.onRenderTabSet}
                    onModelChange={this.onLayoutChanged}
                    realtimeResize={true}
                    supportsPopout={false}
                    />
            </div>  
            {/* Installs the inter-app "ask" target chooser; overlays the whole phone. */}
            <TargetChooserDialog />
            {/* Notification banners are a fixed overlay too, so they sit outside the layout. */}
            <NotificationHost onActivate={this.onNotificationActivate} />
            </>
        )
    }

}

export default App


//#TODO keep mobile screen active https://stackoverflow.com/questions/64139507/how-to-keep-mobile-display-active-in-javascript (Settings)
//#TODO mobile fullscreen mode (hide address bar)
