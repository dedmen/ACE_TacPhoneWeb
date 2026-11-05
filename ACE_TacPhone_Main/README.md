# ACE TacPhone Web UI

`ACE_TacPhone_Main` is the web UI for ACE TacPhone. It provides the phone shell,
the app chooser, the panel/layout system and the bridge between the browser and
the game. The same build runs as a normal web page during development and inside
Arma's in-game browser.

## Features

- **Panels and tabs**: docked tabsets plus floating in-layout popups, with a
  draggable split layout.
- **App chooser**: every open tab can pick an installed app. Apps that fail to
  load are reported instead of breaking the rest of the UI.
- **App settings**: a built-in Options panel, opened from the app chooser. Apps
  register their own options and presets; values persist with the layout.
- **Notifications and sounds**: toast banners with optional tap actions and
  built-in synthesised notification sounds. The phone must be clicked once
  before autonomous sounds can play: browsers only unlock audio on a user
  gesture, and later sounds (including app-driven ones) reuse that unlocked
  context.
- **Inter-app services**: apps can expose versioned APIs to each other, for
  example Messenger opening a marker on the Map.
- **Demand-driven data**: apps announce interests so the game only streams data
  that an open page currently needs.
- **Remote access**: the public relay serves the same page over a share link.
  The game connects with Arma's native `webRequest` WebSocket; the in-game page
  is the hub for relay and LAN clients. See
  [`AGENTS/remote.md`](../AGENTS/remote.md).

## Requirements

| Component | Minimum | Notes |
| --- | --- | --- |
| Node.js | 20.19+ or 22.12+ | Vite 8 and the current toolchain. |
| Arma 3 | 2.24+ | Needs `CT_CONTROL_REF`, `ctrlWebBrowserAction ["SetControlReference", ...]` and `SetBrowserInternalSize`. |
| Browser | Chromium 126+ | Same feature set outside the game: ES modules, import maps, blob module imports, compression streams. |

The in-game browser is sandboxed: `fetch`/XHR cannot reach the network (only
`data:` and `blob:` URLs work), and there is no `localStorage` or `IndexedDB`.
Use `window.TacPhone.networking` for everything and inline assets in app bundles.

## Development

Install once in `websource`, then start the host:

```powershell
npm install
npm run dev
```

Open the printed URL (normally `http://localhost:5173`) in an external Chrome
window. Use `localhost`, not `127.0.0.1`: the host selects the dev transport from
that exact prefix. Keep Arma running in a `__A3_DEBUG__` build with TacPhone
open; the page connects to `wss://localhost:8001/ws`, served by the debug-only
TacPhone web host extension. Release builds have no LAN extension. Without the
game (or in a release build) the page reports a connection failure.

Development apps are discovered from `dev-apps.local.json`, the
`TACPHONE_DEV_APPS` environment variable, or sibling folders whose
`package.json` declares `"tacphone": { "app": "<AppName>" }`. Restart Vite after
changing discovery configuration.

## Build

```powershell
npm run build:all      # build + install into the game (web + PBO; debug also installs the DLL)
npm run build:debug    # web-only iteration (no PBO install)
npm run build          # release, only when explicitly requested
```

Both web builds produce a single self-contained `dist/index.html` with the script
and import map inlined. The root scripts also copy it to `..\data\index.html`; no
manual copy is needed. `build:all` is still required to rebuild and install the
PBO. Debug builds are unminified with an inline source map. Release builds are
minified, omit the source map and strip `console.log/debug/info`, while keeping
`warn`/`error`.

## Layout persistence

The flexlayout model is saved per browser profile. Outside the game it lives in
`localStorage` under `tacphone.layout`. In-game it is gzipped and stored through
the `main` app's `SaveLayout`/`GetLayout` in `profileNamespace`. Both paths
coalesce changes (at most one save every 5 seconds, flushed when the page hides),
and panel ids are part of the layout, so tabs reopen the same apps.

## Developing apps

An app is a self-contained ES module exporting `apiVersion`, `GetTacPhoneApps()`
and optionally `init()` / `OnMessageFromGame()`. Apps never import host code:
they use the global `window.TacPhone` and the `@ace-tacphone/api` types.

Start from `SampleApp` for the minimal end-to-end app, or use
[`ACE_TacPhone_Map`](../ACE_TacPhone_Map/README.md) as the reference app. The
contract, option schema, inter-app services, interests, packaging rules and
development discovery are documented in:

- [`AGENTS/apps.md`](../AGENTS/apps.md) — app contract, services, packaging.
- [`SampleApp/README.md`](../SampleApp/README.md) — copy-and-rename template.
- [`packages/tacphone-api/README.md`](../packages/tacphone-api/README.md) — exported types.
- [`AGENTS/host.md`](../AGENTS/host.md) — host internals and public API changes.

## Localization

All user-readable text goes through `window.TacPhone.localization.t()`; keys live
in `addons/tacphone/stringtable.xml` (`Host`, `Options`, `RemoteAccess`,
`Common` containers for the host). The host decodes a compressed default table
bundled into `index.html` before the first render and replaces it with the game
stringtable once connected. See
[`AGENTS/localization.md`](AGENTS/localization.md).

## Tests

The live suites need Arma, the TacPhone web host and a trusted local HTTPS
certificate:

```powershell
npm run test:host      # host protocol, layout/options, remote access
npm run test:messaging # Messenger scenarios
npm run test:map       # Map protocol and browser scenarios
npm run test:all       # all of the above, one summary
```

See [`test/README.md`](test/README.md) for the host suite's prerequisites and
the manual Options checklist in [`test/browser/options-checklist.md`](test/browser/options-checklist.md).
Browser scenarios use Playwright with an installed Chrome channel and never
download a browser.

## Limitations

- Every tab of a tabset stays mounted, background ones included, so a background
  panel keeps its live instance and registered API (its content is only
  `display: none`). Route to it with
  `window.TacPhone.interApp.resolveAsync()` to bring it to the front.
- Native window popouts (`window.open`) are not supported in the in-game
  browser; floating in-layout popups are the only popups.
- There is no permission model between apps, and no cross-app events yet.
- Notification actions and inter-app calls are page-local and never pass through
  the game.
