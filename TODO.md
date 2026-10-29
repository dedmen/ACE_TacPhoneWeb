# TODO

All incomplete work and code placeholders. Line numbers come from the 2026-10-28
scan (`0536969` plus the uncommitted dev-app discovery refactor) and will drift.

Tags: **[bug]** breaks behaviour today, **[robustness]** failure path that hangs,
spams, or leaks instead of reporting, **[cleanup]** quality only, **[decision]**
needs a product decision before coding, **[wontfix]** deliberately left as is.

## Persist the TacPhone layout in-game

- [ ] Implement `GetLayout` and `SaveLayout` in
  `addons/tacphone/functions/fnc_processBrowserRequest.sqf`.
  - `SaveLayout` should store the `layout` value from the request so it can be
    returned later for the same player/phone.
  - `GetLayout` should return the stored layout instead of an empty hashmap.
- [ ] Keep `localStorage` as the external-browser persistence path and use the
  SQF path when `localStorage` is unavailable (the in-game browser).
- [ ] Remove the temporary placeholder comments in
  `ACE_TacPhone_Main/src/App.tsx` and avoid sending `SaveLayout` on every layout
  change once the SQF persistence is implemented.

## Native extension (`WebServerExtension`)

### Critical: silent failure and process kill

*Fixed 2026-10-29: guarded synchronous start, try/catch on every export, bounded
shutdown (11 ms restart with a live socket, was 31 s), 2 s closes with `Abort()`.*

- [x] **[bug]** Startup errors are swallowed. `WebServer.cs:236` discards the
  `app.RunAsync()` task, `DllEntry.cs:88` returns `1` for every outcome, and
  `XEH_postInit.sqf:99-101` prints "Webhost started" regardless.
  Verified failures: port already bound (`IOException`) and missing HTTPS cert
  (`InvalidOperationException`). Replace with a guarded synchronous
  `StartAsync().GetAwaiter().GetResult()`, keep the task for post-start faults,
  and return the error to SQF.
- [x] **[bug]** No export has a try/catch (`DllEntry.cs:20-36, 42-89`). In
  NativeAOT an exception crossing a reverse P/Invoke terminates the Arma process.
  Wrap every export, return a status, never let a managed exception escape.
  Reachable paths: `Stop()`'s `.Wait()` wrapping `AggregateException`,
  `new WebServer(port)` failing, `SendTo` touching a stopped host.
- [x] **[bug]** Mission restart blocks the game thread up to 30 s.
  `Stop()` is `app.StopAsync().Wait()` (`WebServer.cs:341-344`) while the WS loop
  waits on `ReceiveAsync(..., CancellationToken.None)` (`:368`). Measured
  31,008 ms with one non-responsive peer (suspended phone tab / dropped Wi-Fi).
  Configure `HostOptions.ShutdownTimeout` (1-2 s), pass a shutdown token into the
  WS loop, and `Abort()` the socket on timeout. Never block the Arma thread
  unbounded.
- [x] **[bug]** Close paths can hang and throw out of the handler.
  `CloseAsync(..., CancellationToken.None)` at `WebServer.cs:35, 377, 389`.
  Wrap in a short `CancellationTokenSource`, catch, `Abort()`.

### Protocol correctness

- [ ] **[bug]** WS JSON is spliced by character index: `messageJson.Insert(1,
  $"\"s\":...")` (`WebServer.cs:402`, TODO at `:396`). Empty frame throws, `{}`
  produces invalid JSON, arrays/BOM break. Parse with `JsonNode`, require an
  object, add `s` as a property, reserialize; reply with a protocol error frame
  on bad input instead of dropping the connection.

- [ ] **[bug]** One client's 2 s timeout cancels another's request.
  `WebServer.cs:189-221`: concurrent GETs share a `TaskCompletionSource`, and the
  first waiter calls `TrySetCanceled()` on it. Give each request its own timeout,
  never cancel the shared source, and pass `context.RequestAborted`.
