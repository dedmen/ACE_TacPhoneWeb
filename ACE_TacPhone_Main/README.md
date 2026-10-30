# ACE TacPhone Web UI

`ACE_TacPhone_Main` is the host UI for ACE TacPhone. It provides the panel
manager, the networking layer, and the build that is embedded in the in-game
`CT_WEBBROWSER` control.

In development the same code runs as a normal web page and talks to a running
Arma client through the `ArmaWebHost` extension over a WebSocket.

## Requirements

| Component | Minimum | Notes |
| --- | --- | --- |
| Node.js | 20.19+ or 22.12+ | Required by Vite 8 / the installed toolchain. |
| Arma 3 | 2.24+ (2.23 dev branch) | TacPhone uses `CT_CONTROL_REF`, `ctrlWebBrowserAction ["SetControlReference", ...]`, and `SetBrowserInternalSize`, which were added in the 2.23 dev branch and ship in 2.24. Arma 3 2.22 stable does not expose them. |
| Browser | Chromium 126+ | The in-game browser is Chromium 126. An external browser needs the same minimum feature set: ES modules, import maps, blob-URL module imports, and `CompressionStream` / `DecompressionStream`. |

The in-game browser runs local content in a sandbox. It has no `fetch` /
`XMLHttpRequest`, `localStorage`, or `IndexedDB`. Code that runs in both modes
must not depend on those APIs. Bundle assets inline; use `window.Networking` to
load files from the game.

## Quick start

Run these commands in `ACE_TacPhone_Main`:

```powershell
npm install
npm run dev
```

The development script is `dev`; Vite prints the URL to open (normally
`http://localhost:5173`). Use the `localhost` URL, not `127.0.0.1`: the dev
transport is selected by the `http://localhost` prefix. Keep the TacPhone open
in Arma: in development the page connects to `wss://localhost:8001/ws`, which
is started by the `ArmaWebHost` extension. Without a running game and TacPhone
the page will report a connection failure.

A development app is discovered from its own folder by app name. See
[Developing apps](#developing-apps).

### Debugging

Use an external Chrome/Chromium window with the browser devtools. The checked-in
`.vscode/launch.json` is a starting point; set its `url` to the URL printed by
Vite and keep:

```json
"webRoot": "${workspaceFolder}/websource/ACE_TacPhone_Main"
```

Development apps live outside the Vite root, so their files are served from
`/@fs/<absolute path>` URLs. `devAppsPlugin` rewrites the dev source maps of app
files to absolute source paths, so breakpoints set in app sources bind to the
real files. Do not add a `sourceMapPathOverrides` workaround for `/@fs/` URLs.

The VS Code integrated browser does not resolve `webRoot` correctly and will
not bind source-map breakpoints.

### Building the in-game UI

```powershell
npm run build
Copy-Item dist\index.html ..\..\data\index.html
```

The build produces a single self-contained `dist/index.html` (inline script and
import map); that is the file loaded by `CT_WEBBROWSER`. `dist/` and the copied
`data/index.html` are ignored by git.

`npm run build` is a release build: the JavaScript is minified, no source map is
embedded, and `console.log` / `console.debug` / `console.info` calls are removed.
Use `npm run build:debug` for an unminified build with an inline source map;
`console.warn` and `console.error` calls are kept in both builds.

## Developing apps

An app is a JavaScript ES module that is loaded dynamically by the host. A mod
can provide one or more apps. During development the host dev server can load an
app from any folder on disk; the app does not have to be below the host web root.

The recommended layout keeps each app repository next to the host:

```text
ACE_TacPhoneWeb/
  ACE_TacPhone_Main/
  ACE_TacPhone_Map/
  ACE_TacPhone_AnotherApp/
```

The host discovers development apps from these places:

1. `dev-apps.local.json` in `ACE_TacPhone_Main` (git-ignored), for apps anywhere:

   ```json
   { "apps": ["../ACE_TacPhone_Map", "D:/dev/ACE_TacPhone_AnotherApp"] }
   ```

   Relative paths are resolved from `ACE_TacPhone_Main`.
2. The `TACPHONE_DEV_APPS` environment variable, using the platform path
   separator (`;` on Windows). Useful for CI or a one-off location.
3. Sibling folders of `ACE_TacPhone_Main` whose `package.json` declares the app:

   ```json
   {
     "tacphone": { "app": "ACE_TacPhone_MyApp" }
   }
   ```

The declared app name must match the game-side `ace_tacphone_apps` config class
exactly. It is also the routing key used by requests. A folder listed in the
config/environment may omit the marker; its folder name is then used as the app
name. Sibling folders require the marker so unrelated folders are never exposed
by accident.

The dev server exposes every discovered app under a stable URL:

```text
/devapps/<AppName>/
```

The loader imports the entry named by `ace_tacphone_devFile` in the app config,
defaulting to `src/main.tsx`:

```text
/devapps/<AppName>/src/main.tsx
```

Install the app's own dependencies in its directory (`npm install` inside the
app folder), then start the host with `npm run dev`. Vite serves the app through
the host dev server, so edits to the app hot-reload. Running the app's own Vite
dev server is not enough: it does not provide the TacPhone globals, networking,
or host import map. Restart the host after changing `dev-apps.local.json` or the
environment variable.

