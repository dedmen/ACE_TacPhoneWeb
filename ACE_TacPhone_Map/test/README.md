# TacPhone Map runtime tests

Two scenario kinds for `ACE_TacPhone_Map`:

| Scenario | Kind | Needs |
| --- | --- | --- |
| `marker-protocol` | Node WebSocket | Arma + TacPhone web host on port 8001 |
| `marker-channels` | Playwright browser | Arma + host page + installed Chrome channel (multiplayer adds active-channel checks) |
| `marker-ui` | Playwright browser | Arma + host page + installed Chrome channel |
| `polyline-draw` | Playwright browser | Arma + host page + installed Chrome channel + touch-capable context |
| `map-view` | Playwright browser | Arma + host page + installed Chrome channel |

The Node scenario only uses the public request protocol
(`a: "ACE_TacPhone_Map"`). The browser scenario only uses the page DOM, test
IDs, ARIA roles, geometry and `getComputedStyle()`. Neither imports app or SQF
source, and neither edits game files.

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

## Run

From `websource`:

```powershell
npm run test:map
node ACE_TacPhone_Map/test/run-tests.mjs --list
node ACE_TacPhone_Map/test/run-tests.mjs --scenario marker-protocol --verbose
node ACE_TacPhone_Map/test/run-tests.mjs --scenario marker-channels --verbose
node ACE_TacPhone_Map/test/run-tests.mjs --scenario marker-ui --headed
node ACE_TacPhone_Map/test/run-tests.mjs --scenario polyline-draw --headed
node ACE_TacPhone_Map/test/run-tests.mjs --scenario map-view --slow
```

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

## Layout

```text
test/
├── run-tests.mjs                     # CLI, connection, scenario runner
├── lib/
│   ├── ws-client.mjs                 # raw RFC 6455 client with Origin header
│   ├── assertions.mjs                # assertion helpers
│   ├── browser.mjs                   # Playwright launcher (installed channel)
│   ├── map-page.mjs                  # open Map page + game request/state helpers
│   └── skip.mjs                      # SkipError for missing prerequisites
├── scenarios/
│   ├── marker-protocol.test.mjs      # types/channels, custom RGBA colors, text clamp
│   ├── marker-channels.test.mjs      # multiplayer layer visibility + active dimming
│   ├── marker-ui.test.mjs            # dialog placement/scrollbar, SelectMenu portal/search, colors
│   ├── polyline-draw.test.mjs        # mouse clicks, touch taps, freehand strokes
│   └── map-view.test.mjs             # zoom, pan, flyTo bbox and the temporary highlight
└── browser/
    └── marker-create-checklist.md    # manual fallback checklist
```

## Adding a scenario

1. Create `scenarios/<name>.test.mjs`.
2. Export `name`, a `kind` (`node` or `browser`), an optional `description`, and
   `async run(context)`.
3. `node` scenarios receive `{ client, url, options, log }`; `browser`
   scenarios receive `{ pageUrl, options, log }`.
4. Add the module to `ALL_SCENARIOS` in `run-tests.mjs`.
5. Restore any game state you change; delete every marker the scenario creates.
6. Throw `skip('reason')` (from `../lib/skip.mjs`) when a prerequisite is
   missing instead of failing.

## Test analysis rules

- Assertions must be deterministic and headless-capable: DOM state, attributes,
  test IDs, ARIA roles, geometry and `getComputedStyle()`.
- Canvas-rendered values (marker label color) are asserted through the pure
  helpers on `window.__TACPHONE_MAP_TEST__` (dev server or game debug mode), not
  by reading pixels. Live channel/layer/marker state is read through
  `window.__TACPHONE_MAP_TEST__.getMapState()`, which reports the same channel
  dimming and resolved custom colors that the OpenLayers style functions apply.
  Terrain readiness and per-layer tile counters come from `getViewState()`.
- Local OCR/image analysis is allowed only when it runs on the test machine
  without a cloud service. AI image analysis needs a `@LocalAgentHigh` subagent
  on the maintainer's machine, after asking the user, and must never be part of
  normal pass/fail.
