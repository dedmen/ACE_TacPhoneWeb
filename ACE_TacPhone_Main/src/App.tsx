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

import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';

//const MyPanel = () => {
//    return CreateTacPhoneApp();
//};

class PlayerPosPanel extends React.Component<{},{
    playerPos: Array<number>,
    time: number
}> {

    interval: number | undefined;

    constructor(props: IDockviewPanelProps) {
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

import {AppChooserPanel} from './Panels/AppChooserPanel'


const PlayerPosPanelWrap = (_props: IDockviewPanelProps) => {
    return <PlayerPosPanel/>;
};


const AppChooserPanelWrap = (_props: IDockviewPanelProps) => {
    return <AppChooserPanel api={_props.api} containerApi={_props.containerApi} params={_props.params}/>;
};

const components : { [key: string]: any } = { /*default: MyPanel,*/ playerPos: PlayerPosPanelWrap, appChooser: AppChooserPanelWrap };

class App extends React.Component {

    render() {
        const onReady = (event: DockviewReadyEvent) => {

            event.api.addPanel({ id: 'panel_1', component: 'playerPos', title: 'Player Pos', floating: false });


            //window.setTimeout(() => {
            //    window.Networking.Request({}).then(result => console.log("result", result));
            //}, 1000); // Need to wait till websocket connected

            // Dynamically load the extra component
            window.setTimeout(async () => {
                await window.AppDirectory.LoadAvailableApps();

                event.api.addPanel({ id: 'panel_2', component: 'appChooser', title: 'Choose',
                    position: { referencePanel: 'panel_1', direction: 'right' }
                });
            }, 5000);

        };

    return (
        <>         
        <div style={{ width: '100%', height: '100vh' }}>
            <DockviewReact
                className="dockview-theme-abyss"
                onReady={onReady}
                components={components}
            />
        </div>  
        </>
    )
    }

}

export default App
