import React from 'react';
import App from './Map.tsx'
import {
    TACPHONE_API_VERSION,
    type AppPanelInfo,
    type AppProps,
} from '@ace-tacphone/api';
import { mapCommandRegistry } from './CommandRegistry.ts';
// Registers the module-scope marker notification backup handler, so a marker
// still notifies while no Map panel (and therefore no marker layer) is mounted.
import './MapMarkers/MarkerNotifications.ts';

/** Contract version this app was built against; checked by the host. */
export const apiVersion = TACPHONE_API_VERSION;

class AppPlaceholder extends React.Component<AppProps, {loading: boolean}> {
    render() {
        return (<><div style={{color: 'red'}}>Wololo!</div></>);
    }
}

export function GetTacPhoneApps(): Array<AppPanelInfo> {
  return [
    {
        id: "ACE_TacPhone_Map",
        appComponent: App,
        GetDefaultTitle() {
            return "Map";
        },
        GetTacPhoneIcon() {
            // https://fontawesome.com/icons
            // https://yoksel.github.io/url-encoder/
            return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 640'%3E%3C!--!Font Awesome Free v7.3.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--%3E%3Cpath d='M576 112C576 100.9 570.3 90.6 560.8 84.8C551.3 79 539.6 78.4 529.7 83.4L413.5 141.5L234.1 81.6C226 78.9 217.3 79.5 209.7 83.3L81.7 147.3C70.8 152.8 64 163.9 64 176L64 528C64 539.1 69.7 549.4 79.2 555.2C88.7 561 100.4 561.6 110.3 556.6L226.4 498.5L405.8 558.3C413.9 561 422.6 560.4 430.2 556.6L558.2 492.6C569 487.2 575.9 476.1 575.9 464L575.9 112zM256 440.9L256 156.4L384 199.1L384 483.6L256 440.9z'/%3E%3C/svg%3E"; 
        },

    },

    {
        id: "ACE_TacPhone_Map_Placeholder",
        appComponent: AppPlaceholder,
        GetDefaultTitle() {
            return "Placeholder";
        },
        GetTacPhoneIcon() {
            // https://fontawesome.com/icons
            // https://yoksel.github.io/url-encoder/
            return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 640'%3E%3C!--!Font Awesome Free v7.3.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--%3E%3Cpath d='M576 112C576 100.9 570.3 90.6 560.8 84.8C551.3 79 539.6 78.4 529.7 83.4L413.5 141.5L234.1 81.6C226 78.9 217.3 79.5 209.7 83.3L81.7 147.3C70.8 152.8 64 163.9 64 176L64 528C64 539.1 69.7 549.4 79.2 555.2C88.7 561 100.4 561.6 110.3 556.6L226.4 498.5L405.8 558.3C413.9 561 422.6 560.4 430.2 556.6L558.2 492.6C569 487.2 575.9 476.1 575.9 464L575.9 112zM256 440.9L256 156.4L384 199.1L384 483.6L256 440.9z'/%3E%3C/svg%3E"; 
        },

    }
  ]
};

export async function OnMessageFromGame(message: object): Promise<void> {
    mapCommandRegistry.routeMessage(message as { c: string });
};