- [ ] **[robustness]** `SendTo` is fire-and-forget and silently drops unknown
  targets (`WebServer.cs:459-463`, `:86-94`), while the SQF continuation assumes
  delivery (`XEH_postInit.sqf:76-85`). Return a delivery status to SQF.
- [ ] **[robustness]** 30 MB per-connection message limit with no auth or rate
  limit (`WebServer.cs:352`) is a LAN memory DoS. Lower the limit for control
  frames and reject early.
- [x] **[robustness]** `_webServer` is published after the server already
  listens (`DllEntry.cs:60` vs `WebServer.cs:236`), so an early request can lose
  its `FileContent` and 504. Construct, assign, then start.
- [ ] **[robustness]** `app` is never disposed and `SendTo` does not check state
  (`WebServer.cs:341-344`, `:462`). `await app.DisposeAsync()`, null the field,
  guard access.
- [ ] **[robustness]** `WebApplication.CreateBuilder()` inherits
  `ASPNETCORE_ENVIRONMENT` and the game's working directory (`WebServer.cs:116`),
  so a global `Development` value exposes the developer exception page to LAN
  clients (`:138-141`) and picks up stray `appsettings.json`. Pin `Production`
  and an explicit content root (`WebApplicationOptions`).
- [ ] **[cleanup]** `_fileCache` is dead (`WebServer.cs:418`, TODO at `:456`).
  Add caching with correct threading, or delete the field.

### Security and TLS (needs a decision)

- [ ] **[decision]** LAN clients can read any file the game VFS exposes and
  drive the WS API. `MapGet("/{**filePath}")` forwards every path to `loadFile`
  (`WebServer.cs:179-193`, `XEH_postInit.sqf:29-55`); `Origin` is not
  authentication, so a non-browser client just sends a matching header. Decide:
  pairing token, path-prefix allowlist, configurable bind address, and/or a
  README warning.
- [ ] **[decision]** HTTPS falls back to the machine dev cert (`CN=localhost`,
  loopback SANs only, expires 2027-04-13), so `https://192.168.x.x:8001` always
  shows a name mismatch. Generate/load a cert with LAN SANs or document a
  one-time trust step.
- [ ] **[bug]** `UseUrls("https://[::]:{port}")` fails silently when IPv6 is
  disabled. Bind explicitly or fall back to IPv4.
- [ ] **[cleanup]** Loopback CORS/origin check accepts any scheme and port on
  `localhost`/`127.0.0.1`/`::1` (`WebServer.cs:262-302`), wider than the "Vite
  dev server" comment claims. Consider pinning the dev port.

### Build and packaging

- [ ] **[cleanup]** Remove redundant package refs (`Microsoft.AspNetCore.Http`,
  `Microsoft.AspNetCore.WebSockets`, `Microsoft.Extensions.Hosting`); they are
  pruned by the shared framework (NU1510).
- [ ] **[cleanup]** `linker.xml` is unreferenced and names the wrong namespace
  (`arma_webhost.*` vs `ArmaServerSide`). Delete it; the csproj's
  `--export-dynamic-symbol` is what works.
- [ ] **[cleanup]** Delete `Properties/launchSettings.json` (a library has no
  entry point) and fix `FolderProfile.pubxml` (`Any CPU` vs x64, nested
  `publish\win-x64\win-x64`).
- [ ] **[cleanup]** `csproj:30` references `FeatureFlags.obj` but the checked-in
  file is `featureflags.obj`: breaks on case-sensitive agents and silently
  ignores edits to `FeatureFlags.c`. Compile the C file in the build instead.
- [ ] **[cleanup]** `IsTrimmable=false` is misleading under `PublishAot`; the two
  CS8625 nullable warnings (`WebServer.cs:112`, `DllEntry.cs:40`); unused
  `using Microsoft.AspNetCore.Mvc` and unused `BroadcastAsync`/`GetConnectionCount`.
