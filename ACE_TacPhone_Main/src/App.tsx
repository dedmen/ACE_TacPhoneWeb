import React from 'react';
import './App.css'
// Installs window.TacPhone before the first panel renders.
import { GetTacPhoneHost } from './Backend/Host'

import { Actions, AddIcon, BorderNode, DockLocation, Layout, Model, TabNode, TabSetNode, type IJsonModel, type ITabRenderValues, type ITabSetRenderValues } from 'flexlayout-react';
import 'flexlayout-react/style/dark.css';  

const LAYOUT_STORAGE_KEY = 'tacphone.layout';

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

function parseLayout(raw: unknown): IJsonModel | undefined {
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

    const candidate = layout as Partial<IJsonModel>;
    if (typeof candidate.layout !== "object" || candidate.layout === null)
        return undefined;

    return candidate as IJsonModel;
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

const defaultLayout: IJsonModel = {
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
                        name: "One",
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
                        name: "Two",
                        component: "AppChooser",
                    }
                ]
            }
        ]
    }
};

function createLayoutModel(): Model {
    const storage = getLayoutStorage();

    if (storage) {
        try {
            const savedLayout = storage.getItem(LAYOUT_STORAGE_KEY);
            if (savedLayout) {
                const model = createModelFromLayout(parseLayout(savedLayout));
                if (model)
                    return model;
            }
        } catch (error) {
            console.warn("Failed to read the TacPhone layout from local storage.", error);
        }
    }

    return Model.fromJson(defaultLayout);
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

    constructor(props: {})
    {
        super(props);
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
            return <div>Unknown panel?? {panelId}/{node.getName()}</div>;

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
            const layout = parseLayout(await window.TacPhone.networking.Request({a: "main", c: "GetLayout"}));
            return createModelFromLayout(layout);
        } catch (error) {
            console.warn("Failed to request the TacPhone layout from the game.", error);
            return undefined;
        }
    }

    private onLayoutChanged = (model: Model) => {
        const layout = model.toJson();
        const storage = getLayoutStorage();

        if (storage) {
            try {
                storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
                return;
            } catch (error) {
                console.warn("Failed to save the TacPhone layout to local storage.", error);
            }
        }

        // Placeholder: send the layout to the game for persistence. The game currently only
        // acknowledges the request; actually storing it there will be implemented later.
        void window.TacPhone.networking.Request({a: "main", c: "SaveLayout", layout}).catch(error => {
            console.warn("Failed to send the TacPhone layout to the game.", error);
        });
    }

    onRenderTabSet = (node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
        if (node instanceof TabSetNode) {
            renderValues.stickyButtons.push(
                <button
                    key="Add"
                    title="Add"
                    className="flexlayout__tab_toolbar_button"
                    onClick={() => {
                        this.model.doAction(Actions.addTab({
                            component: "AppChooser",
                            name: "Added "
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

            const [layout] = await Promise.all([
                this.loadLayoutFromGame(),
                host.apps.LoadAvailableApps()
            ]);

            // The layout from the game replaces the model built in the
            // constructor; the directory must follow it or it reports stale rects.
            if (layout) {
                this.model = layout;
                panelDirectory.attach(this.model);
            }

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
        void this.loadApps();
    }

    componentWillUnmount(): void {
        this.mounted = false;
        panelDirectory.detach();
    }

    render() {
        if (this.state.loading)
            return <div>LOADING!</div>;

        if (this.state.error)
            return (
                <div style={{ padding: 24, color: 'white', backgroundColor: '#2a1111', height: '100%', boxSizing: 'border-box' }}>
                    <h2>TacPhone failed to start</h2>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{this.state.error}</pre>
                    <button type="button" onClick={() => void this.loadApps()}>Retry</button>
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
