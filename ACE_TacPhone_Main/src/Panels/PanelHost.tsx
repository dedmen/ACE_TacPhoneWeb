// React binding between the flexlayout tabs and the panel directory.
//
// PanelBinding creates the runtime PanelInstance of the tab it renders and
// publishes it through PanelContext, so app content gets its handle without
// props (apps still receive no props, see AGENTS.md). Function components read
// it with usePanel(), class components with `static contextType = PanelContext`.
//
// Floating popups render through the same flexlayout factory, so their content
// is wrapped the same way and gets an instance with isFloating: true.

import React from "react";
import type { PanelInstance } from "../Backend/PanelDirectory";
import { PanelContext } from "./PanelContext";

type PanelBindingProps = {
    /** Id of the tab node this binding renders. */
    tabId: string;
    /** App panel id the tab runs; undefined for an unassigned app chooser tab. */
    panelId?: string;
    children?: React.ReactNode;
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
        this.instance = window.PanelDirectory.createInstance(props.tabId, props.panelId);
    }

    componentDidUpdate(previous: PanelBindingProps): void {
        if (previous.tabId !== this.props.tabId) {
            // Should not happen while the layout is keyed by tab id, but never
            // leave two instances for one tab behind.
            window.PanelDirectory.disposeInstance(this.instance.instanceId);
            this.instance = window.PanelDirectory.createInstance(this.props.tabId, this.props.panelId);
            this.forceUpdate();
            return;
        }

        if (previous.panelId !== this.props.panelId)
            this.instance.setApp(this.props.panelId);
    }

    componentWillUnmount(): void {
        window.PanelDirectory.disposeInstance(this.instance.instanceId);
    }

    render(): React.ReactNode {
        return (
            <PanelContext.Provider value={this.instance}>
                {this.props.children}
            </PanelContext.Provider>
        );
    }
}
