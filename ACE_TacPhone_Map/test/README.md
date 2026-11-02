# TacPhone Map runtime tests

Three tiers for `ACE_TacPhone_Map`:

| Scenario | Kind | Needs |
| --- | --- | --- |
| `gps-speed`, `gps-splice`, `gps-advisor`, `gps-payload` | Unit (`test/unit/`) | Node only |
| `marker-protocol` | Node WebSocket | Arma + TacPhone web host on port 8001 |
| `gps-protocol` | Node WebSocket | Arma + web host; the `map.gps_route` half needs a `__A3_DEBUG__` game |
| `marker-channels` | Playwright browser | Arma + host page + installed Chrome channel (multiplayer adds active-channel checks) |
| `marker-ui` | Playwright browser | Arma + host page + installed Chrome channel |
| `polyline-draw` | Playwright browser | Arma + host page + installed Chrome channel + touch-capable context |
| `polyline-edit` | Playwright browser | Arma + host page + installed Chrome channel |
| `map-view` | Playwright browser | Arma + host page + installed Chrome channel |
| `map-tiles` | Playwright browser | Arma + host page + installed Chrome channel |
| `gps-panel` | Playwright browser | Arma + host page + installed Chrome channel |
| `gps-route` | Playwright browser | Arma + host page + installed Chrome channel |
| `gps-shared` | Playwright browser | Arma + host page + installed Chrome channel |
| `gps-shared-messenger` | Playwright browser | Arma (`__A3_DEBUG__`) + host page + installed Chrome channel |
| `gps-interactive` | Interactive (opt-in) | Arma + host page + Chrome + a human in a vehicle |

The Node scenarios only use the public request protocol
(`a: "ACE_TacPhone_Map"`). The browser scenarios only use the page DOM, test
IDs, ARIA roles, geometry and `getComputedStyle()`. The unit tier is the one
documented exception: it imports browser-free app modules through
`ACE_TacPhone_Main/test/lib/ts-module.mjs`. Nothing edits game files.

## Prerequisites

- Arma 3 is running a mission with the current TacPhone PBO loaded.
- The TacPhone web host listens on `wss://localhost:8001/ws`.
- Node trusts the local HTTPS certificate. Point `NODE_EXTRA_CA_CERTS` at the
  certificate PEM; never disable certificate verification.
- The game must serve the Map app (`GetAvailableApps` contains
  `ACE_TacPhone_Map`). An older PBO without it makes `marker-protocol` skip.
- The 256-character clamp assertion needs a PBO rebuilt after the
  `fnc_createMarker.sqf` clamp (`_text select [0, 256]`) was added.
- Browser scenario: the TacPhone host page is reachable. Set
  `TACPHONE_TEST_URL` (or `--page-url`); the default is
  `http://localhost:5173/`, which is the Vite dev server started by
  `npm run dev` from `websource`. Use `http://localhost:<port>/`, not
  `127.0.0.1`, so the host resolves apps from the dev server.
- Browser scenario: Playwright with an **installed** browser channel. The suite
  launches `chromium.launch({ channel: 'chrome' })` and never downloads a
  Playwright browser build:

  ```powershell
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
  npm install -D playwright
  ```

  Override the channel with `TACPHONE_TEST_BROWSER` (or `PLAYWRIGHT_CHANNEL`),
  for example `msedge`. A missing package or browser is reported as `SKIP`, so
  the Node scenario and the manual checklist stay usable.
- Tests must not be run while another client is expected to be testing: the
  browser scenarios open a Map tab, create markers or polylines and delete them
  again; `marker-ui` leaves the Map panel open. `marker-channels` runs a
  singleplayer layer/color subset and logs that its multiplayer-only checks
  (second channel, active-channel radio, inactive dimming) were skipped.
- `gps-shared-messenger` and the Messenger half of `gps-protocol` need a
  `__A3_DEBUG__` game (fake players and `Messaging.Debug.Status`); they skip
  cleanly otherwise. `gps-shared-messenger` leaves one test room in the session.
