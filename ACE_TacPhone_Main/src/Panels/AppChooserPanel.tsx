// The tab content every unassigned tab starts with: an app chooser.
//
// Once the user picks an app, the tab "becomes" that app: the choice lives in
// this component's state and in the tab config, so the saved layout restores it
// even while the tab is unmounted, and the flexlayout component stays
// "AppChooser".
//
// StrictMode note: the selection is plain state (no instance field, no
// forceUpdate), the state updater is pure, and every host call (setApp,
// setTitle, setIcon, config persistence) is idempotent, so a double mount in
// development does not create the app twice.

import React from "react";
import type {
    AppPanelInfo,
    PanelInstance,
    PanelMeta,
    TacPhoneHost,
} from "@ace-tacphone/api";
import styles from './AppChooserPanel.module.css'
import { AppErrorBoundary } from './AppErrorBoundary';
import { panelDirectory } from '../Backend/PanelDirectory';

export type AppChooserPanelProps = {
    /** Live handle of the tab this chooser runs in. */
    panel: PanelInstance;
    /** flexlayout TabNode of this tab. */
    node: unknown;
    /** flexlayout Model that holds the tab. */
    model: unknown;
};

type AppChooserPanelState = {
    /** App panel id this tab runs; undefined while the chooser is shown. */
    activeApp: string | undefined;
};

function getHost(): TacPhoneHost {
    return window.TacPhone;
}

/** Reads the persisted `panelId` out of a tab config. */
function readPanelId(config: unknown): string | undefined {
    if (typeof config !== "object" || config === null || Array.isArray(config))
        return undefined;

    const panelId = (config as { panelId?: unknown }).panelId;
    return typeof panelId === "string" && panelId.length > 0 ? panelId : undefined;
}

/**
 * Initial app of a tab, taken from its persisted config in the state
 * initializer so a restored layout renders the app on the first paint.
 */
function configuredPanelId(panel: PanelInstance): string | undefined {
    const panelId = readPanelId(panel.getConfig());
    if (!panelId)
        return undefined;

    return getHost().apps.knownPanels.has(panelId) ? panelId : undefined;
}

export class AppChooserPanel extends React.Component<AppChooserPanelProps, AppChooserPanelState> {
    state: AppChooserPanelState = { activeApp: configuredPanelId(this.props.panel) };

    /** Cached display data of one panel, or undefined when the host does not know it. */
    private panelMeta(panelId: string): PanelMeta | undefined {
        try {
            return getHost().apps.getPanelMeta(panelId);
        } catch (error) {
            console.error(`TacPhone failed to read the metadata of panel "${panelId}":`, error);
            return undefined;
        }
    }

    /** Default title of a panel: cached metadata first, then the panel itself. */
    private defaultTitle(panelId: string): string {
        const meta = this.panelMeta(panelId);
        if (meta?.title)
            return meta.title;

        const panel = getHost().apps.knownPanels.get(panelId);
        if (!panel)
            return panelId;

        try {
            const title = panel.GetDefaultTitle?.();
            return typeof title === "string" && title.length > 0 ? title : panelId;
        } catch (error) {
            console.error(`TacPhone panel "${panelId}" failed in GetDefaultTitle():`, error);
            return panelId;
        }
    }

    /** One entry per selectable panel: cached metadata, with the panel as a fallback. */
    private panelEntries(): PanelMeta[] {
        const apps = getHost().apps;

        try {
            const listed = apps.listPanels();
            if (listed.length > 0)
                return listed;
        } catch (error) {
            console.error("TacPhone failed to list the available panels:", error);
        }

        return [...apps.knownPanels.keys()].map(panelId => ({
            id: panelId,
            appName: apps.appNameForPanel(panelId) ?? panelId,
            title: this.defaultTitle(panelId),
            icon: this.panelMeta(panelId)?.icon,
        }));
    }

    /**
     * Switches the tab to the given app panel.
     *
     * The tab config is what the layout keeps, so it is updated in place next to
     * the runtime override (panel.setApp) and the visible title/icon.
     */
    private switchToApp(panelId: string): void {
        const apps = getHost().apps;
        const meta = this.panelMeta(panelId);

        if (!meta && !apps.knownPanels.has(panelId))
            return;

        const panel = this.props.panel;

        this.setState({ activeApp: panelId });

        panel.setApp(panelId);
        this.persistPanelId(panel, panelId);

        panel.setTitle(meta?.title || this.defaultTitle(panelId));
        // An empty icon clears the icon of the previously shown app, so the tab
        // does not keep drawing the wrong one.
        panel.setIcon(meta?.icon ?? "");
    }

    /** Stores `{ ...config, panelId }` on the tab so the layout keeps the choice. */
    private persistPanelId(panel: PanelInstance, panelId: string): void {
        const current = panel.getConfig();
        const base = typeof current === "object" && current !== null && !Array.isArray(current)
            ? current as Record<string, unknown>
            : {};

        try {
            // setPanelConfig() merges into the stored config, so the icon and any
            // app-specific keys survive the switch.
            panelDirectory.setPanelConfig(panel.tabId, { ...base, panelId });
        } catch (error) {
            console.error(`TacPhone failed to persist the app of tab "${panel.tabId}":`, error);
        }
    }

    /** Renders the selected app with the full AppProps contract. */
    private renderApp(panelId: string, panelInfo: AppPanelInfo): React.ReactNode {
        const host = getHost();
        const AppComponent = panelInfo.appComponent;

        return (
            <AppErrorBoundary key={panelId} appName={this.defaultTitle(panelId)}>
                <AppComponent
                    appId={host.apps.appNameForPanel(panelId) ?? panelId}
                    panelId={panelId}
                    node={this.props.node}
                    model={this.props.model}
                    panel={this.props.panel}
                />
            </AppErrorBoundary>
        );
    }

    private renderChooser(): React.ReactNode {
        const failedApps = getHost().apps.failedApps;

        return (
            <div className={`${styles.AppsPanel}`}>
                {this.panelEntries().map(entry => (
                    <div className={`${styles.AppElement}`} key={entry.id} onClick={() => this.switchToApp(entry.id)}>
                        {entry.icon ? <img src={entry.icon} alt="" /> : null}
                        {entry.title}
                    </div>
                ))}
                {[...failedApps.entries()].map(([key, error]) => (
                    <div className={`${styles.AppElement} ${styles.AppElementFailed}`} key={`failed-${key}`} title={error}>
                        <span className={styles.FailedAppIcon}>!</span>
                        {key}
                        <span className={styles.FailedAppError}>{error}</span>
                    </div>
                ))}
            </div>
        );
    }

    render(): React.ReactNode {
        const activeApp = this.state.activeApp;

        if (activeApp) {
            const panelInfo = getHost().apps.knownPanels.get(activeApp);
            if (panelInfo)
                return this.renderApp(activeApp, panelInfo);
        }

        return this.renderChooser();
    }
}
