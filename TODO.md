# TODO

All incomplete work and code placeholders. Line numbers come from the 2026-10-28
scan (`0536969` plus the uncommitted dev-app discovery refactor) and will drift.
Completed entries are removed; the 2026-11-06 pass deleted 46 finished items.

Tags: **[bug]** breaks behaviour today, **[robustness]** failure path that hangs,
spams, or leaks instead of reporting, **[cleanup]** quality only, **[decision]**
needs a product decision before coding, **[wontfix]** deliberately left as is.

## Native extension (`WebServerExtension`, debug only)

This extension is the debug LAN/dev host. Release builds neither install it nor
start it; the production relay uses the native SQF `webRequest` WebSocket. The
items below are therefore debug-only cleanup unless stated otherwise.

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
- [ ] **[robustness]** 30 MB per-connection message limit with no auth or rate
  limit (`WebServer.cs:352`) is a LAN memory DoS. Lower the limit for control
  frames and reject early.
- [ ] **[robustness]** `app` is never disposed and `SendTo` does not check state
  (`WebServer.cs:341-344`, `:462`). `await app.DisposeAsync()`, null the field,
  guard access.
- [ ] **[robustness]** `WebApplication.CreateBuilder()` inherits
  `ASPNETCORE_ENVIRONMENT` and the game's working directory (`WebServer.cs:116`),
  so a global `Development` value exposes the developer exception page to LAN
  clients (`:138-141`) and picks up stray `appsettings.json`. Pin `Production`
  and an explicit content root (`WebApplicationOptions`).

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
  CS8625 nullable warnings (`WebServer.cs:112`, `DllEntry.cs:40`). The unused
  `using Microsoft.AspNetCore.Mvc` and dead `GetConnectionCount` were removed.
  `CountOpenConnections()` remains as the live connection counter.

## SQF <-> web protocol

- [ ] **[bug]** The dev console opens on every mission start:
  `fnc_loadPhoneBackground.sqf:56-60` (`//#TODO development, remove this`).
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
- [ ] **[feature]** Render `RECTANGLE`/`ELLIPSE` markers, including
  `CfgMarkerBrushes` pattern textures. `MarkerLayer.tsx` already stores `shape`
  and `brush` from `Marker.Upsert`.

### Terrain tile loading

- [ ] **[cleanup]** Major-GC pressure and the first-tile `drawImage`: Chromium
  spends ~560 ms on the first `drawImage` from the multi-megabyte `objects` SVG
  (the SVG layout pass; DevTools reports a forced reflow) and runs repeated major
  GCs while tile canvases are allocated. Page JS cannot suspend V8 GC.
  `transition: 0` on the terrain tile sources avoids rasterizing two zoom levels
  during every zoom, and heavy decode now waits until the base tiles have
  finished loading. Remaining: the first `drawImage` of the heavy SVG still costs
  ~560 ms on the first deep zoom; pre-warming would move it, a raster pyramid
  would remove it. Consider releasing layer SVG text once the GPS masks no longer
  need it.
- [ ] **[cleanup]** Tune `OBJECTS_LOD_MAX_RESOLUTION`,
  `COUNTLINES_LOD_MAX_RESOLUTION` and `MOUNTAINS_LOD_MAX_RESOLUTION`
  (`src/layers/TerrainLayerPriority.ts`) on several maps and screen sizes.
  Expose them as Map options only if users need control.
- [ ] **[feature]** Consider a layer-switcher hint ("zoom in to see this layer")
  for LOD-hidden layers, with localization keys.

### Lifecycle and feedback

- [ ] **[wontfix]** Marker creation failures stay invisible. `Map.tsx:311-316`
  closes the dialog immediately and only logs the error. This is deliberate: the
  dialog should not turn into an error UI. No action planned.
- [ ] **[robustness]** Marker names can collide when two markers are created in
  the same millisecond. `fnc_createMarker.sqf` builds
  `_USER_DEFINED #<player>/ACE_TP<floor (diag_tickTime * 1000)>/<channel>`, so a
  fast batch (or a script/test creating several in one tick) produces duplicate
  names and makes `GetAllMarkers` lookups ambiguous. Add a monotonic counter
  stored in `missionNamespace` (or a random suffix) to the generated name. The
  `marker-protocol` test spaces its creates 50 ms apart as a temporary
  workaround.
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

- [ ] **[cleanup]** `Map.tsx:96` `forceUpdate` hack; a state bump or ref-driven
  redraw would be clearer.

### Polyline drawing (remaining)

- [ ] **[decision]** Polyline markers cannot be edited or deleted from the map:
  the context menu, `Delete` key, and drag/edit paths only handle point markers,
  so a polyline created in the UI is display-only from the Web UI (it can still
  be changed or deleted in-game).
