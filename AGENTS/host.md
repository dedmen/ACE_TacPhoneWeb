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
| App runtime dependencies, shim import map, facade adapters | `src/Backend/ModuleRegistry.ts` |
| Host shared modules (`window.TacPhone.modules`) | `src/Backend/SharedModules.ts` |
| SHA-256 for the file manifest (JS fallback for non-secure contexts) | `src/Backend/Sha256.ts` |
| Transport selection and request/response | `src/Backend/Networking.ts` |
| In-game `window.A3API` shim | `src/Backend/A3API.ts` |
| Game → app message routing | `src/Backend/AppMessaging.ts`, `src/Backend/MessageRouter.ts` |
| Inter-app registry and routing | `src/Backend/InterApp.ts`, `src/Panels/TargetChooserDialog.tsx` |
| Data interests | `src/Backend/InterestRegistry.ts` |
| Global game info (multiplayer, player id, mission/terrain, version, debug) | `src/Backend/GameInfo.ts` |
| Notifications | `src/Backend/Notifications.ts`, `src/Panels/NotificationHost.tsx` |
| Audio (synthesised sounds, output device) | `src/Backend/Audio.ts` |
| App options registry and Options panel | `src/Backend/AppOptions.ts`, `src/MainApps/OptionsPanel.tsx` |
| Built-in `main` app | `src/MainApps/main.tsx` |
| Error UI | `src/Panels/AppErrorBoundary.tsx` |
| Styles | `src/App.css`, `src/index.css`, `src/Panels/*.module.css`, `src/MainApps/*.module.css` |

## Boot

1. `src/Backend/SharedModules.ts` holds the `SHARED_MODULES` namespaces in an
   internal `window.TacPhone.modules` map (`Map<string, unknown>`, keyed by the
   bare specifier such as `"react"` or `"qrcode-generator"`); `Backend/Host.ts`
   installs it as `window.TacPhone.modules`. There are no per-module window
   globals: the host import map's `data:` entries read the values back with
   `window.TacPhone.modules.get(...)`.
2. Importing `src/Backend/Host.ts` builds `window.TacPhone` from the service
   singletons (lazy and idempotent; also installed on a microtask).
3. `App.tsx` creates the flexlayout model, loads option overrides saved in the
   same layout envelope, attaches the model to `panelDirectory`, loads the
   one-time `window.TacPhone.gameInfo` snapshot in parallel with the layout,
   then loads apps through `window.TacPhone.apps.LoadAvailableApps()`, and
   renders the app chooser panels. Game info and stored options are available
   before any app `init()` runs.
4. The app loader asks the game `{a:"main", c:"GetAvailableApps"}`, which returns
   `{ file, devfile, icon, dependencies }` per app. Every app's metadata is
   parsed first so all dependency declarations are known, then
   `Backend/ModuleRegistry.ts` reads and imports the dependency files and
   registers the shim import map (see below). Each app module is loaded from the
   packaged file, or from `/devapps/<Name>/<devfile>` in development, imported
   through `importShim`, checked against `TACPHONE_API_VERSION`, and asked for
   `GetTacPhoneApps()`.
5. `GetGameInfo` is called once through `main` and caches multiplayer, player id,
   mission name, `worldName`, game version and the debug flag. Debug is true only
   for an `__A3_DEBUG__` build with the server/mission `allowDebug` CBA setting
   enabled.

## App modules and dependencies (`Backend/ModuleRegistry.ts`)

`index.html` sets `window.esmsInitOptions = { shimMode: true }` in a plain
`<script>` before the module entry. A native import map must exist before the
first module is fetched and cannot be extended afterwards, but app dependencies
are only known at runtime. The host page itself stays a native module on the
native import map; only app and dependency modules go through `importShim`.

When WebAssembly is unavailable (the in-game sandbox), the shim's module lexer
falls back to an asm.js build, and V8 prints `Invalid asm.js: Unexpected token`
once when it fails to validate it. The fallback then runs as plain JavaScript;
the warning is benign and does not affect module loading.

- `AppDirectory` parses every app's metadata (including the ordered
  `dependencies: [{ name, file }]`) before importing anything, then
  `moduleRegistry.registerDependencies()` starts one `LoadGameFileText` per
  declared dependency file in parallel, decodes and imports them in declaration
  order, and only then loads the apps (in parallel).
- Identical file content is imported once: in-game the dedupe key is the
  SHA-256 of the raw game file text, computed while the modules load and awaited
  before the loader returns so the manifest is complete. The in-game page is a
  `blob:` URL, which is not a secure context, so `crypto.subtle` is unavailable
  and `src/Backend/Sha256.ts` provides the hash; `crypto.subtle` is still
  preferred where a secure context exists. Outside the game hashing is skipped
  and the normalized game path is the key.
- A dependency file is either plain ESM or `TACPHONE-BUNDLE:1:gzip:<base64>`;
  anything else fails that dependency.
- The shim is seeded with the host shared-module import map, then gets one import
  map with per-app scopes keyed by the app/dependency blob URL, so two apps can
  ship different versions of the same specifier.
