# AGENTS.md

TacPhone web UI + dev web host. This dir is the `ACE_TacPhoneWeb` submodule at
`addons/tacphone/websource`; parent HEMTT excludes it. Build here, then copy
outputs into the parent add-on. Root `package.json` is an npm workspace. All
incomplete tasks/placeholders must be listed in `TODO.md`.

## Layout
- `packages/tacphone-api/` — `@ace-tacphone/api`, the app-facing contract types (`src/index.ts`, `src/globals.ts`). Apps import types from it and read `window.TacPhone` directly.
- `packages/tacphone-build/` — `@ace-tacphone/build`: `shared-modules.js`, `singlefile.ts` (imported as `@ace-tacphone/build/singlefile`), and the `tacphone-build` CLI (`bundle-api-types`, `sync-api-types`, `check-shared-imports`). See its `README.md`.
- `ACE_TacPhone_Main/` — host: React UI, networking, app loader, public API.
- `ACE_TacPhone_Map/` — reference app, sibling of the host.
- `SampleApp/` — minimal example app.
- `WebServerExtension/` — .NET 10 NativeAOT `arma_webhost_x64`; external-browser dev only.
- `WebHostExtension_FeatureFlagsExport/` — C shim for `RVExtensionFeatureFlags`; `WebServerExtension/featureflags.obj` is checked in and linked.

## Commands
Workspace root:
```powershell
npm install            # one root lockfile and hoisted workspace deps
npm run dev            # host Vite; open printed URL
npm run build          # host + Map + SampleApp builds
npm run build:host
npm run build:apps
npm run check          # tsc -b in every workspace package
npm run lint
npm run sync:api-types -- <source.d.ts> <target-dir-or-file>...   # app declaration copier
```
Host (`ACE_TacPhone_Main`):
```powershell
npm run build          # tsc -b + vite + shared-import check
npm run build:debug    # unminified + inline sourcemaps
npx tsc -b             # typecheck only
Copy-Item dist\index.html ..\..\data\index.html
```
Apps (`ACE_TacPhone_Map`, `SampleApp`):
```powershell
npm run build          # tsc -b + vite + shared-import check + bundle-api-types -> dist\*.d.ts
Copy-Item dist\ace_tacphone_map.js ..\..\apps\map\data\ace_tacphone_map.js
```
Both copy destinations are git-ignored in ACE3. No tests. Release strips `console.log/debug/info`, keeps warn/error. Node 20.19+/22.12+.

## Dev
- Use `http://localhost:<port>`, never `127.0.0.1`: `IsLocalDev()` matches exact `http://localhost` prefix.
- Arma + TacPhone must run; extension serves `wss://localhost:8001/ws`; local ASP.NET TLS cert must be trusted.
- App discovery: `dev-apps.local.json` (git-ignored, `{ "apps": [...] }`), `TACPHONE_DEV_APPS` path list, or sibling folder with `"tacphone": { "app": "<AppName>" }` in `package.json`. Host serves all as `/devapps/<AppName>/`; loader uses `ace_tacphone_devFile` (default `src/main.tsx`). Name = config class = request `a`. Move/extend discovery in `dev-apps.js`; no junctions needed. Restart Vite after changing discovery config.
- The Map's `npm run dev` forwards to the host's Vite server; apps have no standalone dev server.
- VS Code debugging: app files are served from `/@fs/<absolute path>`, so `devAppsPlugin` rewrites their dev source maps to absolute source paths; keep that patch or breakpoints in app sources never bind (they land in `.../@fs/D:/...` temporary files). Host files still map through `webRoot`.

