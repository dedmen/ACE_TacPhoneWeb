// oxlint-disable no-unused-vars
//import { useState } from 'react'
//import reactLogo from './assets/react.svg'
//import viteLogo from './assets/vite.svg'
//import heroImg from './assets/hero.png'
import React from 'react';
import './App.css'
import './Backend/Networking'
import './Backend/AppDirectory'
//import {CreateTacPhoneApp} from '../../ACE_TacPhone_Map'

import { Actions, AddIcon, BorderNode, DockLocation, Layout, Model, TabNode, TabSetNode, type IJsonModel, type ITabSetRenderValues } from 'flexlayout-react';
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

//const MyPanel = () => {
//    return CreateTacPhoneApp();
//};
/*
class PlayerPosPanel extends React.Component<{},{
    playerPos: Array<number>,
    time: number
}> {

    interval: number | undefined;

    constructor(props: {}) {
        super(props);
        this.state = {playerPos: [0,0,0], time: 0};  
    }
    componentDidMount() {
        //this.interval = setInterval(() => this.tick(), 2000);
    }

    componentWillUnmount() {
        clearInterval(this.interval);
    }

    
    tick() {
        window.Networking.Request({c: "GetPlayerPos"}).then(result => {
            this.setState(() => ({
                playerPos: result as Array<number>
            }));
        });

        window.Networking.Request({c: "GetTime"}).then(result => {
            this.setState(() => ({
                time: result as unknown as number
            }));
        });
    }


    render() {
        return <>
        <div style={{ padding: 16, height: '50px' }}>Player is: [{this.state.playerPos[0]},{this.state.playerPos[1]},{this.state.playerPos[2]}]</div>
        <div style={{ padding: 16, height: '50px' }}>Time is: {this.state.time}</div>
        </>
        ;
    }
};
*/
import {AppChooserPanel} from './Panels/AppChooserPanel'
import {AppErrorBoundary} from './Panels/AppErrorBoundary'
import {PanelBinding} from './Panels/PanelHost'
import {TargetChooserDialog} from './Panels/TargetChooserDialog'


class App extends React.Component<{}, {loading: boolean, error: string | undefined}> {

    private model = createLayoutModel();
    private mounted = false;

    constructor(props: {})
    {
        super(props);
        this.state = { loading: true, error: undefined };
    }

    factory = (node: TabNode) => {
        const component = node.getComponent()!;
        // The tab component is the app panel id, except for the app chooser,
        // which picks an app at runtime and reports it through setApp().
        const panelId = component === "AppChooser" ? undefined : component;

        let content: React.ReactNode;
        if (component === "AppChooser"){
            content = <AppChooserPanel />;
        } else {
            const panelInfo = window.AppDirectory.knownPanels.get(component);
            content = panelInfo
                ? (
                    <AppErrorBoundary key={node.getId()} appName={panelInfo.id}>
                        {React.createElement(panelInfo.appComponent, null)}
                    </AppErrorBoundary>
                )
                : <div>Unknown panel?? {component}/{node.getName()}</div>;
        }

        // One panel instance per mounted tab; floating popups use the same factory.
        return (
            <PanelBinding key={node.getId()} tabId={node.getId()} panelId={panelId}>
                {content}
            </PanelBinding>
        );
    }

    private loadLayoutFromGame = async (): Promise<Model | undefined> => {
        // With working localStorage the layout is already loaded in createLayoutModel().
        if (getLayoutStorage())
            return undefined;

        try {
            const layout = parseLayout(await window.Networking.Request({a: "main", c: "GetLayout"}));
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
        void window.Networking.Request({a: "main", c: "SaveLayout", layout}).catch(error => {
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

    private loadApps = async () => {
        this.setState({ loading: true, error: undefined });

        try {
            await window.Networking.WhenReady();

            const [layout] = await Promise.all([
                this.loadLayoutFromGame(),
                window.AppDirectory.LoadAvailableApps()
            ]);

            // The layout from the game replaces the model built in the
            // constructor; the directory must follow it or it reports stale rects.
            if (layout) {
                this.model = layout;
                window.PanelDirectory.attach(this.model);
            }

            if (this.mounted)
                this.setState({ loading: false, error: undefined });
        } catch (error) {
            console.error("Failed to load TacPhone apps:", error);

            if (this.mounted)
                this.setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
        }
    }

    componentDidMount(): void {
        this.mounted = true;
        // Attach before the layout renders so window.PanelDirectory is populated
        // as soon as the loading screen disappears.
        window.PanelDirectory.attach(this.model);
        void this.loadApps();
    }

    componentWillUnmount(): void {
        this.mounted = false;
        window.PanelDirectory.detach();
    }

    render() {
        if (this.state.loading)
            return <div>LOADING!</div>;

        if (this.state.error)
            return (
                <div style={{ padding: 24, color: 'white', backgroundColor: '#2a1111', height: '100vh', boxSizing: 'border-box' }}>
                    <h2>TacPhone failed to start</h2>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{this.state.error}</pre>
                    <button type="button" onClick={() => void this.loadApps()}>Retry</button>
                </div>
            );

        return (
            <>         
            <div style={{ width: '100%', height: '100vh', position: 'absolute' }}>
                <Layout
                    model={this.model}
                    factory={this.factory} 

                    onRenderTabSet={this.onRenderTabSet}
                    onModelChange={this.onLayoutChanged}
                    realtimeResize={true}
                    supportsPopout={false}
                    />
            </div>  
            {/* Installs window.AppApi's target chooser; overlays the whole phone. */}
            <TargetChooserDialog />
            </>
        )
    }

}

export default App


//#TODO keep mobile screen active https://stackoverflow.com/questions/64139507/how-to-keep-mobile-display-active-in-javascript (Settings)
//#TODO mobile fullscreen mode (hide address bar)