- [ ] **[cleanup]** Persisted measurement labels can overlap when several measured
  polylines are visible at once; there is no label decluttering yet.
- [ ] **[cleanup]** Measurement zoom thresholds are hardcoded
  (`PolylineMeasurementLayer.ts`); evaluate exposing them.
- [ ] **[cleanup]** Custom channel definitions and labels are refreshed only when
  a Map panel mounts; `radioChannelCreate`/`radioChannelSetLabel` later in the
  mission are not picked up until remount.
- [ ] **[cleanup]** No live rubber-band preview in click-per-point mode from the
  last vertex to the pointer or finger while placing vertices. Freehand mode
  draws the line under the pointer while dragging, so this applies to the
  checkbox-selected click-per-point input only.
- [ ] **[cleanup]** No way to move an existing vertex after it is placed; only
  `Undo` of the last vertex is available.
- [ ] **[cleanup]** Freehand sampling distance (5 m) and Ramer–Douglas–Peucker
  simplification tolerance (2 m) are hardcoded in the Map app; expose them
  through `window.TacPhone.options` (the Options panel infrastructure now exists)
  or extract them as named constants.
- [ ] **[decision]** Switching between freehand and click-per-point input
  mid-drawing keeps the existing vertices, so points drawn under both input
  rules can end up in one line. Decide whether a mode switch should reset or
  keep the current stroke.
- [ ] **[cleanup]** No touch/pen pan gesture while freehand drawing: map panning
  during drawing mode is bound to the right mouse button, so touch and pen users
  have no way to move the map without ending the mode.
- [ ] **[cleanup]** Measurement labels and the angle arcs are drawn from the raw
  points with no collision avoidance, so distances, degree texts, the endpoint
  height label (mountain symbol plus number) and the fixed 24 px vertex
  semicircles overlap when vertices are close or the line folds back. The
  `Total` label and the bearing label only have fixed offsets that keep them off
  the endpoint/first-vertex height labels.
- [ ] **[decision]** The angle annotation is purely glyph-based: the arc radius
  (24 px) and the gap between the two semicircles are fixed in pixels regardless
  of zoom, and the arc does not visualise the angle magnitude, only the degrees
  text does. Decide whether the radius should follow the map resolution or the
  angle, and whether the arcs are worth drawing at all.
- [ ] **[decision]** Measurement units are fixed (meters, `km` with two decimals
  from 1000 m, and integer degrees) with no configurable unit or precision.
- [ ] **[decision]** The bearing label covers only the first segment: there are
  no per-segment bearings and no reciprocal/back azimuth, and the 6400 mil circle
  is hardcoded with no degree/mil toggle.
- [ ] **[cleanup]** Vertex heights are requested one request per newly placed
  vertex; only switching to click-per-point backfills existing vertices in a
  batch. A failed request leaves that vertex without a height label, the segment
  loses its `Δh`, and the failure is not retried.
- [ ] **[decision]** Heights are displayed in whole meters ASL only: there is no
  terrain profile or slope view, and the segment height difference is not fed into
  any ballistic solution.

## Radio app (TFAR)

- [ ] **[decision]** Per-radio user label (`displayName` rename) needs a
  storage home; options are per app, not per radio.
- [ ] **[robustness]** RX indicator: GT/intercom receive state has no verified
  TFAR getter, so v1 shows TX only.
- [ ] **[decision]** `allowRemoteTransmit` is a page-local option; a
  server-forced policy would need a CBA setting.
- [ ] **[robustness]** TFAR channel-base assumptions (`set*Channel`,
  `do*Transmit`) must be re-verified on every TFAR major version (see
  [`AGENTS/radio.md`](AGENTS/radio.md)).
- [ ] **[cleanup]** `TF_tangent_*_pressed` are TFAR internals used only as a
  fallback; prefer the event-tracked state if TFAR ever stops setting them.
- [ ] **[robustness]** In-game volume and speaker changes produce no push: the
  verified TFAR CBA event list (see `AGENTS/radio.md`) has no
  volume/speakers-changed event, so the panel only reflects them on the next
  state push. Re-check on every TFAR major version.
- [ ] **[robustness]** In-game verification pass not yet done: run
  `Radio.Debug.State` on a real SR and LR radio to record the actual channel
  bases for `set*Channel`/`do*Transmit` (plan §5.1), and work through the
  transmit-safety checklist (plan §11 phase 4).

## Notifications

### Remaining work

- [ ] notification history / notification center screen is not implemented (transient
  banners only);
- [ ] the Map backup handler cannot perfectly distinguish a moved existing marker from
  a new one before the first `GetAllMarkers` snapshot;
- [ ] the lightweight backup handler has no local player ID while the Map is closed,
  so it treats markers as non-player markers and can notify the local player's own
  marker; obtaining the ID without a MarkerLayerManager is deferred.