- [x] **[cleanup]** Return codes are uninformative (`DllEntry.cs:88`:
  unknown method, missing arg, failed start, success all return 1).
  `RvExtensionVersion` ignores `outputSize`; `RvExtension` writes nothing.
- [ ] **[cleanup]** Diagnostics only go to `Console.WriteLine`, which is invisible
  in the native host. Add a file log or callback so startup/shutdown failures are
  visible.

## SQF <-> web protocol

- [ ] **[bug]** Terrain/texture round trip leaks requests.
  `fnc_processBrowserRequest.sqf`: `_success` from `sendCommandToPhone` is
  computed then ignored (`:62-64`, `:110-112`), `deleteAt` results are used
  without a null check (`:81`, `:130`), and failed requests never resolve their
  promise. Reply with an error, clean up on failure, and consider a timeout.
- [ ] **[bug]** Request-ID collisions: `hashValue [systemTime, ...]` (`:52`,
  `:99`) has second resolution, so two identical requests in the same second
  overwrite each other's promise. Combine a counter with the config hash.
- [ ] **[cleanup]** Terrain and texture promises share one map
  (`GVAR(pendingTerrainRequest)`), keyed only by ID. Split them or rename.
- [ ] **[bug]** `systemChat` spam on every file request
  (`XEH_postInit.sqf:41, 43, 52`), and `:48` passes an array to `systemChat`,
  which expects a string, so 404s raise a script error instead of logging. Gate
  behind a debug flag and use `diag_log`/`str`.
- [ ] **[bug]** The dev console opens on every mission start:
  `fnc_loadPhoneBackground.sqf:76-80` (`//#TODO development, remove this`).
- [ ] **[decision]** Only `/` is remapped to the addon data folder
  (`XEH_postInit.sqf:33-36`); every other path resolves from the game root, so
  the catch-all is "read game files", not "serve app assets". Restrict or document.
- [ ] **[robustness]** The 2 s file timeout (`WebServer.cs:196`) races main-thread
  stalls (mission load), and `Networking.ts:339-346` has no retry. Allow a longer
  first-load budget or retry once.
- [ ] **[cleanup]** `GVAR(AppInfo) getOrDefaultCall [_appTarget, {createHashMap}]`
  followed by an `"UNKNOWN HANDLER"` default hides routing bugs
  (`XEH_postInit.sqf:69-70`, `fnc_loadPhoneBackground.sqf:49-50`). Log and reply
  with an error instead.

## Map app (`ACE_TacPhone_Map`)

### Rendering correctness

- [ ] **[bug]** Unvalidated marker `size`/`polyline` produce `NaN`
  (`MarkerLayer.tsx:390, 398-402`): empty size yields `[0]`, odd-length polylines
  pass the `parts[i + 1] !== ''` check with `undefined`.
- [ ] **[cleanup]** Per-frame style allocation and deep clones
  (`MarkerLayer.tsx:220-295`); the shadow `Style.clone()` also duplicates the
  label with no displacement. Precompute per type/state.
- [ ] **[cleanup]** `MarkerLayer.tsx:74` TODO: marker types/colors are fetched per
  map instance; load once and share.
- [ ] **[cleanup]** Icon offset and shadow displacement are hardcoded and wrong
  for scaled markers (`MarkerLayer.tsx:262, 285`).
- [ ] **[cleanup]** `MarkerLayer.tsx:481` TODO: only a subset of marker properties
  is applied; the rest are ignored.
- [ ] **[cleanup]** `MarkerApi.ts:49` TODO: marker `channel` is not configurable
  in the UI.

### Lifecycle and feedback

- [ ] **[wontfix]** Marker creation failures stay invisible. `Map.tsx:311-316`
  closes the dialog immediately and only logs the error. This is deliberate: the
  dialog should not turn into an error UI. No action planned.
- [ ] **[bug]** `MarkerLayer.destroy()` only unregisters handlers
  (`MarkerLayer.tsx:146-171`). In-flight `GetMarkerTypes`/`GetAllMarkers`/icon
  loads still run and mutate an unmounted layer. Add a `destroyed` flag checked
  after every `await`.
