
import React from "react";
import styles from './AppChooserPanel.module.css'
import { AppErrorBoundary } from './AppErrorBoundary';

function getPanelString(panel: AppPanelInfo, getter: "GetTacPhoneIcon" | "GetDefaultTitle", fallback: string): string {
    try {
        const value = panel[getter]();
        return typeof value === "string" ? value : fallback;
    } catch (error) {
        console.error(`TacPhone panel "${panel.id}" failed in ${getter}():`, error);
        return fallback;
    }
}

// The main component in all panels.
// At start it displays a selector of possible apps, after selecting one it switches into the app, then the panel "becomes" the app

export class AppChooserPanel extends React.Component<{},{
    activeElement : React.JSX.Element | undefined
}> {
    activeElement : React.ReactNode;

    constructor(props: {}) {
        super(props);
        this.state = {activeElement: undefined}; 

        let knownPanels = window.AppDirectory.knownPanels;
        let failedApps = window.AppDirectory.failedApps;

        this.activeElement = <>
            <div className={`${styles.AppsPanel}`}>
                {[...knownPanels.entries()].map(([key, value]) => {
                    const icon = getPanelString(value, "GetTacPhoneIcon", "");

                    return (
                        <div className={`${styles.AppElement}`} key={key} onClick={() => this.switchToApp(key)}>
                            {icon ? <img src={icon} alt="" /> : null}
                            {getPanelString(value, "GetDefaultTitle", key)}
                        </div>
                    );
                })}
                {[...failedApps.entries()].map(([key, error]) => (
                    <div className={`${styles.AppElement} ${styles.AppElementFailed}`} key={`failed-${key}`} title={error}>
                        <span className={styles.FailedAppIcon}>!</span>
                        {key}
                        <span className={styles.FailedAppError}>{error}</span>
                    </div>
                ))}
            </div>
        </>;
    }

    componentDidMount() {
        //#TODO load from model?
        //    this.switchToApp(this.props.params.activeApp);
    }

    componentWillUnmount() {
    }

    switchToApp(appName: string) {
        let panelInfo = window.AppDirectory.knownPanels?.get(appName);
        if (!panelInfo)
            return;
        
        console.log("creating", panelInfo.appComponent);

        // I tried doing this using setState, setState handler was called twice, and the app was created twice.. But forceUpdate instead works
        this.activeElement = (
            <AppErrorBoundary key={appName} appName={getPanelString(panelInfo, "GetDefaultTitle", appName)}>
                {React.createElement(panelInfo.appComponent, null)}
            </AppErrorBoundary>
        );
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