## UI style system (military field terminal)

- [ ] **[feature]** Redesign the host shell, host panels, Map/GPS, Messenger and
  SampleApp to one military field-terminal visual language, and export the
  tokens + React primitives through `window.TacPhone.theme` and
  `window.TacPhone.components`. The design, file map and phases are in
  [`plans/PLAN_MILITARY_UI.md`](plans/PLAN_MILITARY_UI.md). Settled up front: the game's
  browser frame supplies the bezel (the page draws no bezel and no outer
  padding) and only system fonts are used (no embedded WOFF/TTF, ever).

## Host (`ACE_TacPhone_Main`)

- [ ] **[bug]** `NetworkingA3.Request` has no timeout (`Networking.ts:306-346`),
  so a promise the game never resolves hangs the in-game UI forever. Add the same
  timeout the WebSocket path uses.
- [ ] **[robustness]** `AppDirectory.fetchExternalModule` leaks blob URLs
  (`AppDirectory.ts:59`) and has a TODO to log unknown app names (`:192`).
- [ ] **[robustness]** `MessageRouter.routeMessage` warns when no subscriber
  exists (`MessageRouter.ts:51`); with broadcasts this fills the release log when
  a panel is closed. Buffer defensively or log at debug.
- [ ] **[bug]** `IsLocalDev()` matches any `http://localhost` prefix
  (`Networking.ts:394`), so `npm run preview` uses dev app URLs while the
  `/devapps/` middleware is `apply: 'serve'` and 404s. Detect the dev server
  explicitly.
- [ ] **[decision]** `App.tsx:316-317` TODO: keep the mobile screen awake and add
  a fullscreen mode (Settings), relevant for the external-browser path.
- [ ] **[feature]** Audio options in the Options panel: a configurable master
  volume with a "play test sound" button so the user hears the new level, and a
  choice of notification sounds per sound type (`message`, `alert`, `success`).
  The engine already synthesises the presets in `Backend/Audio.ts`; expose the
  selected volume/presets through `window.TacPhone.options` and the app-facing
  `AudioApi`, localise the labels, and persist the choices with the layout.
- [ ] **[decision]** Audio output device: `window.TacPhone.audio.setSinkId()` and
  `enumerateDevices()` already exist in `Backend/Audio.ts`, but the game cannot
  report Arma's selected output device, so the browser sink is not mapped to it.
  Wire Arma's device to `setSinkId` once the game can expose it; notification and
  Messenger sounds share the one `AudioContext`.

## Inter-app API (panels and `window.TacPhone.interApp`)

- [ ] **[cleanup]** `PanelDirectory.largest()` ignores floating popups
  (`PanelDirectory.ts`, `isFloating`/`isPoppedOut` are filtered out) because areas
  from separate layouts are not comparable. Rank floats too, or expose a
  per-layout comparison, so a large popup can win routing.
- [ ] **[feature]** GPS routing-event subscriptions for apps. The GPS service
  currently exposes only method calls, so other apps cannot react to navigation
  progress. Add a subscription API on the `gps` service (with an unsubscribe
  handle, and no events while no GPS panel is registered) that publishes:
  - `waypointReached` — waypoint index, remaining waypoints, route distance/ETA;
  - `routeCompleted` — final distance/ETA and the completion timestamp;
  - `routeReplanned` — reason (`offRoute`, `vehicleChange`, manual), old/new
    distance and ETA;
  - `junctionTaken` — the junction/leg just left, the next maneuver kind
    (`left`/`right`/`straight`/road-offroad transition), and the distance and
    estimated time to the next junction.
  Events carry a route revision/id so consumers can ignore updates from a route
  that was replaced, and should reuse the existing `window.TacPhone.interApp`
  lifecycle rather than a new global.
- [ ] **[decision]** Cross-app events/subscriptions beyond method calls (for
  example "markers changed" notifications).
- [ ] **[cleanup]** `interApp.waitFor(service, predicate)` lifecycle helper, so
  consumers can await a registration instead of choosing a `waitMs` budget.

## Tooling and dependencies

- [ ] **[cleanup]** rerun `npm audit`, both builds, and `check:importmap`.
- [ ] **[enhancement]** Brotli app bundles. The container header already carries
  the codec (`TACPHONE-BUNDLE:<version>:<codec>:<base64>`), so the build only has
  to emit `brotli` (`zlib.brotliCompressSync`), add the codec to the Node half,
  and teach the host loader to decode it with `DecompressionStream` once the
  in-game Chromium exposes brotli. Until then the loader reports the codec
  instead of failing to parse it.

## Messenger app (`MessagingApp`)

