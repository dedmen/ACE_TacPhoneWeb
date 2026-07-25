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

import { Actions, AddIcon, BorderNode, DockLocation, Layout, Model, TabNode, TabSetNode, type ITabSetRenderValues } from 'flexlayout-react';
import 'flexlayout-react/style/dark.css';  

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


class App extends React.Component<{}, {loading: boolean}> {

    constructor(props: {})
    {
        super(props);
        this.state = { loading: true};
    }

    factory = (node: TabNode) => {
        const component = node.getComponent()!;

        if (component === "AppChooser"){
            return <AppChooserPanel />;
        }

        let knownPanels = window.AppDirectory.knownPanels;
        let panelInfo = knownPanels.get(component);
        if (panelInfo)
            return React.createElement(panelInfo.appComponent, null);

        return <div>Unknown panel?? {component}/{node.getName()}</div>;
    }

    componentDidMount(): void {

        //#TODO we want to wait for networking to be connected
        window.setTimeout(async () => {
            await window.AppDirectory.LoadAvailableApps();

            this.setState({ loading: false })
        }, 500);
    }

    render() {
        if (this.state.loading)
            return <div>LOADING!</div>;


        const json = {
            global: {tabEnablePopoutFloatIcon: true},
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

        const model = Model.fromJson(json);

        const onRenderTabSet = (node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
            if (node instanceof TabSetNode) {
                renderValues.stickyButtons.push(
                    <button
                        key="Add"
                        title="Add"
                        className="flexlayout__tab_toolbar_button"
                        onClick={() => {
                            model.doAction(Actions.addTab({
                                component: "AppChooser",
                                name: "Added "
                            }, node.getId(), DockLocation.CENTER, -1, true));
                        }}
                    ><AddIcon/></button>);
            }
        }

        // model.doAction(Actions.)

        return (
            <>         
            <div style={{ width: '100%', height: '100vh', position: 'absolute' }}>
                <Layout
                    model={model}
                    factory={this.factory} 
                    
                    onRenderTabSet={onRenderTabSet}
                    realtimeResize={true}
                    />
            </div>  
            </>
        )
    }

}

export default App


//#TODO keep mobile screen active https://stackoverflow.com/questions/64139507/how-to-keep-mobile-display-active-in-javascript (Settings)
//#TODO mobile fullscreen mode (hide address bar)
