# ACE TacPhone Map

The map app for ACE TacPhone. It is also the reference implementation for a
TacPhone app: it registers panels, draws the map, and exchanges marker data with
the game through the TacPhone request protocol.

| Item | Path |
| --- | --- |
| App registration | `addons/tacphone/apps/map/ace_tacphone_apps.hpp` |
| SQF request processor | `addons/tacphone/apps/map/functions/fnc_processBrowserRequest.sqf` |
| App entry point | `src/main.tsx` |
| Production bundle | `dist/ace_tacphone_map.js` |
| File loaded in game | `addons/tacphone/apps/map/data/ace_tacphone_map.js` |

## Requirements

- Node.js 20.19+ or 22.12+.
- Arma 3 2.24+ (or the 2.23 dev branch). See the
  [host README](../ACE_TacPhone_Main/README.md#requirements) for why the phone
  UI needs this version.
- Chromium 126+ for the in-game or external browser.

## Development

The app is loaded by the host dev server, not by its own `index.html`:

1. Keep this folder next to `ACE_TacPhone_Main`. The host discovers it as a
   development app because `package.json` declares:
   ```json
   "tacphone": { "app": "ACE_TacPhone_Map" }
   ```
2. Install dependencies in this folder:
   ```powershell
   npm install
   ```
3. Start the host dev server. Running this from either folder works:
   ```powershell
   npm run dev
   ```
   In this folder, `npm run dev` forwards to `../ACE_TacPhone_Main`, so the app
   still gets `window.Networking`, `window.AppDirectory`, the host import map,
   and the WebSocket connection.
4. Open the URL Vite prints (normally `http://localhost:5173`). Keep TacPhone
   open in Arma so the page can connect to `wss://localhost:8001/ws`.
5. Select the Map panel in the TacPhone app chooser.

The host exposes the whole folder as
`/devapps/ACE_TacPhone_Map/` and imports the entry named by
`ace_tacphone_devFile` in
[`ace_tacphone_apps.hpp`](../../apps/map/ace_tacphone_apps.hpp), which is
`src/main.tsx`. Changes hot-reload through the host server.

The `"tacphone.app"` value must match the `ace_tacphone_apps` config class. It is
the routing key used by the game and the host. The folder itself can have any
name; if this folder is not next to `ACE_TacPhone_Main`, list it in the host's
`dev-apps.local.json` or `TACPHONE_DEV_APPS` environment variable.

## Build

Build the app from this folder:

```powershell
npm run build
```

`tsc -b && vite build --mode release` emits:

```text
dist/ace_tacphone_map.js
dist/ace_tacphone_map.d.ts
```

`ace_tacphone_map.d.ts` is the public type surface for other apps (see
[Map service](#map-service-other-tacphone-apps)); it is generated from
`src/MapApi.ts` by the host's shared declaration bundler.

`npm run build` is a release build: the JavaScript is minified, no source map is
embedded, and `console.log` / `console.debug` / `console.info` calls are removed.
Use `npm run build:debug` for an unminified build with an inline source map;
`console.warn` and `console.error` calls are kept in both builds.

For local in-game testing, copy it to the path registered by
`ace_tacphone_file`:

```powershell
Copy-Item dist\ace_tacphone_map.js ..\..\apps\map\data\ace_tacphone_map.js
```

Then open TacPhone in Arma. Release/build tooling must do the same copy; the
generated files are git-ignored.

## App contract

`src/main.tsx` exports:

```ts
import type { AppPanelInfo } from './TacPhoneMain';

export function GetTacPhoneApps(): AppPanelInfo[]
export function OnMessageFromGame(message: object): void | Promise<void>
```

The current panels are:

- `ACE_TacPhone_Map` — the OpenLayers map (`src/Map.tsx`).
- `ACE_TacPhone_Map_Placeholder` — a small placeholder panel.

A panel has a globally unique `id`, an `appComponent` created with no props,
`GetDefaultTitle()`, and `GetTacPhoneIcon()`. See the
[host app contract](../ACE_TacPhone_Main/README.md#app-contract) and the generated
`src/TacPhoneMain.d.ts` (written by the host build) for the full definitions.

Game requests use:

```ts
await window.Networking.Request({
    a: 'ACE_TacPhone_Map',
    c: 'GetAllMarkers',
});
```

The map's SQF processor handles `GetAllMarkers`, `CreateMarker`, and
`GetMarkerTypes`. Messages from the game are routed through
`mapCommandRegistry` (`src/CommandRegistry.ts`), which is an instance of the
host's `window.TacPhoneUtils.CommandRegistry`.

### Map service (other TacPhone apps)

Each mounted Map panel exposes the inter-app service `map` (version `1`). It is
built in `src/Map.tsx` after the OpenLayers map exists and registered with
`window.AppApi.register(panel, { service: 'map', version: 1, api })`, where
`panel` comes from `window.TacPhoneUtils.PanelContext`; the registration is
removed before the map is torn down. The API is `flyTo({ x, y, resolution?,
animate? })`, `getView()` (returns `{ x, y, resolution }` or `undefined`), and
`isReady()`. Coordinates are map/world units, not latitude/longitude.
`resolution` keeps the current zoom when omitted and `animate: false` jumps
instead of animating. A `flyTo()` that arrives before the terrain SVG has loaded
is queued and applied after the initial fit, so routing into a freshly opened Map
popup still lands on the requested position.

Other apps resolve it through `window.AppApi.resolveAsync({ service: 'map', ... })`
(see the host's [Inter-app API](../ACE_TacPhone_Main/README.md#inter-app-api)).
The build also emits `dist/ace_tacphone_map.d.ts`, a self-contained declaration
file that exports `MapApi`, `MapViewState`, `MapFlyToOptions`, `MAP_SERVICE`, and
`MAP_SERVICE_VERSION`, so consumers can type the resolved API without depending
on OpenLayers. It is generated by the shared
`ACE_TacPhone_Main/scripts/bundle-api-types.mjs --app` script; the app does not
keep its own copy.
This is browser-side only; the game talks to the Map through the request
processor and command registry described above, never through this API.

## Marker notifications

The Map app generates toast-style `window.Notifications` for marker updates:

- **New markers**: The game sends `{ a: "ACE_TacPhone_Map", c: "Marker.Upsert",
  marker: [...] }`. An open Map's `MarkerLayerManager` handles it through the
  `Marker.Upsert` command and raises a "New map marker" notification. A closed Map
  (no mounted instance) falls back to a module-scope handler that only raises the
  notification.
- **Duplicate names ignored**: The first `Marker.Upsert` for a marker name raises
  the notification and records the name. Subsequent position updates for that name
  do not notify again.
- **Tap behavior**: Tapping a marker notification uses `window.AppApi.resolveAsync()`
  with `policy: "ask"` to select between multiple Map panels that provide the `map`
  service, then calls `MapApi.flyTo({ x, y })` on the chosen panel. The target chooser
  presents all candidates (floating popups and docked tabs). Default host lifetime is
  15 seconds; use `duration: 0` in your code for permanent notifications until dismissed.

No notification-specific SQF code is needed; the game-side markers are handled by
the request processor and command registry, while the host UI generates banners.

## Packaging constraints

The production loader reads the entry file from the game filesystem and imports
it from a blob URL. The Map build therefore stays a single ESM entry file:

- Format is `es`.
- React is external and resolves through the host import map.
- No bundle-relative dynamic imports, `React.lazy` imports, or relative imports.
- CSS is inlined by `build/singlefile.ts`; no sidecar CSS file is emitted.
- Only `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, and
  `react/compiler-runtime` may remain bare external imports. The host import map
  provides all five.

`vite.config.ts` takes the external list from the host's
[`shared-modules.js`](../ACE_TacPhone_Main/shared-modules.js), which also generates
the host import map:

```ts
external: [...SHARED_MODULE_SPECIFIERS],
output: {
    codeSplitting: false,
}
```

The build runs `scripts/check-shared-imports.mjs` afterwards and fails if the
bundle contains a bare import that the host does not provide.

This is a packaging choice for the Map app, not a hard limitation of the host.
Extra JavaScript or CSS files can be shipped separately and loaded on demand
with `window.Networking.LoadGameFileText`; see
[Loading additional files manually](../ACE_TacPhone_Main/README.md#loading-additional-files-manually).
The trade-off is an extra game-filesystem read before the module or stylesheet
can be used, so cache the loaded file. A relative `.js` import from the entry
bundle still cannot resolve next to the blob URL.