- A facade core's `__tacphoneFacade` export is expanded into one tiny adapter
  module per specifier (used by the Map app's OpenLayers core).
- A failed dependency fails only the apps that declared it. A shared dependency
  that would need conflicting transitive versions reports a clear error.
- `AppDirectory.getFileManifest()` returns the SHA-256 of every app and
  dependency file read; the Remote Access panel sends it with
  `RemoteAccess.Start`, and the relay caches the files it names (see
  [`remote.md`](remote.md#file-cache)).
- Development (`IsLocalDev()`) resolves dependencies from `node_modules` through
  the Vite dev server and never reads or hashes game files.

Declaration and authoring rules are in
[`apps.md`](apps.md#runtime-dependencies).

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
- Layout persistence: `localStorage` when available (external browser), storing
  the plain JSON under `tacphone.layout`. In-game `App.tsx` gzips and
  base64-encodes the model and calls the game's `main` app with `SaveLayout`;
  `GetLayout` returns the string stored in `profileNamespace`. Both paths
  coalesce layout changes into at most one save per 5 seconds; option changes
  use a 300 ms window. The saved JSON is one envelope:
  `{ ...model.toJson(), options: { <app>: { <key>: value } } }`. Old layouts
  without `options` still load.
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
  Requests are queued until open and time out after 30 seconds (60 seconds for
  `LoadGameTerrain`, which streams multiple layer chunks).

In-game requests leave through `window.A3API.SendAlert`; the hidden background
browser receives them as a `JSDialog` in
[`fnc_loadPhoneBackground.sqf`](../../functions/fnc_loadPhoneBackground.sqf) and
replies through `A3API._response`. Pushed messages reach the target app's
`OnMessageFromGame` (in-game via an `ExecJS` call, over the WebSocket as
`{k:"command", d:...}`). The WebSocket path uses `{k, d}` JSON for replies and
injects the sender as `s` on the extension side.

`LoadGameFileText`, `LoadGameFileTexture`, and `LoadGameTerrain` use the game
filesystem through the transport. The built-in `main` app
(`src/MainApps/main.tsx`) handles game requests for terrain/texture. For terrain
it only calls `networking.ReplyTerrainSVG(uid, config)`; the private helpers in
`Backend/Networking.ts` split the SVG into standalone per-layer documents,
compress each layer and stream `ReplyRequestTerrainSVG` chunks back (with
`part`/`parts` fragments when a layer is still too large). Textures reply with
`ReplyRequestTexture` as before. `LoadGameTerrain` resolves to a `TerrainData`
(`width`, `height`, `layers: [{ name, svg }]`); a legacy whole-SVG reply is still
accepted by decompressing and splitting it locally. `ReplyTerrainSVG` is not
implemented by the browser transport. A game add-on built with `__A3_DEBUG__`
and the server/mission `allowDebug` CBA setting makes `gameInfo.isDebug()` true;
`ReplyTerrainSVG` then logs each layer's raw SVG size, gzip size, base64 size,
chunk count and compression ratio. The bundled in-game page is normally a release
web build, so the diagnostic uses `console.warn` (release builds strip
`console.log`). Release game builds or `allowDebug = false` skip it. The app
contract version is `2`.

App bundles loaded through `LoadGameFileText` are not plain JavaScript:
`Backend/AppDirectory.ts` unpacks the `TACPHONE-BUNDLE:<version>:<codec>:<base64>`
line (gzip, base64) before creating the blob URL, and fails with a rebuild
message for anything without a supported header. See
[`apps.md`](apps.md#packaging-rules).

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

`show()` plays `options.sound` once per notification through
`Backend/Audio.ts`; the sound is optional and notification behaviour is otherwise
unchanged. The audio engine throttles bursts, so several notifications shown in
the same instant can share one sound.

## Audio (`Backend/Audio.ts`)

`window.TacPhone.audio` is the app-facing surface (`AudioApi`):

- `play(sound)` plays one built-in preset (`message`, `alert`, `success`).
- `enumerateDevices()` filters `navigator.mediaDevices.enumerateDevices()` down to
  `audiooutput` and returns `[]` when unsupported.
- `setSinkId(deviceId)` uses `AudioContext.setSinkId()` and rejects with a clear
  error when the browser lacks it; the selected id is remembered.
- `getOutputDeviceId()` returns that id, or undefined for the browser default.

Sounds are synthesised with oscillators and gain envelopes: there are no audio
assets and no `new Audio()` elements. The single `AudioContext` is created
lazily, and `pointerdown`/`keydown` listeners installed at module load create and
resume it, so the autoplay policy is satisfied by the first user gesture.
`play()` never queues on a suspended context (a queued sound would only fire on a
later click); it tries to resume and drops that sound. Without Web Audio the
engine logs one warning and becomes a no-op.

Notification sounds and `setSinkId()` share the same context, so a sink change
applies to every sound. Mirroring Arma's audio output device is future
scaffolding: the game cannot report its device today (see `TODO.md`).

## App options (`Backend/AppOptions.ts`, `MainApps/OptionsPanel.tsx`)

`window.TacPhone.options` is the per-app option registry (`AppOptionsApi`).
Apps register their schema once from `init()`:

```ts
window.TacPhone.options.register({
    app: 'MyApp',
    title: 'My App',
    options: [
        { key: 'fast', label: 'Fast mode', type: 'boolean', default: false },
        {
            key: 'detail', label: 'Detail', type: 'select', default: 'medium',
            choices: [{ label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }],
        },
    ],
    presets: [
        { id: 'weak', label: 'Weak device', values: { fast: true, detail: 'low' } },
    ],
});
```

- `register()` replaces an existing schema for the same app, so an app reload
  is idempotent; stored values are kept.
- Values are overrides only. `get()` falls back to the definition default;
  `reset()` deletes overrides. `apply()` validates and writes several values in
  one change notification and powers preset buttons.
- `OptionsPanel` (`ACE_TacPhone_Options`, shipped by the built-in `main` app)
  is the only UI. It is opened from the app chooser; there is no toolbar button.
- Values are saved with the layout (see the persistence bullet above). Unknown
  app values are preserved across reloads, so uninstalling an app does not lose
  its settings.
- Changes are live: subscribe with `options.onDidChange()` and re-read; panels
  that are not mounted pick up the current values when they mount.

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
