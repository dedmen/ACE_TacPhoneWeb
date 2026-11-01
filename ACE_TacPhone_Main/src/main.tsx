import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// The shared module namespaces are installed on the internal
// `window.TacPhone.modules` map by Backend/Host.ts; there are no per-module
// window globals. Apps resolve them through the host import map.

import './Backend/Host'; // Builds the single window.TacPhone host object
import './Panels/PanelHost.tsx'; // Tab <-> PanelInstance binding
import { RemotePairingScreen } from './Panels/RemotePairingScreen';
import { localization } from './Backend/Localization';

// Decode the stringtable bundled into the host before the first render: the
// remote pairing screen and the loading line have to show text even when the
// game is not reachable yet. loadDefaults() never rejects.
void localization.loadDefaults().finally(() => {
    createRoot(document.getElementById('root')!).render(
        // StrictMode is enabled on purpose: React mounts every component twice in
        // development. The panel binding, the app directory and the layout loader are
        // written to be idempotent across that double mount, so a duplicate app or
        // panel instance is a bug to fix, not a reason to disable StrictMode.
        <StrictMode>
            <RemotePairingScreen />
            <App/>
        </StrictMode>,
    )
});