Web UI (Tasks 4-5), the game half (Task 3) and the Map integration (Task 6) are
implemented; Task 8 verified the workspace build, the copied bundles and the
in-game registration. Behaviour references: `MessagingApp/README.md` and
`../apps/messaging/README.md`.

Remaining work:

- [ ] **[feature]** Messenger position messages. The Map API is ready
  (`map.startRouteTo([x, y])`, with a default Replace/Start behaviour), but the
  Messenger side is not implemented: add a position message composer, a
  `map.position` chat object, a preview, and a **Show me how to get there**
  action that calls `resolveAsync({ service: 'gps', method: 'startRouteTo',
  args: [position] })`. The `gps` service is registered only by GPS panels;
  reuse the `map.gps_route` confirmation/activation path and do not grant the
  action when no GPS panel is mounted.
- [ ] **[decision]** Enable `missionProfileNamespace` persistence and choose the
  save triggers (round end, mission end, periodic), schema migration, size
  limits, and whether state survives mission switches.
  `fnc_serverExportState`/`fnc_serverImportState` exist and are versioned, but
  `GVAR(serverPersistenceEnabled) = false` and only the debug commands call them.
- [ ] **[decision]** Participant colours: `groupColor` is sent empty until the
  future group member colour system exists; use it for participants and the
  sender group accent in `fnc_assembleParticipant.sqf` when it lands.
- [ ] **[decision]** Invite UX: `InviteToRoom` takes recipient UIDs plus the
  room to invite them into, so the shared target selector shows a destination
  room list (current room preselected) together with the player/group picker,
  instead of only a room list. Revisit if a simpler "invite to this room" flow
  is preferred.
- [ ] **[decision]** The Messenger panel does not remember the last open room
  across remounts; the store's `activeRoomId` resets when the app re-syncs.
- [ ] **[bug]** The same `pending` reply still leaves `JoinRoom` and forwarding
  into a new room without a correlated server result; a rejected join only
  surfaces later through `Error`/room pushes. Add a correlated result push
  (request id) or wait for the room/error push in those flows.
- [ ] **[decision]** Cross-device presence: the in-game client is `"local"` and
  its presence is derived from the TacPhone display mode by the game, so
  `setClientPresence` from the page is informational only for that client.
- [ ] **[decision]** Messenger presence/`SetClientPresence` cannot distinguish
  relay clients; SQF sees all requests as `"local"`. Do not attempt per-client
  presence for relay clients until a sender identity is reintroduced.
- [ ] **[decision]** Scoped Messenger pushes (`_client`) are also broadcast to
  every web client because the sender identity is gone. Clients cannot filter
  them; revisit together with the presence identity work.
- [ ] **[decision]** Leaving a room whose whole group is invited is currently
  blocked. Figure out a later flow: leave the in-game group, convert the group
  invite into individual participants, or let the member leave and mark the
  group as partially invited.
- [ ] Fake-player testing limitations: the debug commands and fake players only
  exist in an `__A3_DEBUG__` build. The guarded `fnc_debug*.sqf` files are still
  shipped in release PBOs (bodies compiled out), and the page's debug toolbar
  requires a debug web build, so neither can be exercised in a release client.
- [ ] No unit tests for the store. The reusable Node WebSocket suite lives in
  `MessagingApp/test/` (Task 7; see its README) and needs a running `__A3_DEBUG__`
  game with the host on port 8001, so it is not part of `npm run check`.

## Remote access (public relay)

- [ ] **[cleanup]** `Networking.ts` decides "relay page" vs "direct LAN page" by
  hostname (loopback/LAN IP/mDNS = direct, anything else = relay). A LAN host
  reachable through a public DNS name would be misdetected. Consider an explicit
  marker/header from the relay server instead.
- [ ] **[decision]** Device labels come from `User-Agent`. Add a rename UI and
  persist the label server-side.
- [ ] **[decision]** Relay cache for on-demand `Localization.Get` results. The
  relay's `FileCache` only covers `GetFile` responses, so base-game keys reused
  by the web UI (chat channels, `str_disp_*`, ...) are never in the preloaded
  `stringtable.xml` and every browser asks the game for them again.
  Intercept `{"a":"main","c":"Localization.Get"}` request/reply pairs and cache
  the returned `key -> text` strings in the relay.
  - No content hash or pin verification is needed: assume every player whose
    game language is the same sees the same base-game/mod translations.
  - The relay only sees the `localize` result, which is one language. It must
    learn the connected host's language first, for example from the host's
    `Localization.Info` reply (cache `language` per host session) or by adding
    the language to the relay attach/handshake metadata.
  - Key the cache by `(language, key)` and answer hits for any host/browser
    with that language, so a German host does not serve cache entries to an
    English one. Consider capping it like `TextureCache` and clearing entries
    when a host with a new language connects.
  - This is safe only while translations are add-on-independent; if per-player
    mods can change a `STR_*` value, include the host's stringtable hash in the
    key instead of relying on the language alone.
