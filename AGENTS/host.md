# Host UI (`ACE_TacPhone_Main`)

Read this when changing the host page, panel system, layout, app loader,
transport, inter-app registry, interests, or notifications. App-facing rules are
in [`apps.md`](apps.md); game-side plumbing is in [`sqf.md`](sqf.md). The
user-facing overview and development setup are in
[`ACE_TacPhone_Main/README.md`](../ACE_TacPhone_Main/README.md).

## File map

| Area | Files |
| --- | --- |
| Entry, shared globals, StrictMode | `src/main.tsx` |
| Host object / API surface | `src/Backend/Host.ts`, `src/TacPhoneMain.ts`, `src/Backend/Types.ts` |
| Host-internal helpers (`withTimeout`, game path normalization) | `src/Backend/Internal.ts` |
| Host UI text helper and base-game key list | `src/Backend/i18n.ts` |
| Layout shell, app factory, chooser, error boundary | `src/App.tsx` |
| Panel/tab binding and context | `src/Panels/PanelHost.tsx`, `src/Panels/PanelContext.ts` |
| Panel directory (list/focus/open/floats) | `src/Backend/PanelDirectory.ts` |
| App chooser | `src/Panels/AppChooserPanel.tsx` |
| App discovery, loading, icons, failed apps | `src/Backend/AppDirectory.ts` |
| App runtime dependencies, shim import map, facade adapters | `src/Backend/ModuleRegistry.ts` |
| Host shared modules (`window.TacPhone.modules`) | `src/Backend/SharedModules.ts` |
| SHA-256 for the file manifest (JS fallback for non-secure contexts) | `src/Backend/Sha256.ts` |
| Transport selection and request/response | `src/Backend/Networking.ts` |
| In-game relay hub: control frames, peers, requests, terrain/texture, LAN | `src/Backend/RelayManager.ts` |
| Terrain request cache, SVG split/encode, progressive reply assembly | `src/Backend/TerrainCache.ts` |
| In-game `window.A3API` shim | `src/Backend/A3API.ts` |
| Game → app message routing | `src/Backend/AppMessaging.ts`, `src/Backend/MessageRouter.ts` |
| Inter-app registry and routing | `src/Backend/InterApp.ts`, `src/Panels/TargetChooserDialog.tsx` |
| Data interests | `src/Backend/InterestRegistry.ts` |
| Global game info (multiplayer, player id, mission/terrain, version, debug) | `src/Backend/GameInfo.ts` |
| Notifications | `src/Backend/Notifications.ts`, `src/Panels/NotificationHost.tsx` |
| Audio (synthesised sounds, output device) | `src/Backend/Audio.ts` |
| App options registry and Options panel | `src/Backend/AppOptions.ts`, `src/MainApps/OptionsPanel.tsx` |
| Reusable host components | `src/Components/SelectMenu.tsx` (+ `.module.css`) |
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
   same layout envelope, attaches the model to `panelDirectory`, waits for
   `window.TacPhone.localization.whenReady()` (game stringtable), then loads the
   one-time `window.TacPhone.gameInfo` snapshot in parallel with the layout
   before loading apps through `window.TacPhone.apps.LoadAvailableApps()` and
   rendering the app chooser panels. Game info and stored options are available
   before any app `init()` runs.
   `src/main.tsx` decodes the bundled default stringtable before the first
   render, so the remote pairing screen has text without a game connection; see
   [`localization.md`](localization.md).
4. The app loader asks the game `{a:"main", c:"GetAvailableApps"}`, which returns
   `{ file, devfile, icon, dependencies, stringtable }` per app. Every app's
   metadata is parsed first so all dependency declarations are known, then
   `Backend/ModuleRegistry.ts` reads and imports the dependency files and
   registers the shim import map (see below). Each app module is loaded from the
   packaged file, or from `/devapps/<Name>/<devfile>` in development, imported
   through `importShim`, checked against `TACPHONE_API_VERSION`, and asked for
   `GetTacPhoneApps()`.
5. `GetGameInfo` is called once through `main` and caches multiplayer, player id,
   mission name, `worldName`, game version and the debug flag. Debug is true only
   for an `__A3_DEBUG__` build with the server/mission `allowDebug` CBA setting
   enabled.

## Localization (`Backend/Localization.ts`, `Backend/Stringtable.ts`)

`window.TacPhone.localization` is the host translation store; the rules and
excluded text are in [`localization.md`](localization.md).

- `Backend/Stringtable.ts` parses the XML with `DOMParser`, maps game/browser
  language names to stringtable tags, and upper-cases keys for lookup.
