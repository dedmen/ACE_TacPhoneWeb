# Host UI (`ACE_TacPhone_Main`)

Read this when changing the host page, panel system, layout, app loader,
transport, inter-app registry, interests, or notifications. App-facing rules are
in [`apps.md`](apps.md); game-side plumbing is in [`sqf.md`](sqf.md). The full
reference is [`ACE_TacPhone_Main/README.md`](../ACE_TacPhone_Main/README.md).

## File map

| Area | Files |
| --- | --- |
| Entry, shared globals, StrictMode | `src/main.tsx` |
| Host object / API surface | `src/Backend/Host.ts`, `src/TacPhoneMain.ts`, `src/Backend/Types.ts` |
| Layout shell, app factory, chooser, error boundary | `src/App.tsx` |
| Panel/tab binding and context | `src/Panels/PanelHost.tsx`, `src/Panels/PanelContext.ts` |
| Panel directory (list/focus/open/floats) | `src/Backend/PanelDirectory.ts` |
| App chooser | `src/Panels/AppChooserPanel.tsx` |
| App discovery, loading, icons, failed apps | `src/Backend/AppDirectory.ts` |
| Transport selection and request/response | `src/Backend/Networking.ts` |
| In-game `window.A3API` shim | `src/Backend/A3API.ts` |
| Game → app message routing | `src/Backend/AppMessaging.ts`, `src/Backend/MessageRouter.ts` |
| Inter-app registry and routing | `src/Backend/InterApp.ts`, `src/Panels/TargetChooserDialog.tsx` |
| Data interests | `src/Backend/InterestRegistry.ts` |
| Notifications | `src/Backend/Notifications.ts`, `src/Panels/NotificationHost.tsx` |
| Built-in `main` app | `src/MainApps/main.tsx` |
| Error UI | `src/Panels/AppErrorBoundary.tsx` |
| Styles | `src/App.css`, `src/index.css`, `src/Panels/*.module.css` |

## Boot

1. `src/main.tsx` imports React and assigns `window.React`, `window.ReactDOM`,
   `window.ReactDOMClient`, `window.ReactJSXRuntime`, and
   `window.ReactCompilerRuntime` from `SHARED_MODULES` in
   `@ace-tacphone/build/shared-modules`.
2. Importing `src/Backend/Host.ts` builds `window.TacPhone` from the service
   singletons (lazy and idempotent; also installed on a microtask).
3. `App.tsx` creates the flexlayout model, attaches it to `panelDirectory`,
   loads apps through `window.TacPhone.apps.LoadAvailableApps()`, and renders the
   app chooser panels.
4. The app loader asks the game `{a:"main", c:"GetAvailableApps"}`, which returns
   `{ file, devfile, icon }` per app. Each module is loaded from the packaged
   file, or from `/devapps/<Name>/<devfile>` in development, checked against
   `TACPHONE_API_VERSION`, and asked for `GetTacPhoneApps()`.

## Layout and panels

- The page is exactly one viewport and never scrolls: `index.css` pins
  `html`/`body`/`#root` to `height: 100%` with `overflow: hidden` and
  `overscroll-behavior: none`, and `App.tsx` anchors the flexlayout shell with
  `position: fixed; inset: 0`. Do not reintroduce `100vh` (taller than the
  visible area on mobile Chrome) or margins/borders on `#root`: a scrollable
  document makes touch drags pan the page and fire `pointercancel`, which breaks
  canvas apps such as the Map's freehand drawing. Scrolling belongs inside a
  panel.
- flexlayout drives the tabs/tabsets. `src/App.tsx` is the shell; `PanelHost.tsx`
  creates one `PanelInstance` per mounted tab and disposes it on close/switch.
- `PanelDirectory` (`window.TacPhone.panels`) is the source of truth for
  `list/get/find/focused/largest/activate/open/onDidChange`. `open()` defaults to
  a floating in-layout popup (`placement: 'tab'` docks a tab); native window
  popouts need `window.open` and are unsupported in-game.
- Only the selected tab of a tabset is mounted. A background tab has no
  `instanceId` and no registered app API; `interApp.resolveAsync()` activates it
  and waits for registration.
- Unassigned tabs render `AppChooserPanel`: a phone-style icon grid of every
  registered panel. Clients with a precise pointer (`(hover: hover) and
  (pointer: fine)`, i.e. desktop browsers) also get a sticky search field that
  filters by panel title, app name and panel id; touch clients get the grid
  alone. Tiles use the resolved icon and fall back to a generated monogram, and
  apps that failed to load are listed in a separate section. The grid refreshes
  through `appDirectory.onDidChange` because icons resolve after the first paint.
- The persisted app choice is the tab config `panelId`. `AppChooserPanel` reads
  it back on mount, and `PanelInstance.setApp()` writes it for the next reload.
  Panel `id`s are persisted in layouts; renaming one breaks saved layouts.
