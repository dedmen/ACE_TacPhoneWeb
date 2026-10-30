// React binding between the flexlayout tabs and the panel directory.
//
// PanelBinding creates the runtime PanelInstance of the tab it renders and
// passes it to its children render prop, which is how the host builds AppProps
// for app content. It also publishes the instance through PanelContext, so app
// code that predates props can keep reading it with usePanel() / contextType.
//
// Floating popups render through the same flexlayout factory, so their content
// is wrapped the same way and gets an instance with isFloating: true.

import React from "react";
import type { PanelInstance } from "@ace-tacphone/api";
import { panelDirectory } from "../Backend/PanelDirectory";
import { PanelContext } from "./PanelContext";

type PanelBindingProps = {
    /** Id of the tab node this binding renders. */
    tabId: string;
    /** App panel id the tab runs; undefined for an unassigned app chooser tab. */
    panelId?: string;
    /** Content of the tab; receives the live instance of the tab it renders in. */
    children: (panel: PanelInstance) => React.ReactNode;
};

/**
 * Owns the PanelInstance of one tab and provides it to the tab content.
 *
 * flexlayout mounts only the selected tab of a tabset, so one binding exists per
 * mounted tab. The directory guarantees one instance per tab; a second binding
 * for the same tab would replace the first one with a warning.
 */
export class PanelBinding extends React.Component<PanelBindingProps> {
    /** Live handle of the rendered tab; replaced only when the tab id changes. */
    private instance: PanelInstance;

    constructor(props: PanelBindingProps) {
        super(props);
        this.instance = panelDirectory.createInstance(props.tabId, props.panelId);
    }

    componentDidMount(): void {
        // StrictMode may run componentWillUnmount and then remount the same class
        // instance without running the constructor again. Re-assert ownership so
        // the panel (and any service registered against it) stays live.
        const instance = panelDirectory.createInstance(this.props.tabId, this.props.panelId);
        if (instance !== this.instance) {
            this.instance = instance;
            this.forceUpdate();
        }
    }

    componentDidUpdate(previous: PanelBindingProps): void {
        if (previous.tabId !== this.props.tabId) {
            // Should not happen while the layout is keyed by tab id, but never
            // leave two instances for one tab behind.
            panelDirectory.disposeInstance(this.instance.instanceId);
            this.instance = panelDirectory.createInstance(this.props.tabId, this.props.panelId);
            this.forceUpdate();
            return;
        }

        if (previous.panelId !== this.props.panelId)
            this.instance.setApp(this.props.panelId);
    }

    componentWillUnmount(): void {
        panelDirectory.disposeInstance(this.instance.instanceId);
    }

    render(): React.ReactNode {
        return (
            <PanelContext.Provider value={this.instance}>
                {this.props.children(this.instance)}
            </PanelContext.Provider>
        );
    }
}
