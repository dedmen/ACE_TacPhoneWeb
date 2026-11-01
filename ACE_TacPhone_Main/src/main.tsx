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