- [ ] **[bug]** Initial marker load can hang forever behind a request with no
  in-game timeout, while queued operations grow unbounded
  (`MarkerLayer.tsx:146-162, 361-372`). Issue both requests in parallel, add a
  timeout, bound the queue (drop-oldest + warn), and catch per item in the flush
  loop (it currently runs in `.finally`, outside the try/catch).
- [ ] **[robustness]** `destroy()` does not stop in-flight requests (same as
  above) and there is no way to cancel an outstanding `Networking.Request` from
  the app. Consider adding cancellation to the public API.
- [ ] **[cleanup]** Duplicate icon cache: `MarkerCreateDialog.tsx:81-114`
  duplicates `MarkerLayerManager.markerTextures`, doubling game requests and
  risking divergence.
- [ ] **[cleanup]** `LayerSwitcher.tsx:27-62` only tracks add/remove; visibility
  and title changes made elsewhere leave the checkboxes stale.

### App surface

- [ ] **[bug]** The placeholder panel ships: `ACE_TacPhone_Map_Placeholder`
  ("Wololo!", `src/main.tsx:29-41`, documented at `README.md:101`). Panel ids are
  persisted in layouts, so removing it later breaks saved layouts. Remove now.
- [ ] **[wontfix]** `src/CommandRegistry.ts:1` reads `window.TacPhoneUtils` at
  module scope. Host globals are always present when an app is loaded (apps are
  only loaded through the host; the standalone `preview` path is not supported),
  so no guard is needed.
- [x] **[bug]** `dist/ace_tacphone_map.d.ts` is `export { }` (12 bytes) although
  `package.json` points `types`/`exports` at it. Fixed: the Map build calls the
  shared `ACE_TacPhone_Main/scripts/bundle-api-types.mjs --app ...` script, which
  emits a self-contained declaration exporting `MapApi`, `MapViewState`,
  `MapFlyToOptions`, `MAP_SERVICE`, and `MAP_SERVICE_VERSION`. Apps no longer
  keep their own copy of that bundler.
- [ ] **[cleanup]** Broadcast log spam when no map panel is mounted:
  `routeMessage` warns for every `Marker.Upsert`/`Delete` (`MessageRouter.ts:51`)
  and `console.warn` survives the release strip. Log at debug level.
- [ ] **[cleanup]** `Map.tsx:96` `forceUpdate` hack; a state bump or ref-driven
  redraw would be clearer.
- [x] **[cleanup]** `README.md:66` omits the emitted `.d.ts` from the build
  outputs. Updated; the Map README now lists both `ace_tacphone_map.js` and
  `ace_tacphone_map.d.ts`.

## Notifications

### Remaining work

- [ ] notification history / notification center screen is not implemented (transient
  banners only);
- [ ] the Map backup handler cannot perfectly distinguish a moved existing marker from
  a new one before the first `GetAllMarkers` snapshot;
- [ ] the lightweight backup handler has no local player ID while the Map is closed,
  so it treats markers as non-player markers and can notify the local player's own
  marker; obtaining the ID without a MarkerLayerManager is deferred.

## Host (`ACE_TacPhone_Main`)

- [ ] **[bug]** `NetworkingA3.Request` has no timeout (`Networking.ts:306-346`),
  so a promise the game never resolves hangs the in-game UI forever. Add the same
  timeout the WebSocket path uses.
- [ ] **[bug]** `main.tsx` terrain/texture proxying only logs failures; the game
  is never told the request failed and the browser waits for its timeout.
- [ ] **[robustness]** `AppDirectory.fetchExternalModule` leaks blob URLs
  (`AppDirectory.ts:59`) and has a TODO to log unknown app names (`:192`).
- [ ] **[robustness]** `MessageRouter.routeMessage` warns when no subscriber
  exists (`MessageRouter.ts:51`); with broadcasts this fills the release log when
  a panel is closed. Buffer defensively or log at debug.
