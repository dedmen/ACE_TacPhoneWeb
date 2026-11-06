# TacPhone host runtime tests

Live tests for the TacPhone host (`ACE_TacPhone_Main`). They talk to the running
game over the same WebSocket protocol as the page and use Node built-ins only.

The options registry itself is page-local, so its UI and live Map behaviour are
covered by the browser checklist in [`browser/options-checklist.md`](browser/options-checklist.md).
The Node suite covers the game-facing half: the app catalog, the
`SaveLayout`/`GetLayout` envelope that stores option values together with the
flexlayout model, and the Remote Access relay.

## Prerequisites

- Arma 3 is running a mission with the current TacPhone PBO loaded.
- The TacPhone web host is listening on `wss://localhost:8001/ws`.
- The live runners export and trust the local HTTPS certificate automatically.
  They print the PEM path; for manual Node runs, point `NODE_EXTRA_CA_CERTS` at
  that path. Never disable certificate verification.
- **Close the in-game TacPhone page** before running the layout scenario, or use
  a scratch mission. An open page can save its own layout during the round trip.
  The scenario always restores the previous layout, even after a failure.
- The `remote-access` scenario needs an `__A3_DEBUG__` build with the
  server-controlled **TacPhone > Allow debug mode** setting and the same relay
  host configuration the in-game Remote Access panel uses. Without it the
  scenario is skipped unless you request it explicitly with
  `--scenario remote-access`.
- The `display-mode` scenario briefly opens the phone in HUD/DIALOG/HIDDEN
  states and restores `CLOSED` at the end. It also needs an `__A3_DEBUG__` build
  with **Allow debug mode**.
- The `notify` scenario needs an `__A3_DEBUG__` build with **Allow debug mode**.
  It briefly opens the phone in HUD mode, restores `CLOSED`, and clears the
  notify rate-limit bucket at the end, even after a failure.

### Local certificate

The web host uses a self-signed certificate. Every live runner calls the shared
`test/lib/certificate.mjs` helper before connecting. It reads the certificate
the running host presents (or the newest valid `CN=localhost` dev certificate
from the Windows store), writes it to:

```text
%LOCALAPPDATA%\TacPhone\localhost-test-ca.pem
```

and installs it for that Node process without disabling verification. The PEM
path is printed on every run:

```text
[TacPhone tests] Local HTTPS certificate: C:\Users\...\AppData\Local\TacPhone\localhost-test-ca.pem
[TacPhone tests] If you start Node directly, set:
  $env:NODE_EXTRA_CA_CERTS = "C:\Users\...\AppData\Local\TacPhone\localhost-test-ca.pem"
```

The file is refreshed automatically when the web host regenerates its
certificate, so the suites do not need a manual export step. If the host is not
running yet, the helper falls back to the developer certificate and, when none
exists, creates one with `dotnet dev-certs https`; restart Arma afterwards so the
web host picks it up.

## Run

From `websource`:

```powershell
npm run test:host
npm run test:host-ui
node ACE_TacPhone_Main/test/run-tests.mjs --list
node ACE_TacPhone_Main/test/run-tests.mjs --scenario layout-options --verbose
node ACE_TacPhone_Main/test/run-browser-tests.mjs --scenario audio --slow
```

`npm run test:all` runs this suite together with the Messenger and Map suites
and prints one summary; `-- --suite host` (or `-- --suite host-ui`) narrows it.
`test:host-ui` is the host's Playwright suite (the audio unlock scenario and the
background-tab mounting scenario) and uses the same prerequisites as the other
browser suites: the game web host and the host dev page.

Useful options:

```text
--url <url>          WebSocket URL (default wss://localhost:8001/ws)
--timeout <ms>       Per request timeout (default 8000)
--scenario <name>    One or more scenario names, repeat or comma-separate
--list               List scenario names and exit
--verbose            Log requests and replies
```

## Layout

The `lib/` folder is the **shared** test harness for every browser/Node suite:
the Map and Messenger tests import it instead of keeping copies. Host test code
must never import `ACE_TacPhone_Map`, `MessagingApp` or `SampleApp`.

```text
test/
├── run-tests.mjs                    # Node CLI, connection, scenario runner
├── run-browser-tests.mjs            # Playwright CLI for the host page
├── lib/
│   ├── browser.mjs                  # DEFAULT_PAGE_URL, channel, launchBrowser
│   ├── host-page.mjs                # launchHostPage, openAppThroughChooser, activatePanelTab, requestApp
│   ├── skip.mjs                     # SkipError / skip()
│   ├── ws-client.mjs                # raw RFC 6455 client with Origin header
│   ├── ts-module.mjs                # in-memory Vite bundle loader for unit tests
│   ├── unit-runner.mjs              # --list/--only/--verbose unit CLI
│   └── assertions.mjs               # assertion helpers + runSuite
├── scenarios/
│   ├── apps.test.mjs                # GetAvailableApps includes main/Map/Messaging
│   ├── layout-options.test.mjs      # options envelope survives SaveLayout/GetLayout
│   ├── remote-access.test.mjs       # relay start, share link, remote clients, dead-peer cleanup
│   ├── display-mode.test.mjs        # Debug.SetLocalDisplayMode CLOSED/HUD/DIALOG/HIDDEN
│   ├── notify.test.mjs              # Notify.Show shown/suppression/rate limit/reset
│   ├── audio.test.mjs               # Playwright: first-gesture unlock, keep-alive, pending sound
│   └── background-tabs.test.mjs     # Playwright: a background tab keeps its panel instance
└── browser/
    └── options-checklist.md         # manual Options panel / Map settings checks
```

App-specific helpers stay in the app's own `test/lib/` (the Map keeps
`map-page.mjs` with `openMapPage`, `getMapState`, `getMapView` and the
marker/polyline protocol helpers, plus `gps-page.mjs` with `openGpsPage`,
`getGpsDebug`, `waitForGpsDebug`, `gpsCall`, `gpsT`, `gpsPixel`, `pointAt` and
`distance`; the Messenger keeps `fake-players.mjs`).

### Game-free unit tests

`ts-module.mjs` is the documented exception to "tests never import app source":
it bundles one entry file in memory with Vite (`configFile: false`,
`write: false`, `lib` + ES format), imports the chunk from a `data:` URL and
caches it by `root|entry`. Code that uses the app's own TypeScript pipeline
therefore runs in plain Node, with no artifacts and no extra dependency. A
missing `vite` becomes a `SkipError`.

`unit-runner.mjs` runs the unit modules of one app (`--list`, `--only`,
`--verbose`). `scripts/test-unit.mjs` drives the Messenger and Map runners from
the root `npm run test:unit`. A unit module lives in the app's `test/unit/`,
does not assert at import time, and exports `name`, an optional `description` and
`async run()`. Import only modules that are Node-safe: anything touching
`window`, DOM or OpenLayers at module scope must stay out (the Map's
`gps-payload` case fails loudly if such a module creeps in). `globalThis.window`
may be stubbed inside `run()` and must be deleted in `finally`.

## Adding a scenario

1. Create `scenarios/<name>.test.mjs`.
2. Export `name`, an optional `description`, and `async run({ client })`.
3. Use `client.request(command, payload)`; `a` is always `main`.
4. Add the module to `ALL_SCENARIOS` in `run-tests.mjs` (or
   `run-browser-tests.mjs` for a Playwright scenario).
5. Restore any game state you change (`SaveLayout` is the only writable main
   command used today).

Scenarios must not edit app or SQF source. They may use only the public request
protocol.