- `Backend/Localization.ts` holds the active table, the bundled table
  (`virtual:tacphone-stringtable`, gzip+base64, decoded with
  `decompressFromBase64`), the per-path cache and the on-demand queue.
  `LOAD_STRINGTABLE_FILE = false` disables the runtime XML loader because HEMTT
  ships only `stringtable.bin`; the bundled table is the live source and
  `Localization.Info` only selects its language block.
- `main.tsx` awaits `loadDefaults()` before the first render. `App.tsx` awaits
  `whenReady()` after the transport is ready and re-renders on `onDidChange()`.
- `AppDirectory.loadApps()` calls `loadStringtables()` for the distinct
  `stringtable` paths reported by app metadata before any app `init()`; while the
  XML loader is disabled this is a no-op.
- Base-game keys are not in the add-on stringtable: the host preloads
  `HOST_BASE_GAME_STRINGS` with one `localization.load()` after `whenReady()`,
  and each app does the same with its own list in `init()`.
- A failed file load logs one `console.warn` (kept in release builds) and
  switches missing keys to `main / Localization.Get`, at most 100 per request.

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
  creates one `PanelInstance` per open tab and disposes it when the tab is
  closed.
- `PanelDirectory` (`window.TacPhone.panels`) is the source of truth for
  `list/get/find/focused/largest/activate/open/onDidChange`. `open()` defaults to
  a floating in-layout popup (`placement: 'tab'` docks a tab); native window
  popouts need `window.open` and are unsupported in-game.
- Every tab of a tabset stays mounted; `App.tsx` sets the model attribute
  `tabEnableRenderOnDemand: false` on every model it builds (so an old saved
  layout cannot turn it back on) and flexlayout only hides inactive tab content
  with `display: none`. A background tab therefore keeps its `instanceId`,
  registered app API, canvas and state; switching back is instant instead of
  rebuilding an app such as the Map. `interApp.resolveAsync()` still activates
  the panel, which brings it to the front, and remains the routing path for a
  panel that is not open at all or lives in a collapsed border.
- Unassigned tabs render `AppChooserPanel`: a phone-style icon grid of every
  registered panel. Clients with a precise pointer (`(hover: hover) and
  (pointer: fine)`, i.e. desktop browsers) also get a sticky search field that
  filters by panel title, app name and panel id; touch clients get the grid
  alone. Tiles use the resolved icon and only fall back to a generated monogram
  when the app has no icon or the image fails to decode, so icon and text never
  overlap; apps that failed to load are listed in a separate section. The grid
  refreshes through `appDirectory.onDidChange` because icons resolve after the
  first paint.
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

StrictMode is a root rule ([`AGENTS.md`](../AGENTS.md), never disable it):
`createLayoutModel`, app loading, layout restore, and panel instance creation
are idempotent across the double mount.

## Transport (`Backend/Networking.ts`)

The transport is chosen once at module load:

- `IsArma()` is true when the page URL starts with `blob:` (the sandboxed in-game
  browser) → `NetworkingA3`.
- Otherwise → `NetworkingWebsocket`, which connects to `wss://localhost:8001/ws`
  (served by the debug-only LAN extension). Requests are queued until open and
  time out after 30 seconds. `LoadGameTerrain`
  allows 120 seconds for the first frame and then a 60 second idle timeout that
  every terrain chunk restarts, so a slow but progressing layer transfer is not
  cut off by a fixed total timeout.

In-game requests leave through `window.A3API.SendAlert`; the hidden background
browser receives them as a `JSDialog` in
[`fnc_loadPhoneBackground.sqf`](../../functions/fnc_loadPhoneBackground.sqf) and
replies through `A3API._response`. Pushed messages reach the target app's
`OnMessageFromGame` (in-game via an `ExecJS` call, over the WebSocket as
`{k:"command", d:...}`).

### Relay hub (`Backend/RelayManager.ts`)

`NetworkingA3` constructs one `RelayManager` and owns the only app-facing
transport. The hub is the single place that knows about remote clients:

- **Transport input.** SQF calls
  `window.TacPhone.networking.OnTransportMessage(raw)` with an already encoded
  string: `RELAY:` + base64 (control JSON or `<peerId>\n<payload>`),
  `WEBHOST:` + base64 (`{s,k,d}` LAN request), or `WEBHOST_DISCONNECT:<id>`.
  `OnRelayEvent('established' | 'lost')` reports the native socket lifecycle.