- [ ] **[bug]** `IsLocalDev()` matches any `http://localhost` prefix
  (`Networking.ts:394`), so `npm run preview` uses dev app URLs while the
  `/devapps/` middleware is `apply: 'serve'` and 404s. Detect the dev server
  explicitly.
- [ ] **[cleanup]** `src/MainApps/main.tsx:12` TODO: move the compression helpers
  out of the app entry.
- [x] **[cleanup]** `AppChooserPanel.tsx:56` TODO: load panel state from the
  model instead of ad-hoc state. The selected app is read back from the tab config
  in `componentDidMount()` via `PanelInstance.getConfig()`; the chooser element
  itself is still local component state.
- [x] **[decision]** Host UI for `AppApi.setTargetChooser(...)`. The
  user-selection dialog (panel title, panel/app id, instance id or tab id,
  floating badge, area) is implemented in `src/Panels/TargetChooserDialog.tsx`
  and installed once by `ACE_TacPhone_Main/src/App.tsx`, so `policy: "ask"` is a
  user choice instead of the focused -> largest -> only-candidate heuristic.
  Cancel, a backdrop click, Escape, and a newer request superseding a pending one
  all resolve `undefined`.
- [ ] **[decision]** `App.tsx:316-317` TODO: keep the mobile screen awake and add
  a fullscreen mode (Settings), relevant for the external-browser path.
- [ ] **[cleanup]** Remove the temporary `SaveLayout`/`GetLayout` placeholders
  once the game-side persistence exists (see the first section).
- [x] Removed all references to and handling of the legacy `devapps/` folder.
  Discovery now only uses `dev-apps.local.json`, `TACPHONE_DEV_APPS`, or sibling
  folders with the `"tacphone"` marker; `AGENTS.md`, `ACE_TacPhone_Main/README.md`,
  `dev-apps.js`, `vite.config.ts`, `AppDirectory.ts` and
  `scripts/sync-api-types.mjs` were updated. The `/devapps/<AppName>/` URL prefix
  is unchanged.

## Inter-app API (panels and `AppApi`)

- [x] **[decision]** Native window popouts (`PanelInfo.isPoppedOut`,
  `'window'` sub-layouts) need `window.open` and a separate document, so they
  cannot work in the in-game sandboxed browser. **Decision: not supported.**
  Everything stays inside the single page/tab; floating in-layout popups are the
  only popup placement. `isPoppedOut` stays as passive diagnostics for a
  sub-layout the host never creates.
- [ ] **[cleanup]** `PanelDirectory.largest()` ignores floating popups
  (`PanelDirectory.ts`, `isFloating`/`isPoppedOut` are filtered out) because areas
  from separate layouts are not comparable. Rank floats too, or expose a
  per-layout comparison, so a large popup can win routing.
- [x] **[cleanup]** Restore the app chooser selection on first mount from the
  persisted layout. `AppChooserPanel.componentDidMount()` now reads
  `PanelInstance.getConfig().panelId` and switches to that app when it is still
  registered; `setPanelConfig()` keeps writing the value for the next reload.
- [ ] **[decision]** Messenger app consuming the `map` service with
  `policy: 'ask'` (the routing API and the target dialog exist; no Messenger app
  does yet).
- [ ] **[decision]** Cross-app events/subscriptions beyond method calls (for
  example "markers changed" notifications).
- [ ] **[cleanup]** `AppApi.waitFor(service, predicate)` lifecycle helper, so
  consumers can await a registration instead of choosing a `waitMs` budget.
- [x] **[decision]** Auth/permissions between apps. **Decision: no permission
  model.** Page-local calls are deliberately unauthenticated; the whole web UI and
  all its apps are one trust domain with no security boundaries between apps.

## Tooling and dependencies

- [ ] **[cleanup]** rerun `npm audit`, both builds, and `check:importmap`.
