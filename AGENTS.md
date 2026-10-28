# AGENTS.md

TacPhone web UI + dev web host. This dir is the `ACE_TacPhoneWeb` submodule at
`addons/tacphone/websource`; parent HEMTT excludes it. Build here, then copy
outputs into the parent add-on. No root `package.json`. All incomplete
tasks/placeholders must be listed in `TODO.md`.

## Layout
- `ACE_TacPhone_Main/` — host: React UI, networking, app loader, public API. Run host cmds here.
- `ACE_TacPhone_Main/devapps/ACE_TacPhone_Map/` — reference app; separate deps.
- `WebServerExtension/` — .NET 10 NativeAOT `arma_webhost_x64`; external-browser dev only.
- `WebHostExtension_FeatureFlagsExport/` — C shim for `RVExtensionFeatureFlags`; `WebServerExtension/featureflags.obj` is checked in and linked.

## Commands
Host (`ACE_TacPhone_Main`):
```powershell
npm install
npm run dev            # Vite; open printed URL
npm run build          # tsc -b + vite + d.ts bundle/sync + import-map check
npm run build:debug    # unminified + inline sourcemaps
npm run lint           # oxlint
npx tsc -b             # typecheck only
Copy-Item dist\index.html ..\..\data\index.html
```
Map (`ACE_TacPhone_Main/devapps/ACE_TacPhone_Map`):
```powershell
npm install
npm run build
Copy-Item dist\ace_tacphone_map.js ..\..\..\..\apps\map\data\ace_tacphone_map.js
```
Both copy destinations are git-ignored in ACE3. No tests. Release strips `console.log/debug/info`, keeps warn/error. Node 20.19+/22.12+.

## Dev
- Use `http://localhost:<port>`, never `127.0.0.1`: `IsLocalDev()` matches exact `http://localhost` prefix.
- Arma + TacPhone must run; extension serves `wss://localhost:8001/ws`; local ASP.NET TLS cert must be trusted.
- App dir must be real `devapps/<AppName>/`; loader hardcodes `/devapps/<AppName>/src/main.tsx`; `ace_tacphone_devFile` ignored. Name = config class = request `a`. Junction works; symlink unreliable with Vite.
- Don't use map's own `npm run dev` (no host globals/import map/WebSocket).

## Runtime constraints
- In-game browser: sandboxed Chromium 126; no `fetch`/XHR/`localStorage`/`IndexedDB`. Use `window.Networking`.
- Never re-enable `StrictMode` in `src/main.tsx`: it double-creates app constructors/mounts.
- Production app = one self-contained ESM imported from blob URL: no relative imports, dynamic chunk imports, `React.lazy` local chunks, CSS side files, or `new URL(..., import.meta.url)`. Inline CSS/assets (map: `build/singlefile.ts`).
- `ACE_TacPhone_Main/shared-modules.js` is sole source for host import map, `window` globals, app build externals, checker. Shared only: `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, `react/compiler-runtime`. Keep external; apps cannot add mappings; add to `shared-modules.js` + `src/main.tsx`. `npm run check:importmap` validates host + app bundles (also runs in builds).

## API/contract
- App-facing API: `src/TacPhoneMain.ts` (re-exports `Backend/Types.ts`, `Networking`, `AppDirectory`, `CommandRegistry`).
- `npm run build` emits `dist/TacPhoneMain.d.ts` + syncs to `devapps/*/src/TacPhoneMain.d.ts`. Never edit synced copies. External app: host build, then `npm run sync:api-types -- <app-src>`.
- App exports `GetTacPhoneApps()` + optional `OnMessageFromGame()`. Panel `id` global + persisted in layouts; components get no props. One message handler/app: route `c` via `window.TacPhoneUtils.CommandRegistry`.
- Requests: `window.Networking.Request({a:'<AppName>', c:'...'})` -> app's SQF `ace_tacphone_requestProcessor`; may return JSON or promise. `window.AppDirectory` read-only.
- Register game side in `addons/tacphone/apps/*/ace_tacphone_apps.hpp` (or mission `description.ext`); config class = routing `a` = dev folder.

## WebServerExtension
```powershell
dotnet publish ArmaServerSide.csproj -c Release -p:Platform=x64
```
Output `bin\x64\Release\net10.0\win-x64\publish\arma_webhost_x64.dll`. `dotnet build` gives managed IL only; publish for native. `.slnx` fails in dotnet CLI (C++ vcxproj needs VS MSBuild); build csproj directly. Keep `featureflags.obj` linked (unescaped extension args). DLL is not packaged/committed.

`WebServer.cs`: `GET /` asks game for file via `GetFile` (2s timeout); `/ws` forwards JSON to SQF and injects sender `s`. Update `src/Backend/Networking.ts` + `addons/tacphone/XEH_postInit.sqf` with protocol changes.

Docs: `ACE_TacPhone_Main/README.md`, `devapps/ACE_TacPhone_Map/README.md`.