- [ ] **[cleanup]** Measure the largest individual terrain layer/part on the
  biggest maps and record the margin under the future 10 MB SQF message limit.
- [ ] **[cleanup]** Relay traffic is plaintext at the server (TLS ends in nginx).
  Documented; app-level encryption is not planned.
- [ ] **[robustness]** The in-game hub reconnects with 1–30 s backoff. Verify a
  long offline period does not produce unbounded tasks and that `Stop` cancels
  the timer.
- [ ] **[cleanup]** The relay server is a separate deployable
  (`RemoteServer/`); it is not built or packaged by the add-on. Copy
  `ACE_TacPhone_Main/dist/index.html` into its `wwwroot/` before publishing.
- [ ] **[robustness]** The relay sends `{"t":"ping"}` every 30 s and drops peers
  idle for `IdleTimeoutSeconds` (120 s). The hub and the host page answer with
  `pong`; keep that intact when changing either transport.
- [ ] **[cleanup]** The server stores only the share key hash, so a reconnecting
  game cannot recover the share URL. The hub keeps its own key across reconnects
  until the expiry/Stop; do not clear it on disconnect.
- [ ] **[decision]** Attach rate limiting is per IP (10/min) and counts
  successful attaches, so several devices behind one NAT share the budget.
  Revisit if a household hits it.
- [ ] **[deploy]** `RemoteServer/wwwroot/index.html` is generated: copy
  `ACE_TacPhone_Main/dist/index.html` there after every host change.
- [ ] **[tests]** Native relay verification: connect and `auth` succeed from a
  release build without the DLL; forced drop reconnects with backoff and
  re-sends `auth`/`files`; a save/load leaves `localNamespace` handle null, the
  next `Forward` reports lost and the hub clears/reconnects (or returns to idle
  after `Stop`).
- [ ] **[tests]** `OPTIONS /ws` with `Origin: arma://ACE_TacPhone` echoes the
  origin and returns `GET, OPTIONS, UPGRADE, CONNECT`, `*` headers, max-age 600.
- [ ] **[tests]** A large terrain chunk travels through the hub
  (`LoadGameTerrain` → `encodeTerrainChunks` → `ReplyRequestTerrainSVG`) without
  flooding the page→SQF bridge, and the client assembles it.
- [ ] **[tests]** Every game→web message is broadcast to all relay and LAN
  clients, and no `targets` field is read or written in SQF.
- [ ] **[tests]** Debug LAN: `WEBHOST_DISCONNECT:LOCAL_…` removes the client, drops
  its interests and its pending requests.
- [ ] **[tests]** Messenger presence/`SetClientPresence` and scoped `_client`
  pushes cannot distinguish relay clients (see the Messenger [decision] items
  above); do not add per-client identity until a sender identity exists.
- [ ] **[cleanup]** `RelayManager.ts` `status()` and C# `RemoteAccessService.cs`
  `BuildStatusJsonLocked` assemble the same status fields on both sides. Keep the
  two in sync, or codegen both from one shared schema.
- [ ] **[cleanup]** `TerrainCache.cs` `TryGetPin` logs `LogInformation` on every
  cache hit and miss (the hottest cache path). Consider demoting to Debug/Trace.

## React-free host base (spike)

Explore splitting the host bootstrap so it does not import React:

- a no-React `main` that only builds `window.TacPhone` and the module map,
- React/ReactDOM loaded as host runtime dependencies instead of bundled imports,
- the React UI bundle inlined as a JS string in `index.html` and imported through
  `importShim` from a blob URL,
- `Host.ts` no longer importing React for the version check or
  `PanelContext`/`usePanel`,
- the host dependency manifest including the React files.

Goal: let the phone shell and app loading start before (or without) the React
UI bundle.

## Localization

- [ ] **[cleanup]** All non-English strings are AI translations (each language
  tag carries `ai-translated="true"`). Have native speakers review them before a
  release and drop the attribute per language when a human rewrites it.
- [ ] **[decision]** Runtime stringtable XML loading is disabled
  (`LOAD_STRINGTABLE_FILE = false` in `Backend/Localization.ts`): HEMTT compiles
  `stringtable.xml` to `stringtable.bin` and does not ship the source, so the
  whole table is bundled into `index.html` at build time and the game language
  from `Localization.Info` selects the language block. Re-enable the file loader
  (and the per-app stringtable loader) when the XML is available in the game
  files again.
- [ ] **[robustness]** The bundled default table only ships the languages present
  in `stringtable.xml` at build time. When translations are added, verify the
  browser-language mapping in `Backend/Stringtable.ts` and the `index.html` size.