- Layout persistence: `localStorage` when available (external browser).
  Otherwise `App.tsx` calls the game's `main` app with `GetLayout` /
  `SaveLayout`; the SQF side is still a placeholder (see `TODO.md`).
- `largest()` ranks only the main layout, not floating popups, because areas of
  different layouts are not comparable.

StrictMode is deliberate. `createLayoutModel`, app loading, layout restore, and
panel instance creation are idempotent across the double mount. Do not disable it
to hide a duplicate.

## Transport (`Backend/Networking.ts`)

The transport is chosen once at module load:

- `IsArma()` is true when the page URL starts with `blob:` (the sandboxed in-game
  browser) → `NetworkingA3`.
- Otherwise → `NetworkingWebsocket`, which connects to `wss://localhost:8001/ws`.
  Requests are queued until open and time out after 30 seconds.

In-game requests leave through `window.A3API.SendAlert`; the hidden background
browser receives them as a `JSDialog` in
[`fnc_loadPhoneBackground.sqf`](../../functions/fnc_loadPhoneBackground.sqf) and
replies through `A3API._response`. Pushed messages reach the target app's
`OnMessageFromGame` (in-game via an `ExecJS` call, over the WebSocket as
`{k:"command", d:...}`). The WebSocket path uses `{k, d}` JSON for replies and
injects the sender as `s` on the extension side.

`LoadGameFileText`, `LoadGameFileTexture`, and `LoadGameTerrain` use the game
filesystem through the transport. The built-in `main` app
(`src/MainApps/main.tsx`) handles game requests for terrain/texture, compresses
them, and replies with `ReplyRequestTerrainSVG` / `ReplyRequestTexture`.

The engine moves `ExecJS` sources through base64 and decodes them with `atob`,
so non-ASCII text in in-game replies and pushes arrives as a UTF-8 byte string
(`"Кa32"` → `"Ð\u009aa32"`). The helpers in
[`Backend/GameText.ts`](../ACE_TacPhone_Main/src/Backend/GameText.ts) repair that
at the transport boundary: `Request` parses after `decodeGameText`,
`OnMessageFromGame` walks the parsed message with `decodeGameTextDeep`, and
`LoadGameFileText` / `LoadGameTerrain` decode their text. Only contiguous
high-byte runs are decoded, and pure-ASCII strings return without copying, so
base64 payloads stay cheap. Terrain SVGs can be ~30 MB and cost one scan, plus
one copy if they contain names. Texture content from `LoadGameFileTexture` is
binary and must never be decoded. The WebSocket transport already receives
proper UTF-8 and does not decode anything.

## Inter-app registry (`Backend/InterApp.ts`)

- `register(panel, { service, version, api })` is keyed by panel instance and
  service. The returned disposer is idempotent and no-ops after the panel closes.
- `resolve()` is a synchronous snapshot of mounted panels; `resolveAsync()` is
  the routing path: it opens/activates a panel, waits for the registration
  (`waitMs`, default 3000, capped at 30000), and applies `policy`
  (`auto`/`focused`/`largest`/`first`/`ask`). `openIfMissing` requires
  `panelId`; the default placement is `float`.
- `TargetChooserDialog` installs the `policy: 'ask'` handler once from `App.tsx`.
- Everything is page-local and unauthenticated; the game cannot reach these APIs.

## Interests (`Backend/InterestRegistry.ts`)

`acquire(name)` is page-scoped and reference-counted. The first reference sends
`{a:"main", c:"Interest.Set", interest, active:true}`; the last sends
`active:false`. On transport reconnect the registry clears its announced set and
re-announces every held interest. A `pagehide` handler sends one best-effort
`Interest.Clear` for the in-game browser. Invalid names are rejected with a
warning; nothing throws.

## Notifications (`Backend/Notifications.ts`)

`show(options)` returns an id; `dismiss(id)` animates the banner out. Default
duration is 15 s, `0` means permanent, and at most 5 banners are kept (oldest
dropped silently). `action` is a page-local function, not a game message. Apps can
open/focus panels or call other services from it.

## Changing the public API

1. Add or change the types in `packages/tacphone-api/src/index.ts` (and
   `src/globals.ts` for `window` members).
2. Implement/extend the owning service module and expose it from
   `src/Backend/Host.ts`; only add it to `TacPhoneHost` if apps should see it.
3. Re-export host-internal types through `src/Backend/Types.ts` and
   `src/TacPhoneMain.ts`.
4. Update [`apps.md`](apps.md) / the Main README and any affected app.
5. `npm run check`, then build the host and copy `dist/index.html`.

## Build

```powershell
npm run build
Copy-Item dist\index.html ..\..\data\index.html
```

Release builds remove `console.log/debug/info`; `warn`/`error` stay. Do not edit
`dist/index.html` or the copied `data/index.html` by hand.
