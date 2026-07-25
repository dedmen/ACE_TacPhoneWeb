import type { IDockviewPanelProps } from "dockview-react";
import React from "react";
import styles from './AppChooserPanel.module.css'

// The main component in all panels.
// At start it displays a selector of possible apps, after selecting one it switches into the app, then the panel "becomes" the app

export class AppChooserPanel extends React.Component<{},{
    activeElement : React.JSX.Element | undefined
}> {
    props: IDockviewPanelProps;
    //activeElement : React.ComponentClass;
    activeElement : React.ReactNode;

    constructor(props: IDockviewPanelProps) {
        super(props);
        this.props = props;
        this.state = {activeElement: undefined}; 

        let knownPanels = window.AppDirectory.knownPanels;
        this.activeElement = <>
            <div className={`${styles.AppsPanel}`}>
                {[...knownPanels!.entries()].map(([key, value]) => (
                   <div className={`${styles.AppElement}`} key={key} onClick={() => this.switchToApp(key)}>
                            <img src={value.GetTacPhoneIcon()}></img>
                            {value.GetDefaultTitle()}
                    </div>
                ))}
            </div>
        </>;
    }

    componentDidMount() {
        if (typeof this.props.params.activeApp === "string")
            this.switchToApp(this.props.params.activeApp);
    }

    componentWillUnmount() {
    }

    switchToApp(appName: string) {
        this.props.api.updateParameters({activeApp: appName});
        let panelInfo = window.AppDirectory.knownPanels?.get(appName);
        if (!panelInfo)
            return;
        
        console.log("creating", panelInfo.appComponent);

        // I tried doing this using setState, setState handler was called twice, and the app was created twice.. But forceUpdate instead works
        this.activeElement = React.createElement(panelInfo.appComponent, null);
        this.forceUpdate();

        //window.AppDirectory.knownPanels?.get(panelName)?.CreateApp().then(el =>
        //    this.setState(() => ({
        //        activeElement: el
        //    }))
        //);
    }

    render() {
        return this.activeElement;
    }
};