## Runtime constraints
- In-game browser: sandboxed Chromium 126; no `fetch`/XHR/`localStorage`/`IndexedDB`. Use `window.TacPhone.networking`.
- `StrictMode` is enabled in `src/main.tsx` on purpose: React mounts components twice in development. Panel-instance creation, app loading, layout restore, and every app lifecycle side effect must stay idempotent. Do not disable StrictMode to hide a double-mount bug.
- Production app = one self-contained ESM imported from blob URL: no relative imports, dynamic chunk imports, `React.lazy` local chunks, CSS side files, or `new URL(..., import.meta.url)`. Inline CSS/assets with `@ace-tacphone/build/singlefile` (`packages/tacphone-build/singlefile.ts`).
- `packages/tacphone-build/shared-modules.js` is sole source for host import map, `window` globals, Vite dedupe, app build externals, checker. Shared only: `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, `react/compiler-runtime`. Keep external; apps cannot add mappings; add to `shared-modules.js` + `src/main.tsx`. `tacphone-build check-shared-imports` (`npm run check:importmap`) validates host + app bundles (also runs in builds).
- Panel system mounts only the selected tab of a tabset, so background panels have no live instance or registered API; route with `window.TacPhone.interApp.resolveAsync()` (it activates and waits). Floating popups are in-layout; native window popouts (`'window'` sub-layouts) need `window.open` and are unsupported in the in-game browser.

## API/contract
- App-facing contract: `@ace-tacphone/api` (`packages/tacphone-api`). Apps import types from it (`import type { AppProps, AppPanelInfo, ... } from '@ace-tacphone/api'`) and never import host code. `ACE_TacPhone_Main/src/TacPhoneMain.ts` is the host-internal re-export of the same contract; apps must not import it.
- `window.TacPhone` is the only app-facing host global: `apiVersion`, `reactVersion`, `networking`, `apps`, `panels`, `interApp`, `interests`, `notifications`, `utils`. `utils.PanelContext` / `utils.usePanel()` live under `window.TacPhone.utils`.
- App entry module exports a required `apiVersion` (must equal `TACPHONE_API_VERSION`, checked exactly), optional `init()`, `GetTacPhoneApps()` returning `AppPanelInfo[]` or a promise of it, and optional `OnMessageFromGame(message)`. Panel components receive `AppProps` (`appId`, `panelId`, `node`, `model`, `panel`). Apps read the host from the global `window.TacPhone`; it is not passed as a prop or argument. Panel `id` is persisted in layouts. One message handler per app: route `c` via `window.TacPhone.utils.CommandRegistry`.
- App declarations: every app exports its inter-app service contract from `src/api.ts` and builds a self-contained `dist/<name>.d.ts` via `tacphone-build bundle-api-types --app . --entry src/api.ts --name <Name>`. `package.json` `types`/`exports` point at that file. `tacphone-build sync-api-types <source.d.ts> <target-dir-or-file>...` copies an app declaration to explicit consumers. The host no longer generates or syncs `TacPhoneMain.d.ts`; there is no host declaration copy in any app.
- Register game side in `addons/tacphone/apps/*/ace_tacphone_apps.hpp` (or mission `description.ext`); config class = routing `a`, and dev discovery maps that name to an app folder.
- Inter-app: an app registers a service with `window.TacPhone.interApp.register(panel, { service, version, api })` from its panel lifecycle (panel handle from `AppProps.panel` / `window.TacPhone.utils.usePanel()`; clean up on unmount), and other apps route with `resolveAsync()`; a missing app is opened as a floating popup by default (`placement` option / `window.TacPhone.panels.open()`). APIs are page-local, never reachable from the game, and have no permission model: the whole UI and all apps are one trust domain, and everything stays inside the single page/tab (no native window popouts).
- Requests: `window.TacPhone.networking.Request({a:'<AppName>', c:'...'})` -> app's SQF `ace_tacphone_requestProcessor`, called with `[request, clientId]` (`"local"` in-game, websocket id remotely); may return JSON or promise. `window.TacPhone.apps` is the read-only app/panel catalog.
- **Interest**: `window.TacPhone.interests.acquire(name)` returns a refcounted disposer; re-announced on WS reconnect. Game: registry `ace_tacphone_AppDataInterests`, commands `Interest.Set` / `Interest.Clear` handled by the `main` request processor (which receives the client id), CBA events `ace_tacphone_interestActivated` / `ace_tacphone_interestDeactivated` with payload `[interestName]`.

## SQF
- Performance is very important in SQF; prefer the cheapest expression that does the job and avoid per-call allocation/iteration.
- Avoid type checks in SQF wherever possible. Assume the correct types are sent: the web code validates data before sending it to SQF, so re-checking there is redundant and type checking is expensive in SQF.

## WebServerExtension
```powershell
dotnet publish ArmaServerSide.csproj -c Release -p:Platform=x64
```
Output `bin\x64\Release\net10.0\win-x64\publish\arma_webhost_x64.dll`. `dotnet build` gives managed IL only; publish for native. `.slnx` fails in dotnet CLI (C++ vcxproj needs VS MSBuild); build csproj directly. Keep `featureflags.obj` linked (unescaped extension args). DLL is not packaged/committed.

`WebServer.cs`: `GET /{**path}` asks game for any app file via `GetFile` (2s timeout, content type by extension, 404 on empty); `/ws` validates `Origin` (same `Host` authority, or loopback for dev) then forwards JSON to SQF and injects sender `s`. CORS is loopback-only. Update `src/Backend/Networking.ts` + `addons/tacphone/XEH_postInit.sqf` with protocol changes.

Docs: `ACE_TacPhone_Main/README.md`, `ACE_TacPhone_Map/README.md`, `packages/tacphone-build/README.md`.