- **Relay session.** Opens/closes through SQF `RemoteAccess.Start`/`Stop`,
  sends `auth` after `established`, stores a new secret through
  `GetAuthIdentity`/`SetAuthIdentity`, and sends the file manifest with
  `{t:"files", files}`. It handles `auth-ok`, `peer-joined`, `peer-left`,
  `code`, `code-used`, `share`, `share-revoked`, `error`, `ping`, `pong` and
  `send-result`. Reconnect uses 1–30 s backoff and clears peers; `Stop` cancels
  the timer.
- **Request rewrite.** A remote request is forwarded with a fresh A3API key and
  recorded in `pendingRemoteRequests` (`transport`, `clientId`, `originalKey`).
  SQF receives a normal request without `__client`/`__requestKey`/`__silent`;
  the hub correlates the reply by the local key and answers the originating
  relay/LAN client with the original key. Timeouts and disconnects drop the
  entry.
- **Terrain and texture.** `RequestTerrainSVG` is produced in the hub via
  `LoadGameTerrain` + `encodeTerrainChunks` and streamed as
  `ReplyRequestTerrainSVG` frames; `RequestTexture` uses `LoadGameFileTexture`.
  Client `Reply*` frames are ignored.
- **Interests.** The hub aggregates per-client interests and only ever sends SQF
  `"local"`. It uses `Interest.Set` with `active:false` (not `Interest.Clear`,
  which would clear every interest of that client). Peer/client removal clears
  the client from all sets.
- **Fan-out.** Every `OnMessageFromGame` is displayed locally and broadcast to
  all relay clients (`{t:"send", targets:["*"], data}`) and LAN clients
  (`WebHost.Send`, debug only). No target filtering.
- **Panel commands.** `RemoteAccess.Start`/`Stop`/`CopyToClipboard` go to SQF;
  `Status`/`NewCode`/`ShareCreate`/`ShareRevoke`/`Kick` are answered by the hub;
  `GetAuthIdentity`/`SetAuthIdentity`/`Forward` are hub-internal SQF calls.
  `Debug.RemoteAccess` is handled here in JS, gated by `gameInfo.debug`.

`LoadGameFileText`, `LoadGameFileTexture`, and `LoadGameTerrain` use the game
filesystem through the transport. The in-game Map's own terrain uses
`LoadGameTerrain` (A3API). The built-in `main` app still contains the legacy
`RequestTerrainSVG`/`RequestTexture` producer handlers, but the native relay hub
does not use them. `RelayManager` calls
`LoadGameTerrain`/`LoadGameFileTexture` itself and sends the chunk/texture frames
straight to the relay/LAN client. `LoadGameTerrain` resolves to a `TerrainData`
(`width`, `height`, `layers: [{ name, svg }]`); a legacy whole-SVG reply is still
accepted by decompressing and splitting it locally. Identical terrain requests
are coalesced in both transports: while one is in flight the next caller shares
it. The WebSocket transport never reuses a completed result, because the relay's
game host can change without this socket reconnecting. The in-game transport
keeps its completed result for the lifetime of its page instead (the page is
recreated when the game terrain changes, so the config always describes the same
terrain); this skips the `A3API` request and the ~700 ms `splitTerrainSVG()` on
every Map reopen. That cache holds at most one config's `TerrainData`. This
absorbs React StrictMode's double mount without sending two `RequestTerrainSVG`
frames.
`ReplyTerrainSVG` is not implemented by the browser transport. A game add-on
built with `__A3_DEBUG__` and the server/mission `allowDebug` CBA setting makes
`gameInfo.isDebug()` true; `ReplyTerrainSVG` then logs each layer's raw SVG size,
gzip size, base64 size, chunk count and compression ratio. The bundled in-game
page is normally a release web build, so the diagnostic uses `console.warn`
(release builds strip `console.log`). Release game builds or `allowDebug = false`
skip it. The app contract version is `2`.

### Progressive terrain layers

`Backend/TerrainCache.ts` owns the request cache, the SVG split, the send-side
chunk encoder and the receive-side multi-frame assembler; `Networking.ts` only
wires them to the two transports. `LoadGameTerrain(config, onLayer?)` accepts a
layer callback. Every layer is handed over as soon as it can be rendered,
instead of waiting for the whole reply:

- the WebSocket transport decides a layer is complete when all of its parts have
  arrived, decompresses it immediately (`DecompressionStream`, so the main thread
  stays free) and calls `onLayer` with
  `{ layer, index, count, width, height }`; the request resolves later with the
  same layers already decoded, so nothing is decompressed twice.
- the in-game transport receives one SVG document, splits it and then calls
  `onLayer` for every layer before resolving; there is nothing to stream there.