- `gps-interactive` needs a human who can get into a vehicle and drive, plus
  `TACPHONE_GPS_INTERACTIVE=1` (or `--opt-in`). It is never part of `test:map`.

## Run

From `websource`:

```powershell
npm run test:map                     # every live scenario
npm run test:unit                    # game-free unit tier (no Arma)
node ACE_TacPhone_Map/test/run-tests.mjs --list
node ACE_TacPhone_Map/test/run-tests.mjs --scenario marker-protocol --verbose
node ACE_TacPhone_Map/test/run-tests.mjs --scenario gps-protocol --verbose
node ACE_TacPhone_Map/test/run-tests.mjs --scenario gps-shared --verbose
node ACE_TacPhone_Map/test/run-tests.mjs --scenario gps-shared-messenger --slow
node ACE_TacPhone_Map/test/run-tests.mjs --scenario map-view --slow
node ACE_TacPhone_Map/test/run-unit-tests.mjs --only gps-advisor --verbose
```

The interactive tier is separate and opt-in:

```powershell
$env:TACPHONE_GPS_INTERACTIVE = '1'
npm run test:gps-interactive -- --slow
npm run test:gps-interactive -- --opt-in --slow
```

Without the environment variable (or `--opt-in`) it prints what the human has to
do and exits 0 with `SKIP gps-interactive: opt-in required`. It is never part of
`test:map` or `test:all`. `TACPHONE_GPS_INTERACTIVE_TIMEOUT_MS` overrides the
wait-for-vehicle timeout (default 180000).

Useful options:

```text
--url <url>          Game WebSocket URL (default wss://localhost:8001/ws)
--page-url <url>     Host page URL (default http://localhost:5173/)
--timeout <ms>       Per request timeout (default 8000)
--scenario <name>    One or more scenario names, repeat or comma-separate
--no-browser         Skip the browser scenarios
--headed             Show the browser window
--slow               Show the browser and slow every Playwright action (700 ms default)
--slow-ms <ms>       Slow-motion delay in milliseconds; implies --slow and --headed
--list               List scenarios and exit
--verbose            Log requests and scenario progress
```

`marker-ui` runs headless only assertions; `--headed` is a debugging aid, not a
requirement. `--slow` is for watching the run: it always shows the browser and
adds the delay to every Playwright action. `--slow-ms 1200` gives an even slower
walkthrough; `TACPHONE_TEST_BROWSER=msedge` changes the visible browser.

Browser scenarios open the Map the way a user does: they create a new flexlayout
tab with the tabset **Add** button, select **Map** in the app chooser, then wait
for the terrain view and a quiet tile-loading period (750 ms without a tile
start/end/error) before asserting anything. A map that is still painting
therefore cannot make a marker or polyline assertion flaky.

`map-tiles` additionally asserts that terrain layers are scheduled in priority
order (terrain, roads, town names, airports, forests, rocks, mountains, unknown
layers, then the heavy `objects` and `countlines`), that the heavy layers
activate only after the complete reply and every light layer, and that they are
LOD-hidden at a coarse view, so they start no tiles until the map is zoomed in.
The check reads only `getViewState()` and skips the heavy-layer assertions on a
terrain that has no `objects` / `countlines` layer.

## Benchmark

`test/benchmark/tile-size.mjs` is not a test and never runs as part of
`test:map` or `test:all`. It measures the terrain tile crop in the installed
Chrome with synthetic SVG layers and needs neither Arma nor the host page:

```powershell
node ACE_TacPhone_Map/test/benchmark/tile-size.mjs
node ACE_TacPhone_Map/test/benchmark/tile-size.mjs --headed --runs 5 --sizes 128,256,512
```

It reports the SVG decode, the first tile crop and one full viewport of tiles per
tile size. It does not measure the game protocol, so confirm a change to
`TERRAIN_TILE_SIZE` on a real map with `map-tiles` and the `getViewState()`
timings before shipping it.

