
import React from "react";
import type { AppPanelInfo } from '../Backend/Types';
import type { PanelInstance } from '../Backend/PanelDirectory';
import styles from './AppChooserPanel.module.css'
import { AppErrorBoundary } from './AppErrorBoundary';
import { PanelContext } from './PanelContext';

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
    // The panel instance of the tab this chooser runs in; it is how the host
    // learns which app the tab shows while the tab component stays "AppChooser".
    static contextType = PanelContext;
    declare context: PanelInstance | undefined;

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
        // Restore the app that was persisted in the saved layout. The tab still
        // starts as an app chooser until the user picks something; this keeps a
        // saved phone looking the same after a reload.
        const config = this.context?.getConfig();
        if (typeof config !== "object" || config === null || Array.isArray(config))
            return;

        const panelId = (config as { panelId?: unknown }).panelId;
        if (typeof panelId !== "string" || panelId.length === 0)
            return;

        if (!window.AppDirectory.knownPanels.has(panelId))
            return;

        this.switchToApp(panelId);
    }

    componentWillUnmount() {
    }

    switchToApp(appName: string) {
        let panelInfo = window.AppDirectory.knownPanels?.get(appName);
        if (!panelInfo)
            return;

        // Report the app to the panel directory, and persist it in the tab config
        // so the layout keeps reporting it while the tab is unmounted.
        this.context?.setApp(appName);
        if (this.context)
            window.PanelDirectory.setPanelConfig(this.context.tabId, { panelId: appName });

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