- a coalesced caller that attaches mid-transfer receives every layer that is
  still in flight, and the resolved result always contains all of them.

The WebSocket request allows 120 seconds for the first terrain frame and then a
60 second idle timeout that every chunk restarts, so a slow map that still makes
progress is not killed by a fixed total deadline.

`splitTerrainSVG()` serializes the shared shell (root attributes plus `<defs>`)
once and appends one serialized `<g>` per layer. It used to clone and re-serialize
the whole `<defs>` for every layer, which dominated the split cost on large maps.

The Map app is the only consumer: `Map.startTerrainLoad()` builds the view and
`TerrainLayerPipeline` from the first callback (which carries the terrain size)
and pushes each following layer into the pipeline. See
[`map.md`](map.md#terrain-tile-loading).

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

`resolve`/`resolveAsync` target fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `service` | required | Service name to find. |
| `policy` | `auto` | `auto`, `focused`, `largest`, `first` or `ask`. |
| `version` | highest | Requested major version; a mismatch is skipped. |
| `panelId` | any | Restrict candidates to one app panel id. |
| `instanceId` | none | Explicit target (instance or tab id); wins over the policy. |
| `openIfMissing` | `false` | Open the app when nothing provides it; needs `panelId`. |
| `placement` | `float` | Placement used with `openIfMissing`. |
| `activate` | `true` | Activate the target before waiting for registration. |
| `waitMs` | `3000` | Mount/registration budget, capped at 30000. |

`resolve()` is synchronous, never waits and falls back from `ask` to `auto`.
`resolveAsync()` activates/opens and waits; `call()` throws when the service,
method or method call fails. A `PanelInfo` is a snapshot; re-resolve instead of
caching an API across panel closes.

Panel routing (`window.TacPhone.panels`):

- `open(panelId, { placement, select, tabsetId, rect, config })` returns
  `{ tabId, layoutId, tabSetId }`; `placement` is `float` (default) or `tab`.
  Floats are persisted in the layout under `subLayouts`.
- `list()`, `get(instanceId)`, `find(panelId)`, `focused()`, `largest(panelId?)`,
  `activate(instanceId)` and `onDidChange(listener)` are the query/lifecycle
  surface. `largest()` ranks only the main layout; native window popouts are
  unsupported.

## Interests (`Backend/InterestRegistry.ts`)

`acquire(name)` is page-scoped and reference-counted. The first reference sends
`{a:"main", c:"Interest.Set", interest, active:true}`; the last sends
`active:false`. On transport reconnect the registry clears its announced set and
re-announces every held interest. A `pagehide` handler sends one best-effort
`Interest.Clear` for the in-game browser. Remote interests are intercepted by
`RelayManager` before they reach SQF, so SQF only sees the aggregated `"local"`
state. Invalid names are rejected with a warning; nothing throws.

## Notifications (`Backend/Notifications.ts`)

`show(options)` returns an id; `dismiss(id)` animates the banner out. Default
duration is 15 s, `0` means permanent, and at most 5 banners are kept (oldest
dropped silently). `action` is a page-local function, not a game message. Apps can
open/focus panels or call other services from it.

Options: `title` (required), `body`, `app` (resolves a default icon), `icon`
(overrides it), `duration`, `data` (payload for `action`), `sound`
(`message`/`alert`/`success`) and `action`. The action may be async. There is no
persistent notification history or center screen.

`show()` plays `options.sound` once per notification through
`Backend/Audio.ts`; the sound is optional and notification behaviour is otherwise
unchanged. The audio engine throttles bursts, so several notifications shown in
the same instant can share one sound.

`Host.Log` warnings (including "target not connected" delivery diagnostics) are
logged and shown as banners only while `GameInfo.debug` is true; this is checked
in the web UI, so a release bundle against a debug game still shows them. Errors
remain visible.

## Audio (`Backend/Audio.ts`)

`window.TacPhone.audio` is the app-facing surface (`AudioApi`):

- `play(sound)` plays one built-in preset (`message`, `alert`, `success`).
- `enumerateDevices()` filters `navigator.mediaDevices.enumerateDevices()` down to
  `audiooutput` and returns `[]` when unsupported.
- `setSinkId(deviceId)` uses `AudioContext.setSinkId()` and rejects with a clear
  error when the browser lacks it; the selected id is remembered.
- `getOutputDeviceId()` returns that id, or undefined for the browser default.
- `speak(text, options)` uses the Web Speech API `SpeechSynthesisUtterance`.
  It is silent before the first gesture and when unavailable; `interrupt`
  defaults to true (cancels the current utterance), with optional `rate`,
  `pitch`, `volume` and `lang`.
- `stopSpeaking()` cancels the current utterance; `isSpeechAvailable()` reports
  whether `speechSynthesis` exists.

Sounds are synthesised with oscillators and gain envelopes: there are no audio
assets and no `new Audio()` elements. The single `AudioContext` is created
lazily on the first user gesture (`pointerdown`/`keydown`/`touchstart`/
`mousedown`, installed at module load with capture + passive), and the gesture
listeners stay installed for the page lifetime. `visibilitychange` and `focus`
also resume a context that backgrounding suspended, so a returning page keeps
autonomous sounds working.

`play()` drops the sound before the first gesture: the browser autoplay policy
would only release it on some later random click. After the first gesture, a
suspended context keeps **at most one pending preset**: `play()` stores it,
resumes, and schedules it when `resume()` settles within ~500 ms; otherwise the
pending sound is dropped. A running context plays immediately. The per-preset
cooldown (400 ms) is the burst guard. Without Web Audio the engine logs one
warning and becomes a no-op. The Web Speech API follows the same gesture gate;
speech is dropped before the first user interaction, and `stopSpeaking()` is a
no-op when the API is missing.

`Backend/AudioTestHooks.ts` installs `window.__TACPHONE_AUDIO_TEST__` only in
the Vite dev server or a game debug build (same pattern as the Map's
`__TACPHONE_MAP_TEST__`); `Host.ts` calls it after the host object is built.
The same bootstrap installs `window.__TACPHONE_DEBUG_EVAL__`, an indirect
`eval()` that throws unless `gameInfo.isDebug()` is true. It exists only for
live page inspection; app code must never call it. It
exposes `getState()` (`state`, `currentTime`, `hasUserGesture`, `pending`,
`scheduled`, `completed`, `lastPeak`), `play(sound)`, `suspend()`, `resume()`
and `renderOffline(sound)`. Enabling it also turns on a debug analyser tap
(`gain -> analyser -> destination`) and a `samplePeak()` poll that uses
`getByteTimeDomainData`, which proves the graph produced non-silent samples;
`renderOffline()` renders the same `PRESETS` through an `OfflineAudioContext`
for a deterministic check on a headless (silent) sink. The
`test/scenarios/audio.test.mjs` Playwright scenario uses them.

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

## Reusable host components (`src/Components/`)

`window.TacPhone.components` exposes host UI components so apps do not import
host code or reimplement them:

- `SelectMenu` — a listbox-style select. The opened menu is portaled to
  `document.body` and positioned with `position: fixed` from the trigger rect
  (z-index 4000, above the Map's marker dialog at 2000), so opening it never
  changes the layout of the panel or dialog that owns the trigger and never adds
  a scrollbar there. It supports a per-option icon/swatch, disabled options,
  `renderOption`/`renderValue`, an optional filter field, stable `testId` hooks
  (`<testId>`, `<testId>-menu`, `select-menu-search`,
  `select-menu-option-<value>`), and `data-dropdown-menu` on the menu (the Map's
  lazy marker-icon `IntersectionObserver` uses it as root). Theme it through the
  class-name props and the `--select-*` / `--select-menu-*` CSS variables; do not
  reach into its CSS module. Escape/arrows/Enter are handled in the capture
  phase so an enclosing dialog does not also react to them.

The Options panel uses `SelectMenu` for its `select` widgets. The Map's marker
dialog uses it for marker type (searchable) and channel.

## Changing the public API

1. Add or change the types in `packages/tacphone-api/src/index.ts` (and
   `src/globals.ts` for `window` members).
2. Implement/extend the owning service module and expose it from
   `src/Backend/Host.ts`; only add it to `TacPhoneHost` if apps should see it.
3. Re-export host-internal types through `src/Backend/Types.ts` and
   `src/TacPhoneMain.ts`.
4. Update [`apps.md`](apps.md) / the Main README and any affected app.
5. `npm run check`, then `npm run build:all` to rebuild the PBO and install it
   (or `npm run build:debug` for a web-only iteration, which does not update the
   PBO).

## Build

```powershell
npm run build:all      # build + install into the game (web + PBO + native DLL)
npm run build:debug    # web-only iteration; copies data/index.html, no PBO
npm run build          # release, only when explicitly requested
```

The root scripts also copy the output into `..\data\index.html`. Release builds
remove `console.log/debug/info`; `warn`/`error` stay. Do not edit `dist/index.html`
or the copied `data/index.html` by hand.