`test/benchmark/map-terrain-live.mjs` measures the real thing: it opens the Map
through the host page, waits for the initial load, then pans and zooms and
reports per-layer `activatedAfterMs`/`firstTileStartMs`, pan/zoom settle time,
requested tile counts and long tasks. It needs Arma serving terrain plus the dev
server, and it rewrites `TERRAIN_TILE_SIZE` per size and restores the source at
the end:

```powershell
node ACE_TacPhone_Map/test/benchmark/map-terrain-live.mjs
node ACE_TacPhone_Map/test/benchmark/map-terrain-live.mjs --sizes 128,256 --runs 2
node ACE_TacPhone_Map/test/benchmark/map-terrain-live.mjs --headed --page-url http://localhost:5173/
```

Use it before changing `TERRAIN_TILE_SIZE` or the LOD cut-offs. It is opt-in
(not in `test:map`/`test:all`) because it needs a running game with terrain data.

## Layout

```text
test/
├── run-tests.mjs                     # CLI, connection, scenario runner (live)
├── run-unit-tests.mjs                # game-free unit runner (Vite loader)
├── run-interactive-tests.mjs         # opt-in interactive runner (a human needed)
├── lib/
│   ├── map-page.mjs                  # open Map page + marker/polyline protocol helpers
│   └── gps-page.mjs                  # open GPS page, debug state, gps.* calls, pointAt
├── unit/
│   ├── gps-speed.unit.mjs            # legSpeed speed model
│   ├── gps-splice.unit.mjs           # RouteSplice helpers + shared route codec
│   ├── gps-advisor.unit.mjs          # TransportModeAdvisor state machine
│   ├── gps-routing.unit.mjs          # route metrics, turns, deviation, road graph
│   ├── gps-payload.unit.mjs          # map.gps_route contract + loader guard
│   └── terrain-layer-priority.unit.mjs # terrain rank/LOD planning
├── benchmark/
│   ├── tile-size.mjs                 # opt-in TERRAIN_TILE_SIZE crop benchmark
│   └── map-terrain-live.mjs          # opt-in real-game terrain load/pan/zoom benchmark
├── scenarios/
│   ├── marker-protocol.test.mjs      # types/channels, custom RGBA colors, text clamp
│   ├── marker-channels.test.mjs      # multiplayer layer visibility + active dimming
│   ├── marker-ui.test.mjs            # dialog placement/scrollbar, SelectMenu portal/search, colors
│   ├── polyline-draw.test.mjs        # mouse clicks, touch taps, freehand strokes
│   ├── polyline-edit.test.mjs        # vertex drag, save, cancel and the upsert guard
│   ├── map-view.test.mjs             # zoom, pan, flyTo bbox and the temporary highlight
│   ├── map-tiles.test.mjs            # terrain load priority and heavy-layer LOD
│   ├── gps-panel.test.mjs            # HUD, fix, travel mode, options, interest, read-only markers
│   ├── gps-route.test.mjs            # waypoint clicks, air/foot/ground/boat routes, follow, cleanup
│   ├── gps-shared.test.mjs           # shared preview/discard/bad payload/start-join/replace
│   ├── gps-shared-messenger.test.mjs # Share route -> Messenger card -> preview -> Start
│   ├── gps-protocol.test.mjs         # GetPlayerTravelMode, GPS.Update rate/release, route round trip
│   └── gps-interactive.test.mjs      # opt-in: follow in a vehicle, deviate, auto-repath
└── browser/
    └── marker-create-checklist.md    # manual fallback checklist
```

The shared harness (`browser.mjs`, `host-page.mjs`, `skip.mjs`, `assertions.mjs`,
`ws-client.mjs`, `ts-module.mjs`, `unit-runner.mjs`) lives in
`ACE_TacPhone_Main/test/lib/` and is imported from there; only the Map-specific
helpers stay in this folder.