Apps keep their own `node_modules`; the host deduplicates every package in
[`shared-modules.js`](shared-modules.js) to its own copies. The host's
`server.fs.allow` list is generated from the discovered app folders, so an app
outside the host root can still be served.
Requests to an undiscovered app return a 404 with a short explanation.

## App contract

### Game-side registration

Register the app in the addon config (or in `description.ext`):

```cpp
class ace_tacphone_apps {
    class ACE_TacPhone_MyApp {
        scope = 2;
        icon = "\A3\ui_f\data\map\markers\nato\c_ship.paa"; // optional/reserved
        ace_tacphone_file = QPATHTOF(data\ace_tacphone_myapp.js);
        ace_tacphone_devFile = "src\main.tsx";
        ace_tacphone_requestProcessor = QFUNC(processBrowserRequest);
    };
};
```

| Field | Required | Meaning |
| --- | --- | --- |
| `scope` | Yes | Must be greater than `0`; use `2`. |
| `ace_tacphone_file` | Yes, except `main` | Path to the production ES module entry in the game filesystem. It is read with `LoadGameFileText` and imported from a blob URL. |
| `ace_tacphone_devFile` | Recommended | Entry point relative to the app folder, for example `src\main.tsx`. The development loader imports this path from `/devapps/<AppName>/`; if omitted it falls back to `src/main.tsx`. |
| `ace_tacphone_requestProcessor` | For app requests | Name of the SQF function that handles requests sent with `a: "<AppName>"`. It receives the request hashmap and the requesting client id (`"local"` for the in-game browser, otherwise the websocket connection id), and may return any JSON-serializable value or a promise. |
| `icon` | No | Currently reserved; panel icons come from `GetTacPhoneIcon()`. |

`<AppName>` is also the routing key. It is the `a` field in requests and is the
folder name used by the development loader.

### Module exports

The entry module must export:

```ts
import React from 'react';
import type { AppPanelInfo } from './TacPhoneMain';

export function GetTacPhoneApps(): AppPanelInfo[] {
    return [{
        id: 'ACE_TacPhone_MyApp',
        appComponent: MyPanel,
        GetDefaultTitle: () => 'My App',
        GetTacPhoneIcon: () => 'data:image/svg+xml,...',
    }];
}

export function OnMessageFromGame(message: object): void | Promise<void> {
    // Optional. Messages from the game are delivered here.
}
```

`AppPanelInfo` is part of the host API declarations. The host build generates
`dist/TacPhoneMain.d.ts` from [`src/TacPhoneMain.ts`](src/TacPhoneMain.ts) and
syncs it to the `src` directory of every discovered development app. For an app
that is not discovered yet, copy the generated file into the app's `src`
directory, or run `npm run sync:api-types -- <path-to-app-src>`. Do not edit the
copied file by hand; change the host API source instead.

| Panel field | Contract |
| --- | --- |
| `id` | Globally unique across all apps. It is used as the panel key and in saved layouts; do not use `AppChooser`. |
| `appComponent` | A React class or function component. The host creates it with `React.createElement(component, null)`, so it receives no props. |
| `GetDefaultTitle()` | Returns the tab title. Must return a string. |
| `GetTacPhoneIcon()` | Returns an image URL. Data URLs and blob URLs work best because the in-game browser cannot load external files. |

The host wraps app components in an error boundary. A broken app is recorded in
`window.AppDirectory.failedApps` and does not prevent the other apps from
loading.

### Requests and messages

App code talks to the game through `window.Networking.Request`:

```ts
const result = await window.Networking.Request({
    a: 'ACE_TacPhone_MyApp', // registered app name
    c: 'GetSomething',       // command understood by the SQF request processor
    // ...additional JSON-serializable fields
});
```

