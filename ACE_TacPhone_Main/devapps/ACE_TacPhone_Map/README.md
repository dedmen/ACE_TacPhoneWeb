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
  [host README](../../README.md#requirements) for why the phone UI needs this
  version.
- Chromium 126+ for the in-game or external browser.

## Development

The app is loaded by the host dev server, not by its own `index.html`:

1. Make sure this folder is available as
   `ACE_TacPhone_Main/devapps/ACE_TacPhone_Map`.
2. Install dependencies in this folder:
   ```powershell
   npm install
   ```
3. In `ACE_TacPhone_Main`, run:
   ```powershell
   npm run dev
   ```
4. Open the URL Vite prints (normally `http://localhost:5173`). Keep TacPhone
   open in Arma so the page can connect to `wss://localhost:8001/ws`.
5. Select the Map panel in the TacPhone app chooser.

The host imports the app from
`/devapps/ACE_TacPhone_Map/src/main.tsx`. Changes hot-reload through the host
server. Do not use the standalone `npm run dev` in this folder for TacPhone
testing: it does not provide `window.Networking`, `window.AppDirectory`, the host
import map, or the WebSocket connection.

The app name registered in `ace_tacphone_apps.hpp` must remain
`ACE_TacPhone_Map`; it is both the config key and the folder name used by the dev
loader. `ace_tacphone_devFile` is currently documentation/future use; keep the
entry at `src/main.tsx` until the loader honors it.

## Build

Build the app from this folder:

```powershell
npm run build
```

`tsc -b && vite build --mode release` emits:

```text
dist/ace_tacphone_map.js
```

`npm run build` is a release build: the JavaScript is minified, no source map is
embedded, and `console.log` / `console.debug` / `console.info` calls are removed.
Use `npm run build:debug` for an unminified build with an inline source map;
`console.warn` and `console.error` calls are kept in both builds.

For local in-game testing, copy it to the path registered by
`ace_tacphone_file`:

```powershell
Copy-Item dist\ace_tacphone_map.js ..\..\..\..\apps\map\data\ace_tacphone_map.js
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
[host app contract](../../README.md#app-contract) and the generated
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
[`shared-modules.js`](../../shared-modules.js), which also generates the host
import map:

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
[Loading additional files manually](../../README.md#loading-additional-files-manually).
The trade-off is an extra game-filesystem read before the module or stylesheet
can be used, so cache the loaded file. A relative `.js` import from the entry
bundle still cannot resolve next to the blob URL.