## GPS specifics

Browser GPS scenarios open the GPS panel through the app chooser
(`openGpsPage`), wait for `.ol-viewport` and a quiet terrain period, and then use
only `window.__TACPHONE_MAP_TEST__`:

- `getGpsDebugState()` — module state, active route, shared preview, advisor
  prompt, layer feature/dash/colour state, player icon and the debug counters
  `fixCount`, `vehicleChangesApplied` and `repathCount` (`repathCount` counts
  only auto-repaths that actually replaced the route, so
  `gps-interactive` can wait for the off-route recovery).
- `gps.*` — waypoints, `calculateRoute()`, start/stop, mode, planning, shared
  route open/start/discard, advisor accept/dismiss, `setLiveUpdates`,
  `applyFix`, `applyVehicle`, `getTerrainBounds`, `getPixel`, `queryWater`.

Every coordinate is terrain-relative (`pointAt(state.position, …)` clamped by
`getTerrainBounds()`); a scenario must never depend on where the map designer put
roads or water. When a test needs a deterministic position or speed it pauses the
live `GPS.Update` pushes with `setLiveUpdates(false)` and feeds `applyFix()`.
Cleanup always stops navigation, clears waypoints, discards a shared preview,
restores option values and re-enables live updates. `gps-shared-messenger` also
restores the `window.TacPhone.networking.Request` wrapper it uses to capture the
compressed `SendMessage` objects.

## Adding a scenario

1. Create `scenarios/<name>.test.mjs`.
2. Export `name`, a `kind` (`node`, `browser` or `interactive`), an optional
   `description`, and `async run(context)`.
3. `node` scenarios receive `{ client, url, options, log }`; `browser` and
   `interactive` scenarios receive `{ pageUrl, options, log }`.
4. Add the module to `ALL_SCENARIOS` in `run-tests.mjs`. `interactive`
   scenarios go into `run-interactive-tests.mjs` only — never into the live list
   or `scripts/test-all.mjs`.
5. Restore any game state you change; delete every marker the scenario creates.
6. Throw `skip('reason')` (from `ACE_TacPhone_Main/test/lib/skip.mjs`) when a
   prerequisite is missing instead of failing.

## Adding a unit module

1. Create `unit/<name>.unit.mjs`; export `name`, an optional `description` and
   `async run()`. Do not assert at import time.
2. Import app modules with `loadAppModule(<abs path>, { root: <appDir> })` from
   `ACE_TacPhone_Main/test/lib/ts-module.mjs` (resolve the path from
   `import.meta.url`, not from the working directory).
3. Import only Node-safe modules. Anything that touches `window`, DOM or
   OpenLayers at module scope must stay out; stub `globalThis.window` inside
   `run()` and delete it in `finally`.
4. Register the module in `run-unit-tests.mjs`.

## Test analysis rules

- Assertions must be deterministic and headless-capable: DOM state, attributes,
  test IDs, ARIA roles, geometry and `getComputedStyle()`.
- Canvas-rendered values (marker label color) are asserted through the pure
  helpers on `window.__TACPHONE_MAP_TEST__` (dev server or game debug mode), not
  by reading pixels. Live channel/layer/marker state is read through
  `window.__TACPHONE_MAP_TEST__.getMapState()`, which reports the same channel
  dimming and resolved custom colors that the OpenLayers style functions apply.
  Terrain readiness and per-layer tile counters come from `getViewState()`; GPS
  state, route/layer styles and the `repathCount` counter come from
  `getGpsDebugState()`.
- The interactive scenario is the only place that may depend on a human, and only
  after the explicit opt-in. Its follow window is derived from the route
  (`max(120 s, distance / expectedSpeed * 4)`), never a fixed constant.
- Local OCR/image analysis is allowed only when it runs on the test machine
  without a cloud service. AI image analysis needs a `@LocalAgentHigh` subagent
  on the maintainer's machine, after asking the user, and must never be part of
  normal pass/fail.
