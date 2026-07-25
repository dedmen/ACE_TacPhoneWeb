// oxlint-disable no-unused-vars
//import { useState } from 'react'
//import reactLogo from './assets/react.svg'
//import viteLogo from './assets/vite.svg'
//import heroImg from './assets/hero.png'
import React from 'react';
import './App.css'
import './Backend/Networking'
//import {CreateTacPhoneApp} from '../../ACE_TacPhone_Map'

import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { IsLocalDev } from './Backend/Networking';

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
        this.interval = setInterval(() => this.tick(), 100);
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


const PlayerPosPanelWrap = (_props: IDockviewPanelProps) => {
    return <PlayerPosPanel></PlayerPosPanel>;
};

const fetchExternalModule = async (name: string) => {

    // This should be same result as import(name)
    // But the module might be in different places
    // In development, module 'testModule' might be ../../testModule (A npm package, with package.json defining what we should load)
    // In Arma, it would be in A3API.RequestFile('/z/ace/addons/tacphone/apps/X.js')
    // In WebBrowser proxy mode, it would be window.Networking.LoadFile(/z/ace/addons/tacphone/apps/X.js')
    // Note in the Arma paths, we always need a lookup table, mod's modules will not all be in ace folders.

    //#TODO cache? If we loaded one once, we don't need to re-load it

    if (IsLocalDev()) {
        // Try to find it in parent folder

        //#TODO we need to make mod development a bit easier, always copying or symlinking next to our folders is a bit annoying

        //#TODO document this
        // For development, the directory that contains the app (with its package.json), must be symlinked into "devapps" folder.

        let lib = await import(`../devapps/${name}/src/main.tsx`);
        //lib.meta.url = `../devapps/${name}/src/main.tsx`;
        return lib;
    }

    // Either Arma or Web proxy, networking will handle whichever it is

    //#TODO we need a global module/app directory, where we can look up from classname to in-game path
    let content = await window.Networking.LoadGameFileText(`/z/ace/addons/tacphone/apps/${name}.js`)
    // Store it in a blob url and then return it
    let url = URL.createObjectURL(new Blob([Uint8Array.from(content, c => c.charCodeAt(0))], {type: 'application/javascript'}));
    return import(url);
}


const components : { [key: string]: any } = { /*default: MyPanel,*/ playerPos: PlayerPosPanelWrap };

class App extends React.Component {

    render() {
        const onReady = (event: DockviewReadyEvent) => {

            event.api.addPanel({ id: 'panel_1', component: 'playerPos', title: 'Player Pos', floating: false });


            window.setTimeout(() => {

            window.Networking.Request({}).then(result => console.log("result", result));

            }, 1000); // Need to wait till websocket connected


            // Dynamically load the extra component
            window.setTimeout(async () => {
                
                // Load external module
                let lib = await fetchExternalModule("ACE_TacPhone_Map");

                // Register the component to the dockview
                components["tacphone_map"] = 
                    () => {
                        return lib.CreateTacPhoneApp();
                    };

                // Add panel with the new component
                event.api.addPanel({ id: 'panel_2', component: 'tacphone_map', title: 'Map',
                    position: { referencePanel: 'panel_1', direction: 'right' }
                });
            }, 1000);

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
