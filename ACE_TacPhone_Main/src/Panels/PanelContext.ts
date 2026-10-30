// Panel identity context shared between the host and app content.
//
// Kept in its own module (no JSX, no component exports) so the React Fast
// Refresh / only-export-components rule stays happy in PanelHost.tsx. The host
// bootstrap publishes the context and hook on window.TacPhone.utils because apps
// are separate bundles that cannot import host modules at runtime.

import React from "react";
import type { PanelInstance } from "@ace-tacphone/api";

/** Delivers the live handle of the panel an app content is rendered in. */
export const PanelContext: React.Context<PanelInstance | undefined> = React.createContext<PanelInstance | undefined>(undefined);

/** Returns the live handle of the calling panel, or undefined outside a panel. */
export function usePanel(): PanelInstance | undefined {
    return React.useContext(PanelContext);
}