- [ ] **[decision]** `Localization.Get` (on-demand fallback) was not exercised
  against a deliberately broken stringtable path; do a manual failure drill when
  changing the file loader.


## GPS / route planning

- [ ] **[robustness]** The adaptive foot water-corridor pass is implemented: it
  splits a foot path at the coast, replans each water run on a fine local raster
  with a land-only A*, and only keeps the swim when the replacement is slower or
  an absurd detour. `testRoom` now replans with zero water legs (9.3 km) instead
  of the two avoidable coastal swims. The corridor margin (250–1500 m), fine
  cell (5 m), 3 m water buffer, replacement caps (3× span + 5× water + 750 m,
  1.1× ETA + 60 s), 10 m foot water-sliver fold, 10× weighted-water retry and
  the 2x/alpha-8 mask supersample are first-pass constants; validate them on
  more coastal and island fixtures. `gps-route` passes in Chrome and Firefox.
  `ACE_TacPhone_Map/test/tools/replan-room.mjs --room <name>` is the repro tool.
- [ ] **[feature]** Voice guidance is a test implementation: hardcoded English
  cues once at 500 m and once at 100 m for each road junction, plus one cue per
  road/off-road transition, all using the real distance. Add stringtable
  keys/localization, a voice on/off option, and tune the cue thresholds and
  cooldown against real driving before shipping.
- [ ] **[feature]** Add a Map option to enable/disable the GPS text-to-speech
  announcements. It must gate `GpsModule.speakGuidance()` (no speech, including
  transition cues) while keeping the visual turn indicator and route guidance
  unchanged, use the standard `window.TacPhone.options` mechanism, and default
  to the current test behaviour until the final default is decided.
- [ ] **[decision]** Research how production GPS devices and navigation apps
  decide when to speak: speed-dependent announcement distances, junction vs.
  road-curve detection, the number of cues per maneuver, the minimum gap
  between utterances, how they handle several maneuvers close together, and
  when they deliberately stay silent. Use the findings to tune
  `GpsModule.speakGuidance` (currently one advance cue at 500 m and one final cue
  at 100 m per junction, one cue per transition, 3 s global gap) and document
  the resulting rule before this goes beyond the test implementation.
- [ ] **[cleanup]** `GpsOverlay.tsx` now contains the HUD/route-editor UI plus
  the whole debug dialog, hover sampling, overlay-alpha state and debug effects.
  Move the debug-only JSX, state and listeners into a separate
  `MapGps/GpsDebugOverlay.tsx` component (the canvas painters stay in the
  existing `GpsDebugOverlay.ts`). The production build should not carry debug
  dialog code beyond the feature-flag check.
- [ ] **[feature]** GPS update frequency option. `GPS.Update` currently runs at
  `GPS_UPDATE_INTERVAL = 0.1` (10 Hz) while the GPS interest is held
  (`fnc_onInterestChanged.sqf` starts the CBA PFH). Add a Map/GPS option for
  **10 / 20 / 30 Hz**; when it changes, send a small `GPS.SetUpdateRate` (or
  equivalent) command and restart the PFH with `1 / Hz` (clamp to a sane
  minimum, e.g. 30 Hz). The HUD/follow code already tolerates faster fixes;
  verify CPU cost and that a released interest still stops the PFH.
- [ ] **[robustness]** Verify the slope model against real vehicles/maps: a
  heavy, low-power vehicle should be slower on a steep asphalt pass than a
  light, high-power one, and a longer flatter road should win over a short
  steep one. The 32x32 search grid, 1 m validation spacing and peak
  prominence are tuning constants.