The request is routed to the app's `ace_tacphone_requestProcessor` as
`[request, clientId]`. Returning a promise from SQF is supported; the host waits
for it and forwards the resolved value.

Messages pushed from the game to a browser arrive at `OnMessageFromGame`. The
`a` field identifies the target app. Use the host's command registry to route a
single app handler to individual panels:

```ts
const registry = new window.TacPhoneUtils.CommandRegistry();

const unregister = registry.register('SomeCommand', payload => {
    // handle payload
});

export function OnMessageFromGame(message: object): void {
    registry.routeMessage(message as { c: string });
}
```

`register()` returns a cleanup function. Each app has only one
`OnMessageFromGame` export, so route messages instead of trying to export one
handler per panel.

### Globals available to apps

The host exposes these before loading apps:

| Global | Purpose |
| --- | --- |
| `window.Networking` | `WhenReady()`, `Request()`, `LoadGameFileText()`, `LoadGameFileTexture()`, `LoadGameTerrain()`. |
| `window.AppDirectory` | Read-only view of `knownApps`, `knownPanels`, and `failedApps`. Do not modify it. |
| `window.TacPhoneUtils.CommandRegistry` | Message router helper shown above. |
| `window.PanelDirectory` | Enumerate, focus, activate, and open panels. See [Inter-app API](#inter-app-api). |
| `window.AppApi` | Register an app's API and resolve or call another app's. See [Inter-app API](#inter-app-api). |
| `window.InterestRegistry` | Acquire and release named data interests so the game only sends what the page needs. See [Data interests](#data-interests). |
| `window.TacPhoneUtils.PanelContext` | React context with the live `PanelInstance` of the panel an app is rendered in. |
| `window.TacPhoneUtils.usePanel()` | Hook form of `PanelContext` for function components. |

Tooling types for these are generated into `dist/TacPhoneMain.d.ts` and synced
into the development apps by the host build.

The public API source is [`src/TacPhoneMain.ts`](src/TacPhoneMain.ts). Add
app-facing classes, types, and `window` globals there; the build bundles them
with the host declarations and updates the app copies. Never edit a synced
`TacPhoneMain.d.ts` directly. Import these declarations with `import type`;
at runtime the host API is accessed through `window`. The bundle also types the
shared module globals (`window.React`, `window.ReactDOM`, and so on).

## Inter-app API

Apps can expose a versioned runtime API to other apps through `window.AppApi`,
and can enumerate, activate, and open panels through `window.PanelDirectory`.
Both are page-local: they never pass through `window.Networking` or SQF, the game
cannot call them, and there is no permission model. The whole web UI and every
app loaded in it are one trust domain: any app can call any registered API, and
apps are not isolated from each other.
The public types are exported from [`src/TacPhoneMain.ts`](src/TacPhoneMain.ts)
and arrive in an app with the generated `TacPhoneMain.d.ts` like the rest of the
API.

### Identity model

| Concept | Type | Meaning | Persisted |
| --- | --- | --- | --- |
| Panel type | `panelId` (string) | `AppPanelInfo.id`, for example `ACE_TacPhone_Map`. | Yes, in saved layouts. |
| Tab | `tabId` (string) | Id of the panel (flexlayout tab) node. Stable across layout save/load. | Yes, in saved layouts. |
| Runtime instance | `instanceId` (string) | One mounted app content, for example `panel-7`. New on every mount. | No. |
| Service | `service` (string) | App-chosen stable name an app registers, for example `map`. | No. |

Switching the app inside the app chooser keeps the tab and its runtime instance,
but replaces the app content, so the previous app's API registration goes away
with it. The reported `panelId` follows `setApp()` and is also persisted in the
tab config; on the next mount the chooser reads that value back and restores the
app, so a saved layout opens the same app again. The live handle also exposes
`getConfig()` for that persisted tab config. The panel system mounts only the
selected tab of a tabset, so a panel that is open in the background has no
`instanceId` and no registered API. Routing therefore activates a candidate and
waits for its registration; see
[Routing to a Map instance](#routing-to-a-map-instance).

### `window.PanelDirectory`

| Method | Returns | Notes |
| --- | --- | --- |
| `list()` | `PanelInfo[]` | Every open panel, including floating popups. |
| `get(instanceId)` | `PanelInfo \| undefined` | Snapshot of one mounted instance. |
| `find(panelId)` | `PanelInfo[]` | Every panel that runs the given app panel id. |
| `focused()` | `PanelInfo \| undefined` | Last focused panel, following the user across the main layout and floats. |
| `largest(panelId?)` | `PanelInfo \| undefined` | Biggest panel of the main layout, optionally restricted to one panel id. |
| `activate(instanceId)` | `boolean` | Selects the tab, focuses its tabset, and brings a floating popup to the front. A tab id is accepted for a tab without an instance. |
| `open(panelId, options?)` | `OpenPanelResult \| undefined` | Opens the app, by default as a floating popup. |
| `onDidChange(listener)` | `() => void` | Calls `listener(panels)` on panel changes. The return value unsubscribes. |

`focused()` uses the last tab the user focused in any layout and falls back to
the active tabset of the main layout, then to any selected panel. `largest()`
compares the tabset area in the main layout only; ties are broken by top-left
reading order so the result is deterministic. `list()` is also populated for a
tab whose app is not mounted, so filter on `mounted` (or `instanceId`) when you
need a live instance.

`PanelInfo` reports `tabId`, `tabSetId`, `layoutId`, `panelId`, `appName`,
`title`, `instanceId`, `mounted`, `isSelected`, `isActive`, `isVisible`,
`isFloating`, `isPoppedOut`, `rect`, and `area`. `instanceId` is present only
while the tab content is mounted.

`open(panelId, options)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `placement` | `'float'` | `'float'` creates a floating popup; `'tab'` adds a docked tab. |
| `select` | `true` | Select the new tab. |
| `tabsetId` | Active tabset, then the first one | `'tab'` only: tabset that receives the tab. |
| `rect` | Centered, 60% of the main layout | `'float'` only: `Partial<PanelRect>`; supplied fields override the default. |
| `config` | `undefined` | Stored in the tab config and persisted with the layout. |

A default floating popup covers 60% of the main layout, is at least 320x240,
is clamped to the layout, and is cascaded by about 24 px for each following
popup. Floats are persisted by the panel library under the model's `subLayouts`,
so a popup opened for routing survives a layout save and restore. `open()`
returns
`{ tabId, layoutId, tabSetId }`, or `undefined` with a warning for an unknown
panel id. Routing through `AppApi.resolveAsync()` is the supported way to open a
missing app; call `open()` directly only for UI work.

### `window.AppApi`

| Method | Returns | Notes |
| --- | --- | --- |
| `register(instance, { service, version, api })` | `() => void` | Registers the API of the calling panel. The return value unregisters it. |
| `list(service?)` | `AppServiceInfo[]` | Every registration, with a fresh `PanelInfo` of its panel. |
| `resolve(target)` | `AppServiceInfo \| undefined` | Synchronous snapshot of the mounted panels only. |
| `resolveAll(target)` | `AppServiceInfo[]` | All registrations that match, without policy or auto-open. |
| `resolveAsync(target, reason?)` | `Promise<AppServiceInfo \| undefined>` | Routing entry point: activates, opens, and waits for a registration. |
| `getApi<T>(service, options?)` | `T \| undefined` | Convenience wrapper around `resolve()`. |
| `call<T>(service, method, ...args)` | `Promise<T>` | Routes with `resolveAsync()` and awaits the method. |
| `setTargetChooser(chooser)` | `void` | Installs the handler for `policy: 'ask'`; pass `undefined` to remove it. |
| `onDidChange(listener)` | `() => void` | Calls `listener(services)` on registration and panel changes. |

`register()` is called from the app lifecycle with the panel instance from the
context, and the returned function from the unmount path:

```ts
const panel = window.TacPhoneUtils.usePanel();

React.useEffect(() => {
    if (!panel)
        return;

    return window.AppApi.register(panel, {
        service: 'myapp',
        version: 1,
        api: { doSomething: () => { /* ... */ } },
    });
}, [panel]);
```

Register one service per panel instance. Re-registering the same service on the
same panel replaces the previous registration with a warning; a dispose function
from an earlier mount is a no-op. `register()` throws for a missing instance, an
empty service name, or a version that is not an integer `>= 1`.

Versioning: a caller that passes `version` gets exactly that major version and a
mismatch is skipped with a warning. Without `version`, the highest registered
version wins. Registrations disappear as soon as their panel is gone, and a
`PanelInfo` is a snapshot; re-resolve instead of caching `api` across panel
closes.

`TargetOptions` fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `service` | Required | Service to find. |
| `policy` | `'auto'` | `'auto'`, `'focused'`, `'largest'`, `'first'`, or `'ask'`. |
| `version` | Highest registered | Requested major version. |
| `panelId` | Any | Restrict candidates to one app panel id. |
| `instanceId` | None | Explicit target; wins over the policy. An instance id or a tab id. |
| `openIfMissing` | `false` | Open the app when no panel provides it. Needs `panelId`. |
| `placement` | `'float'` | Placement used with `openIfMissing`. |
| `activate` | `true` | Activate the target panel before returning and waiting. |
| `waitMs` | `3000` | Budget for a panel to mount and register; values above 30000 are capped. |

`resolve()` only sees mounted panels, never waits, and never throws; `'ask'` is
not possible synchronously and falls back to `'auto'` with one warning.
`resolveAsync()` also considers background tabs, activates the chosen panel, and
waits for its registration; it returns `undefined` with a warning on timeout or
when nothing matches. `call()` is the exception: it throws when the service is
unavailable, the method is missing, or the method itself fails.

`TargetChooser` receives `{ service, candidates, reason? }` and returns an
instance id, a tab id, or `undefined` to cancel. The host installs the modal
picker once (see [Routing to a Map instance](#routing-to-a-map-instance)).

### Using the panel context

Apps still receive no props. The host passes the live `PanelInstance` through
`window.TacPhoneUtils.PanelContext`:

- Function components: `window.TacPhoneUtils.usePanel()`.
- Class components: `static contextType = window.TacPhoneUtils.PanelContext;`
  and `declare context: PanelInstance | undefined;`, then `this.context`.

```tsx
import type { PanelInstance } from './TacPhoneMain';

export class MyPanel extends React.Component<{}, {}> {
    static contextType = window.TacPhoneUtils.PanelContext;
    declare context: PanelInstance | undefined;

    private unregister: (() => void) | undefined;

    componentDidMount(): void {
        const panel = this.context;
        if (panel)
            this.unregister = window.AppApi.register(panel, {
                service: 'myapp',
                version: 1,
                api: { doSomething: () => { /* ... */ } },
            });
    }

    componentWillUnmount(): void {
        this.unregister?.();
    }
}
```

The handle exposes `instanceId`, `tabId`, `getInfo()`, `activate()`, and
`setApp(panelId)`. API registration goes through `window.AppApi`, not through the
handle.

### Routing to a Map instance

`resolveAsync()` implements the whole route. A Messenger-style caller looks like
this:

```ts
async function showOnMap(x: number, y: number): Promise<void> {
    const target = await window.AppApi.resolveAsync({
        service: 'map',
        panelId: 'ACE_TacPhone_Map',
        policy: 'ask',              // focused -> largest -> user choice
        openIfMissing: true,        // no Map open -> host opens a floating popup
        placement: 'float',         // explicit for readability; 'float' is the default
        waitMs: 3000,
    }, 'Show clicked coordinates');

    if (!target)
        return;                     // cancelled, timed out, or app unavailable
    (target.api as MapApi).flyTo({ x, y });
}
```

- No Map open: the host opens a floating popup, activates it, and waits for the
  `map` service to register. Routing never docks an app into an existing tab
  unless the caller passes `placement: 'tab'`.
- Map open in a background tab: it is not mounted, so the host activates its tab
  and waits for the registration.
- Map open in several panels: the policy chooses; floats are candidates too and
  the chosen popup is brought to the front.
- `policy: 'ask'` calls the host's target chooser only when candidates exist; it
  lists the candidates and lets the user pick one. Cancel, a backdrop click, and
  Escape cancel the request. A newer request supersedes a pending one, so a
  stalled caller never blocks the next route. Without an installed chooser,
  `'ask'` behaves like `'auto'` (focused, then largest, then the only candidate).
- When the opened app never registers within `waitMs`, the popup stays open so
  the user can see and close it, and `resolveAsync()` returns `undefined`.

### Map service reference

The Map app (`ACE_TacPhone_Map`) registers the reference service from its panel
lifecycle, so every mounted Map panel provides its own API:

| Item | Value |
| --- | --- |
| Service | `map` |
| Version | `1` |
| `flyTo({ x, y, resolution?, animate? })` | Moves the view to the given center. Coordinates are map/world coordinates, not latitude/longitude. `resolution` keeps the current one when omitted; `animate: false` jumps instead of animating. |
| `getView()` | `{ x, y, resolution }` of the current center, or `undefined` while the terrain view is not ready. |
| `isReady()` | `true` when the map instance exists and the terrain view is ready. |

The Map builds the API after its OpenLayers map exists and unregisters it before
tearing the map down. A `flyTo()` that arrives before the terrain SVG has loaded
is queued and applied after the initial fit, so a route into a freshly opened Map
popup still lands on the requested position.

The Map follows `resolveAsync({ service: 'map', ... })` by calling these methods
on the resolved `api`. Its generated `dist/ace_tacphone_map.d.ts` exports the
`MapApi`, `MapViewState`, `MapFlyToOptions`, `MAP_SERVICE`, and
`MAP_SERVICE_VERSION` declarations, so another app can import the types from the
Map package and cast the resolved API without depending on OpenLayers. That
declaration is produced by the shared
`scripts/bundle-api-types.mjs --app` script in this host package; apps do not
ship their own bundler.

### Limitations

- Floating popups are listed, focusable, and activatable, but `largest()` ranks
  only the main layout: areas of separate layouts are not comparable.
- Everything stays inside the single page/tab. Native window popouts
  (`isPoppedOut`) need `window.open` and a separate document, so they are not
  supported; floating in-layout popups are the only popup placement.
- Layout restore keeps a float's rectangle and tab component, but not instance
  ids or registrations. Apps re-register when their panel mounts again.
- There are no cross-app events or subscriptions yet; use method calls.
- There is no permission model between apps.

## Data interests

The game only does the expensive work for data that some page asked for, and
only sends it to the pages that asked. An app announces a named interest; the
game then targets its updates for that data at this page until the interest is
released.

Names are opaque strings namespaced by app (`<AppName>.<feature>`), for example
`ACE_TacPhone_Map.markers`. They must be non-empty and at most 128 characters;
anything else is rejected with a console warning.

```ts
export class MyPanel extends React.Component<{}, {}> {
    private releaseInterest: (() => void) | undefined;

    componentDidMount(): void {
        // Reference counted per page: two panels of this app share one game interest.
        this.releaseInterest = window.InterestRegistry.acquire('ACE_TacPhone_MyApp.updates');

        // Requests keep their order, so a snapshot requested after this line
        // cannot miss an update and does not need to await an acknowledgement.
        window.Networking.Request({ a: 'ACE_TacPhone_MyApp', c: 'GetSnapshot' });
    }

    componentWillUnmount(): void {
        this.releaseInterest?.();
    }
}
```

| Method | Returns | Notes |
| --- | --- | --- |
| `acquire(interest)` | `() => void` | Adds one reference; the game is told only on the first one. The disposer is idempotent and withdraws the interest when the last reference is released. |
| `isActive(interest)` | `boolean` | `true` while this page holds at least one reference. |
| `list()` | `string[]` | The interests this page currently holds. |
| `onDidChange(listener)` | `() => void` | Calls `listener(interests)` when the held set changes; the return value unsubscribes. |

- The interest belongs to the page, not to a panel: an app that is open twice
  holds one interest, and closing one panel keeps it. Release on unmount, and
  only release what `acquire()` returned.
- "Open but inactive" (for example a GPS panel that is visible but not tracking)
  means calling the disposer and acquiring again when updates are needed. Do not
  keep an unused interest alive: the game would keep working for nothing.
- Reconnects are handled for you. The game drops a websocket client's interests
  when its connection closes, so the registry re-announces every held interest
  after a reconnect. Nothing is sent while the transport is down; an interest
  acquired then is announced as soon as it is up.
- A `pagehide` handler sends one best-effort clear for the in-game browser, which
  never disconnects on its own.
- Nothing here throws: an invalid name or a failed request is logged, and the
  interest state of this page stays as `list()` reports it.

## Import-map constraints

The host exposes React once and generates an import map in `index.html`. In
development `vite.config.ts` injects it into the served page; in the production
build the same map is embedded in `data/index.html`. It maps exactly these bare
module specifiers:

```json
{
  "imports": {
    "react": "data:text/javascript,export default window.React; ...",
    "react-dom": "data:text/javascript,export default window.ReactDOM; ...",
    "react-dom/client": "data:text/javascript,export default window.ReactDOMClient; ...",
    "react/jsx-runtime": "data:text/javascript,export default window.ReactJSXRuntime; ...",
    "react/compiler-runtime": "data:text/javascript,export default window.ReactCompilerRuntime; ..."
  }
}
```

The generated modules re-export the values that `src/main.tsx` assigns to
`window.React`, `window.ReactDOM`, `window.ReactDOMClient`,
`window.ReactJSXRuntime`, and `window.ReactCompilerRuntime`. The specifier and
global names live in one list, [`shared-modules.js`](shared-modules.js), which
drives the host import map, `src/main.tsx`, and the app build externals.

Rules for app builds:

- Keep `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, and
  `react/compiler-runtime` external. Do not bundle a second copy of React;
  duplicate React copies break hooks and context.
- Only the exact specifiers above are mapped. Other subpaths such as
  `react/jsx-dev-runtime` and `react-dom/server` are not. Bundle them in the
  app, or avoid them.
- A production app bundle is imported from a blob URL but resolves bare imports
  through the host document's import map. Do not rewrite these specifiers to
  file paths.
- If another shared dependency is needed, it must either be bundled or added to
  [`shared-modules.js`](shared-modules.js) and assigned in `src/main.tsx`; apps
  cannot add mappings themselves.
- React Compiler users: keep `react/compiler-runtime` external as well; the host
  maps it to the compiler runtime that belongs to the same React instance.

In development Vite resolves the bare imports for you. The import map matters
most for a prebuilt app bundle loaded with `import()` from a blob URL.

`npm run check:importmap` verifies the built host import map and every discovered
development app's `dist/*.js` bundle against `shared-modules.js`. The host and
app build scripts run the same check automatically.

## Production packaging: one ESM entry file per app

The production loader in `src/Backend/AppDirectory.ts` reads
`ace_tacphone_file` with `LoadGameFileText`, creates a `Blob`, and imports it:

```ts
const content = await window.Networking.LoadGameFileText(appInfo.file);
const url = URL.createObjectURL(
    new Blob([content], { type: 'application/javascript' })
);
return import(/* @vite-ignore */ url);
```

The entry file must be one self-contained ES module. A normal bundle-relative
`import('./chunk.js')`, `React.lazy(() => import(...))`, CSS code splitting, or
an asset URL that points at another emitted file will fail because the blob URL
has no sibling files to resolve against.

Recommended library build settings:

```ts
build: {
    lib: {
        entry: 'src/main.tsx',
        formats: ['es'],
        fileName: () => 'myapp.js',
    },
    rollupOptions: {
        external: [
            'react',
            'react-dom',
            'react-dom/client',
            'react/jsx-runtime',
            'react/compiler-runtime',
        ],
        output: {
            // Vite 8 / Rolldown: never emit separate chunks.
            codeSplitting: false,
        },
    },
}
```

Inline CSS and assets in the bundle. The Map app's custom
[`build/singlefile.ts`](../ACE_TacPhone_Map/build/singlefile.ts) inlines CSS as a
`data:` URL; the host itself uses `vite-plugin-singlefile`. Keep assets as data
URLs rather than separate files.

### Loading additional files manually

Dynamic loading and CSS splitting are still possible. The difference is that
you cannot rely on a relative chunk URL; explicitly read the extra game file
through `window.Networking.LoadGameFileText`, then import it or attach it:

```ts
const moduleCache = new Map<string, Promise<unknown>>();

export function loadGameModule(path: string): Promise<unknown> {
    let promise = moduleCache.get(path);
    if (!promise) {
        promise = (async () => {
            const source = await window.Networking.LoadGameFileText(path);
            const url = URL.createObjectURL(
                new Blob([source], { type: 'text/javascript' }),
            );
            try {
                return await import(/* @vite-ignore */ url);
            } finally {
                URL.revokeObjectURL(url);
            }
        })();
        moduleCache.set(path, promise);
        promise.catch(() => {
            if (moduleCache.get(path) === promise)
                moduleCache.delete(path);
        });
    }
    return promise;
}

const stylesheetCache = new Map<string, Promise<void>>();

export function loadGameStylesheet(path: string): Promise<void> {
    let promise = stylesheetCache.get(path);
    if (!promise) {
        promise = (async () => {
            const css = await window.Networking.LoadGameFileText(path);
            const url = URL.createObjectURL(
                new Blob([css], { type: 'text/css' }),
            );
            await new Promise<void>((resolve, reject) => {
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = url;
                link.onload = () => resolve();
                link.onerror = () => {
                    link.remove();
                    URL.revokeObjectURL(url);
                    reject(new Error(`Failed to load stylesheet ${path}`));
                };
                document.head.appendChild(link);
            });
        })();
        stylesheetCache.set(path, promise);
        promise.catch(() => {
            if (stylesheetCache.get(path) === promise)
                stylesheetCache.delete(path);
        });
    }
    return promise;
}
```

Use game-filesystem paths in the same format as `ace_tacphone_file`, and ship
the extra files in the PBO:

```ts
const { openAdvancedMap } = await loadGameModule(
    '\\z\\my_mod\\addons\\my_app\\data\\advanced-map.js',
) as typeof import('./advanced-map');

await loadGameStylesheet(
    '\\z\\my_mod\\addons\\my_app\\data\\advanced-map.css',
);
```

A split JavaScript file is another ES module. It can use the host-provided bare
imports (`react`, `react/jsx-runtime`, and so on), but it cannot resolve relative
imports of its own: those specifiers would resolve against the blob URL and
fail. The same applies to `new URL(..., import.meta.url)` asset lookups; inline
those assets too. Build each split module as a leaf with no relative imports,
and load any dependency explicitly through `loadGameModule`. A module that
default-exports a component works with `React.lazy`:

```ts
const AdvancedMap = React.lazy(() =>
    loadGameModule('\\z\\my_mod\\addons\\my_app\\data\\advanced-map.js')
        as Promise<{ default: React.ComponentType }>,
);
```

For CSS, you can also use a `data:text/css` URL instead of a blob URL. A split
stylesheet cannot resolve relative `url()` references either; inline images and
fonts as data URLs.

Build each extra JavaScript module as its own single-file ES library build.
Build the CSS with your usual CSS/Sass build, or enable CSS code splitting and
ship the resulting file. Do not ship Vite's automatically generated chunk graph
with relative imports; only ship files that the manual loader can read and
import directly.

This does have a cost. Every additional file is another game-filesystem read,
blob creation, and module parse/evaluation (or stylesheet load). The first use
is therefore slower than a normal bundler chunk, especially through the external
WebSocket transport; a large CSS file also has to be fetched and parsed before
the styles apply. Cache loaded modules/styles per path, and prefetch on idle if
a feature is likely to be opened. During development the file must be available
through the game/WebHost filesystem, not only from the Vite output directory.

Do not use a bundle-relative dynamic import in the production entry module; use
`LoadGameFileText` for any file that is not part of the entry bundle.

## Notifications

Apps raise toast-style banners through `window.Notifications`. The host UI renders
them with automatic fade-out removal (exit animation). Each notification has an
id returned by `show()` which can be used to dismiss it explicitly.

### API

**Show a notification:**

```ts
const id = window.Notifications.show({
    title: "My notification",
    body: "This is the message text.",
    app: "ACE_TacPhone_Map",          // optional; uses the app's default icon
    icon: undefined,                  // optional explicit icon URL
    duration: 15000,                  // milliseconds; 0 = permanent until dismissed
    data: { key: "value" },           // arbitrary payload for handlers
    action: (notification) => {       // tap handler: function (page-local only)
        console.log("Tapped!", notification);
        return new Promise(resolve => setTimeout(resolve, 1000));
    },
});
```

**Dismiss a notification:**

```ts
window.Notifications.dismiss(id);
```

### Options

| Field | Required | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `title` | Yes | `string` | — | Short heading for the banner. |
| `body` | No | `string` | — | Message text below the title. |
| `app` | No | `string` | — | App name to resolve a default icon from. |
| `icon` | No | `string` | Resolved from `app` | Explicit icon URL; overrides the app icon. |
| `duration` | No | `number` | `15000` | Auto-dismiss after this many milliseconds. Use `0` for permanent (until dismissed). |
| `data` | No | `unknown` | — | Arbitrary payload available in the tap handler. |
| `action` | No | `NotificationTapHandler` | — | Function run when the notification is tapped; may be async. |

### Tap action

`action` is a single function. It does whatever the sender needs:

```ts
action: (notification: TacPhoneNotification) => void | Promise<void>
```

The function runs when the notification is tapped. It can open/focus panels with
`window.PanelDirectory`, resolve another app's service with `window.AppApi`, or
send data with `window.Networking`; the notification system does not prescribe any
of that.

```ts
window.Notifications.show({
    title: "New message",
    body: "From Alice",
    app: "Messenger",
    data: { conversationId: 42 },
    action: async (notification) => {
        const { conversationId } = notification.data as { conversationId: number };
        window.PanelDirectory.open("Messenger", {
            placement: "tab",
            config: { conversationId },
        });
    },
});
```

### Limitations

- Notification actions are page-local functions. Notifications are not sent from
  the game, and the host does not forward them through `Networking`.
- The notification stack is transient: there is no persistent history or center screen.
- When more than [`MAX_NOTIFICATIONS`](src/Backend/Notifications.ts) (5) are shown,
  the oldest are dropped silently without animation.

## Related documentation

- [`../ACE_TacPhone_Map/README.md`](../ACE_TacPhone_Map/README.md) —
  the reference app and its build.
