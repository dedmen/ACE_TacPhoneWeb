import React from 'react';
import App from './Map.tsx'
import {
    TACPHONE_API_VERSION,
    type AppPanelInfo,
    type AppProps,
} from '@ace-tacphone/api';
import { mapCommandRegistry } from './CommandRegistry.ts';
import { registerMapOptions } from './MapOptions.ts';
import { startGpsUpdateRateSync } from './MapGps/GpsUpdateRateSync.ts';
import { installMapTestHooks } from './MapMarkers/MapTestHooks.ts';
import { MAP_BASE_GAME_STRINGS, t } from './i18n.ts';
// Registers the module-scope marker notification backup handler, so a marker
// still notifies while no Map panel (and therefore no marker layer) is mounted.
import './MapMarkers/MarkerNotifications.ts';

/** Contract version this app was built against; checked by the host. */
export const apiVersion = TACPHONE_API_VERSION;

/** Registers the Map options shown in the host Options panel. */
export async function init(): Promise<void> {
    // Labels use some base-game keys that are not in the add-on stringtable;
    // preload them before the option schema and panels are built.
    await window.TacPhone.localization.load(MAP_BASE_GAME_STRINGS);

    registerMapOptions();

    // Option labels are `t()` lookups resolved when the schema is built, so a
    // later table change (for example an on-demand key arriving) re-registers
    // the schema; the host keeps the values the user already chose.
    window.TacPhone.localization.onDidChange(() => {
        registerMapOptions();
    });

    // The saved layout (and its stored options) can arrive after init(), so the
    // sync converges on the first option change instead of trusting one value.
    startGpsUpdateRateSync();

    installMapTestHooks();
}

/** GPS is the same Map widget in navigation mode. */
function GpsApp(props: AppProps): React.JSX.Element {
    return <App {...props} mode="gps" />;
}

export function GetTacPhoneApps(): Array<AppPanelInfo> {
  return [
    {
        id: "ACE_TacPhone_Map",
        appComponent: App,
        GetDefaultTitle() {
            return t('str_a3_map1');
        },
        GetTacPhoneIcon() {
            // https://fontawesome.com/icons
            // https://yoksel.github.io/url-encoder/
            return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 640'%3E%3C!--!Font Awesome Free v7.3.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--%3E%3Cpath d='M576 112C576 100.9 570.3 90.6 560.8 84.8C551.3 79 539.6 78.4 529.7 83.4L413.5 141.5L234.1 81.6C226 78.9 217.3 79.5 209.7 83.3L81.7 147.3C70.8 152.8 64 163.9 64 176L64 528C64 539.1 69.7 549.4 79.2 555.2C88.7 561 100.4 561.6 110.3 556.6L226.4 498.5L405.8 558.3C413.9 561 422.6 560.4 430.2 556.6L558.2 492.6C569 487.2 575.9 476.1 575.9 464L575.9 112zM256 440.9L256 156.4L384 199.1L384 483.6L256 440.9z'/%3E%3C/svg%3E";
        },

    },

    {
        id: "ACE_TacPhone_Map_GPS",
        appComponent: GpsApp,
        GetDefaultTitle() {
            return t('str_a3_gps1');
        },
        GetTacPhoneIcon() {
            return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Cpath fill='%23222222' d='M256 48a208 208 0 1 0 0 416 208 208 0 0 0 0-416zm0 64a144 144 0 1 1 0 288 144 144 0 0 1 0-288zm-16 32v48h-48v32h48v80h32v-80h48v-32h-48v-48z'/%3E%3C/svg%3E";
        },
    },
  ]
};

export async function OnMessageFromGame(message: object): Promise<void> {
    mapCommandRegistry.routeMessage(message as { c: string });
};