- [ ] **[robustness]** Tune the route planner's grid size, water/road/forest costs and line-of-sight simplification against real maps; the first implementation is deliberately coarse. The road graph now uses a 0.5 m node grid, width-aware snapping capped at 60 m to the closest point along a segment, crossing splits, dangling-node bridges and a flipped SVG Y; ground routing snaps up to 8000 m to the road graph, prefers main/road segments first and uses road-class search factors, then compares the unbiased graph route when it uses more road for a comparable ETA; the route panel `Fastest route` toggle compares the road and grid ETAs. Forest speed and the 3 m/s² entry-speed acceleration limit are first-pass constants; validate them on several maps.
- [ ] **[robustness]** Tune waterResistanceCoef / waterSpeedCoef water speed for amphibious vehicles and the transport-mode advisor's follow delay, cooldown and 60 s / 20% saving threshold.
- [ ] **[decision]** The transport-mode advisor runs only for shared routes. Explore enabling it for locally planned routes too.
- [ ] **[cleanup]** Polyline edit currently moves existing vertices only; adding/removing points and sharing the full polyline geometry are follow-ups.
- [ ] **[cleanup]** The shared-route stored preview uses the sender's language when the GPS/Map app is not mounted; the renderer rebuilds it when mounted.
- [ ] **[cleanup]** Messenger object compression has no codec-version migration path beyond reading the `v` field; document/implement the next version when needed.
- [ ] **[robustness]** Message retention is still unbounded in the game-side Messenger server; compression reduces but does not cap memory.
- [ ] **[tests]** Residual GPS test gaps:
  1. `gps-route` now searches for water within 4 km and asserts both the boat
     route and an amphibious ground vehicle's water leg. The opt-in
     `gps-water-interactive` scenario uses `Debug.PrepareBoat` /
     `Debug.PrepareWaterVehicle` to spawn the actual boat/vehicle and teleports
     the player beside it. A map with no water within 4 km still logs and skips
     the geometry (the boat speed maths stay covered by the unit tier).
  2. Road preference is asserted as "roads are faster per metre than offroad",
     "no water leg for a non-amphibious vehicle" and "the road graph finds a
     connected path between the two waypoints", not as one exact path; exact
     paths depend on the terrain art.
  3. Engine damage is now modelled (`engineHealth` from `getHitPointDamage
     "hitEngine"`) and tested in `gps-speed`; cargo weight is already reflected
     by `getMass`, which the force balance uses. Rain/fog are intentionally not
     modelled (they do not change route choice or ground speed in the GPS), so
     no test is planned for them.
  4. `GetInMan`/`GetOutMan` respawn re-arming is still a decision: first test
     whether the engine transfers unit handlers to the new player automatically
     on respawn; only add a re-arm path if it does not.
  5. `gps-route` now has a synthetic off-route auto-repath case: it enables
     `gpsAutoRepath`, waits the 4 s delay, reapplies an off-route fix and waits
     for `repathCount > 0`. The opt-in interactive tier remains the real-drive
     check.
  6. `gps-protocol` now calls `Debug.GetInterests` around `Interest.Set` when
     the PBO provides it, and asserts the GPS interest appears and then returns
     to its pre-acquire state. The check is defensive so an older PBO logs and
     skips instead of failing.
  7. `gps-route` now asserts the debug viewport scan produces a grid and a
     cost layer. The 1 m fine-validation reroute still has no synthetic
     steep-corridor browser test; it is covered by the implementation and the
     height/cache unit tests.
  8. `gps-route` plans the same foot route twice and asserts the second plan
     adds no new coarse height requests (`heights.coarseRequests`), proving the
     LRU/peak cache reuse. The peak/ring storage itself is also unit-tested.
- [ ] **[decision]** `GetInMan`/`GetOutMan` are installed on the player object when the GPS interest activates. Before adding a `EntityRespawned`/player-change re-arm path, test whether the engine transfers unit event handlers to the new player automatically on respawn. Only add re-arming if that test shows the handlers are lost; otherwise the extra path is unnecessary.
- [ ] **[robustness]** Verify the GPS with Arma running: travel-mode detection, vehicle changes, route calculation with slope/fine validation, the debug viewport scan, shared-route start/join, auto-repath, polyline edit save/cancel and the first-click audio unlock. (`gps-panel`, `gps-route`, `gps-shared`, `gps-protocol` and the opt-in `gps-interactive` now cover most of this automatically; the audio unlock, the viewport scan and a real drive still need a manual pass.)

## Planned work (design docs, not started)

Nothing in this section exists in code. Behavior, file maps, phases and open
questions belong to the plan files; [`AGENTS/plans.md`](AGENTS/plans.md) holds the
rules and the fixed panel ids, addon names and interests. This list exists so a
plan cannot be forgotten, not as a second copy of its checklist.

- [ ] **[feature]** Vehicle controls and Air HUD —
  [`plans/PLAN_VEHICLE_AIRHUD.md`](plans/PLAN_VEHICLE_AIRHUD.md). `ACE_TacPhone_Vehicle` plus
  `addons/tacphone/apps/vehicle` (`ace_tacphone_vehicle`), two panels
  (`ACE_TacPhone_Vehicle`, `ACE_TacPhone_Vehicle_Hud`) and two interests
  (`ACE_TacPhone_Vehicle.anim` 5 Hz, `ACE_TacPhone_Vehicle.state` 20 Hz).
  - Resolve first: which control actions are safe to expose per vehicle class
    (`LandGear`/`autoHover`/`ActiveSensors*` exist only on some airframes), and
    whether the 20 Hz state stream fits the relay's push budget on a full phone
    layout.
- [ ] **[feature]** ACE explosives remote detonation —
  [`plans/PLAN_EXPLOSIVES.md`](plans/PLAN_EXPLOSIVES.md). `ACE_TacPhone_Explosives` plus
  `addons/tacphone/apps/explosives` (`ace_tacphone_explosives`), interest
  `ACE_TacPhone_Explosives.charges`. The game side must store each charge's
  position (ATL/ASL/AGL/dir/class/trigger/detector) and refresh it at 1 Hz;
  detonation validates ids server-side and calls
  `ace_explosives_fnc_detonateExplosive`. TacControl's
  `ACE_explosives_fnc_detonateExplosiveAll` does not exist and must not be called.
  - Resolve first: clacker entries carry no world position, so the registry has
    to be built from `ace_explosives_fnc_getPlacedExplosives` plus the
    `ace_explosives_place`/`_defuse`/`_explodeOnDefuse` events; verify on a real
    ACE version that a defused or moved charge cannot be detonated by a stale id.
- [ ] **[feature]** Messenger personal notes room —
  [`plans/PLAN_MESSENGER_NOTES.md`](plans/PLAN_MESSENGER_NOTES.md). No new app or addon: a
  pinned one-participant `Messaging` room whose blob lives in `profileNamespace`
  under `ace_tacphone_notes_<uid>`, plus `PersonalNotes.Load`/`Save`/`Clear`/
  `Flush` handled locally in
  `apps/messaging/functions/shared/fnc_processBrowserRequest.sqf` before
  `relayToServer`.
  - Resolve first: the `PersonalNotes.*` branches must never reach the relay (a
    branch placed after `relayToServer` would upload private notes); add the
    regression test before the first save path lands.
  - Also still open: the `map.position` rich object is already a separate item in
    the Messenger section above; the notes room does not cover it. Server-side
    persistence and message retention stay there too.
- [ ] **[feature]** Logistics request and tracking app —
  [`plans/PLAN_LOGISTICS.md`](plans/PLAN_LOGISTICS.md).
  `ACE_TacPhone_Logistics` plus `addons/tacphone/apps/logistics`
  (`ace_tacphone_logistics`), interest `ACE_TacPhone_Logistics.requests`.
  Server-authoritative queue and worker roles; every request gets a public
  (empty invite key) Messenger group room with the workers auto-joined;
  locations come from a map marker or a new `pickPosition()` method on the
  `map` service.
  - Resolve first: the room path calls Messenger server internals
    (`ace_tacphone_Messaging_fnc_serverCreateRoom` / `_serverStoreRoom` /
    `_serverBroadcastRoom`) and clears the room's generated `inviteKey`; both
    are `Public: No` — verify they still behave as planned in phase 3.
  - Follow-up (after v1): allow claiming requests — a "claim" button where a
    worker marks themselves on the request (claim/assignment is a non-goal of
    the plan).
- [ ] **[feature]** Messenger public rooms —
  [`plans/PLAN_PUBLIC_ROOMS.md`](plans/PLAN_PUBLIC_ROOMS.md). No new app or
  addon: a public room is a `group` room with an empty `inviteKey` (the
  formalized logistics trick); `CreateRoom` gains `room.public`, new
  `SetRoomPublic` (creator only) and `GetPublicRooms` commands, a
  side-filtered `PublicRooms.State` push, and the room list gains a "Public
  rooms" section with one-tap join. Enemy-side players never see the rooms.
  - Resolve first: the list predicate must stay exactly the `JoinRoom` group
    side check (a listed room must always be joinable); keep the room record
    itself unchanged so the persistence scaffolding format does not move.
- [ ] **[feature]** In-game (non-phone) notifications —
  [`plans/PLAN_IN_GAME_NOTIFICATIONS.md`](plans/PLAN_IN_GAME_NOTIFICATIONS.md).
  Extends the built-in `main` app and the host: a `Notify.Show` request
  renders a `BIS_fnc_showNotification` toast (TacPhone `CfgNotifications`
  templates) on the owning player's screen while the phone is closed;
  `notifications.show()` gains an `inGame` option; local-client only, with a
  machine-wide rate limit. No new app, panel, interest or service.
  - Resolve first: confirm the top-right BIS notification area does not
    collide with mission task toasts on a busy mission, and that the
    `GVAR(currentShowMode)` suppression never double-shows while the phone is
    open.
- [ ] **[decision]** Live GPS tracker entities — scope only, do not design or
  implement yet: [`plans/PLAN_GPS_TRACKERS.md`](plans/PLAN_GPS_TRACKERS.md).
- [ ] **[decision]** Map completeness (RECTANGLE/ELLIPSE markers, marker
  import/export using TacControl's exact schema, per-channel solo, cursor grid
  readout and live-rendered grid, marker owner on hover) — scope only, do not
  design or implement yet: [`plans/PLAN_MAP_COMPLETENESS.md`](plans/PLAN_MAP_COMPLETENESS.md).
