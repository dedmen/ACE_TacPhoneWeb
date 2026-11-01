# App contract and packaging

Read this when writing or changing any TacPhone app, or when adding a new app.
Host internals are in [`host.md`](host.md), the Map app's details are in
[`map.md`](map.md), and the Messenger's are in [`messaging.md`](messaging.md).
This file is the complete app-facing contract; the app READMEs
([`ACE_TacPhone_Map/README.md`](../ACE_TacPhone_Map/README.md),
[`MessagingApp/README.md`](../MessagingApp/README.md),
[`SampleApp/README.md`](../SampleApp/README.md)) are usage and setup guides.

## App module

An app entry module (normally `src/main.tsx`) exports:

```ts
export const apiVersion = TACPHONE_API_VERSION; // required, exact match
export function GetTacPhoneApps(): AppPanelInfo[] | Promise<AppPanelInfo[]>;
export function init(): void | Promise<void>;              // optional, before GetTacPhoneApps
export function OnMessageFromGame(message: object): void | Promise<void>; // optional
```

`GetTacPhoneApps()` takes no host argument. Apps read the host from the global
`window.TacPhone`; it is not passed as a prop or argument. `init()` may also
register app-level state, but keep it idempotent under StrictMode.

A panel is:

| Field | Required | Notes |
| --- | --- | --- |
| `id` | Yes | Globally unique across apps; used as the panel key and persisted in saved layouts. Do not use `AppChooser`. |
| `appComponent` | Yes | `React.ComponentType<AppProps>`; the host renders it with `appId`, `panelId`, `node`, `model`, `panel`. |
| `GetDefaultTitle()` | No | Default tab title; may change later with `panel.setTitle()`. |
| `GetTacPhoneIcon()` | No | String or `Promise<string>`. Prefer `data:`/`blob:`; external URLs do not load in-game. |

Module-load and `apiVersion` failures land in
`window.TacPhone.apps.failedApps`; render errors are caught by a per-app error
boundary. Neither stops the other apps from loading.

### Host global

`window.TacPhone` is the only app-facing global. Removed legacy globals
(`window.Networking`, `window.AppDirectory`, `window.PanelDirectory`,
`window.AppApi`, `window.InterestRegistry`, `window.Notifications`,
`window.TacPhoneUtils`) must not be used.

| Member | Use |
| --- | --- |
| `networking` | Requests, connection state, file/texture/terrain loading. |
| `apps` | Read-only app/panel catalog (`knownApps`, `knownPanels`, `failedApps`). |
| `panels` | List, find, focus, activate, open panels. |
| `interApp` | Register and resolve app services. |
| `interests` | Acquire/release demand-driven data interests. |
| `localization` | `t(key, ...args)`, `has`, `load`, `whenReady`, `language`, `onDidChange`. See [`localization.md`](localization.md). |
| `notifications` | Toast banners. |
| `options` | Register per-app options shown in the host Options panel, and read/write their values. |
| `components` | Reusable host UI. `components.SelectMenu` is the portaled listbox select; see [`host.md`](host.md#reusable-host-components-srccomponents). |
| `utils` | `CommandRegistry`, `PanelContext`, `usePanel()`, `compressAndToBase64`, `decompressFromBase64`. |

Panel components receive the live instance as `props.panel`; deeper components
can use `window.TacPhone.utils.usePanel()` or `PanelContext`.

## Localization

Every user-readable string goes through `window.TacPhone.localization.t()`:

```tsx
const label = window.TacPhone.localization.t('STR_ACE_Tacphone_map_panelTitle');
const message = window.TacPhone.localization.t('STR_ACE_Tacphone_Map_Polyline_Points', count);
```

- Keys are literal strings and live in the add-on stringtable; no `t()` at
  module scope, no fallback argument.
- Apps in this add-on use the `Host`, `Options`, `RemoteAccess`, `Map`,
  `Messenger` or `SampleApp` container of `addons/tacphone/stringtable.xml`.
- An app in another add-on sets `ace_tacphone_stringtable` in its config class
  and defines its own `STR_<MOD>_` keys.
- Keys reuse base-game text where it fits (`npx tacphone-build base-strings`).
  A base-game key is not in any add-on stringtable, so the app keeps the list in
  its single `src/i18n.ts` (`*_BASE_GAME_STRINGS`) and preloads it in `init()`:
  `await window.TacPhone.localization.load(APP_BASE_GAME_STRINGS)`, before any
  panel renders.
- UI helpers import `t` from that same `src/i18n.ts`, not from each component.

The full rules (containers, naming, plurals, excluded units and game-supplied
text, the bundled default table and the on-demand fallback) are in
[`localization.md`](localization.md).

## App options
Apps can expose a small option schema. The host renders it in the built-in
Options panel (`ACE_TacPhone_Options`), reached from the app chooser:

```ts
export function init(): void {
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
}
```

- Register from `init()`, not from a panel mount; registering twice replaces the
  previous schema for the same `app` and keeps stored values.
- Supported widget types: `boolean`, `number`, `select` and `text`. Number
  options accept `min`, `max`, `step` and `unit`; select options need `choices`
  with typed values.
- `get(app, key)` returns the effective value (stored override or default).
  `set()` validates/clamps one value; `apply()` writes several at once (presets).
  `reset()` restores defaults.
- Subscriptions: `onDidChange(change => { ... })`; read the new value again.
- Values are page-local and persist with the host layout. They are shared by
  every panel of the app on the page; there is no per-panel option storage.

## Requests and messages

App → game:

```ts
await window.TacPhone.networking.Request({ a: 'MyApp', c: 'DoThing', ...fields });
```

The request is routed to the app's `ace_tacphone_requestProcessor` as
`[request, clientId]` (`"local"` in-game, a WebSocket id remotely). The SQF
handler may return JSON-serializable data or a promise. The web code validates
data before sending it; do not duplicate type checks in SQF.

Game → app: the game sends `{ a: 'MyApp', c: 'SomeCommand', ... }`; the host
delivers it to the app's single `OnMessageFromGame`. Route commands with the
host helper instead of exporting one handler per panel:

```ts
const registry = new window.TacPhone.utils.CommandRegistry();
const unregister = registry.register('SomeCommand', payload => { /* ... */ });

export function OnMessageFromGame(message: object): void {
    registry.routeMessage(message as { c: string });
}
```

Panel `id`s are persisted in saved layouts; pick final names before shipping.

## Inter-app services

Register from the panel lifecycle and clean up on unmount:

```ts
return window.TacPhone.interApp.register(props.panel, {
    service: 'myapp',
    version: 1,
    api: { doSomething() { /* ... */ } },
});
```

Routing from another app:

```ts
const target = await window.TacPhone.interApp.resolveAsync({
    service: 'myapp',
    panelId: 'MyApp',
    openIfMissing: true,   // opens a floating popup by default
});
target?.api.doSomething();
```

- The registry is keyed by panel instance and service, not service alone.
- `resolve()` only sees mounted panels; `resolveAsync()` activates/opens a panel
  and waits for registration (`waitMs`, default 3000).
- Versioning is major-version matching; without `version`, the highest wins.
- Services are page-local, never reachable from the game, and have no permission
  model: the whole UI is one trust domain.
- Only the selected tab is mounted, so a background panel has no live API;
  that is why routing goes through `resolveAsync()`.

An app's service types live in `src/api.ts` and are bundled into
`dist/<name>.d.ts` by `tacphone-build bundle-api-types`. Never import host code
into that file, and never hand-edit the generated declaration.

## Data interests

Declare what the page needs so the game only does expensive work for interested
clients:

```ts
const release = window.TacPhone.interests.acquire('MyApp.markers');
release(); // idempotent; last release withdraws the game interest
```

The interest name must be non-empty and at most 128 characters. It is
page-scoped and reference-counted, survives WebSocket reconnects (announced
again), and is released on `pagehide`. Request the snapshot after acquiring;
request order is preserved, so the snapshot cannot miss an update. Game-side
commands and CBA events are in [`sqf.md`](sqf.md#interests).

## Packaging rules

A production app is loaded with `LoadGameFileText` and imported from a blob URL,
so it must be one self-contained ES module:

- `build.lib.formats: ['es']` and no code splitting; no relative imports, dynamic
  chunk imports, local `React.lazy` chunks, or `new URL(..., import.meta.url)`.
- Inline CSS and assets with `@ace-tacphone/build/singlefile`
  (`viteSingleFile`); no sidecar CSS file. The plugin also escapes every
  non-ASCII code unit to `\uXXXX`: the in-game loader's `A3API.RequestFile`
  mis-decodes UTF-8 (emoji arrive as mojibake), so an app bundle must stay pure
  ASCII. Keep literal emoji/accents in source; do not add a separate escape step.
- The plugin then stores the bundle as one ASCII line,
  `TACPHONE-BUNDLE:1:gzip:<base64>`, in both release and debug builds.
  `loadFile` and `A3API.RequestFile` pass file text through C strings, so raw
  gzip would be cut at its first NUL byte; base64 also keeps the payload ASCII.
  `AppDirectory` unpacks it before importing. There is no plain-bundle fallback
  and no sidecar artifact: an app file without the header fails with a rebuild
  message. Extra files loaded through `LoadGameFileText` are still plain text.
- Keep `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, and
  `react/compiler-runtime` external. The host import map provides them. A second
  React copy breaks hooks/context.
- `qrcode-generator` is also provided by the host import map, so apps can render
  QR codes without bundling another copy. The host installs every shared module
  in the internal `window.TacPhone.modules` map (`Map<string, unknown>` keyed by
  the bare specifier) from `src/Backend/SharedModules.ts`; that map is
  implementation detail, not public host API, so import `qrcode-generator`
  normally and never read the map.
- Extra JavaScript/CSS files may be shipped separately and loaded through
  `window.TacPhone.networking.LoadGameFileText`; they are still leaf modules with
  no relative imports. Cache them and expect an extra game-file read.
- `tacphone-build check-shared-imports` runs after every build and fails on a bare
  import the host does not provide.

The host build uses `vite-plugin-singlefile`; apps use the shared
`@ace-tacphone/build/singlefile` plugin. Do not swap them.

## Runtime dependencies

Beyond the fixed shared modules, an app may ship extra runtime modules (a large
library, one shim, a facade core). They are declared in the game config and
loaded before the app module.

Shared modules themselves are no longer window globals: the host publishes each
namespace on the internal `window.TacPhone.modules` map (`Map<string, unknown>`,
keyed by bare specifier) from `ACE_TacPhone_Main/src/Backend/SharedModules.ts`.
That map is implementation detail, not part of `TacPhoneHost`. Import the bare
specifier and let the host import map resolve it; never read the map.

Game config, as nested classes under the app class (`configClasses` definition
order is the execution order, so declare a transitive dependency before the
module that imports it):

```cpp
class EGVAR(tacphone,dependencies) {
    class some_library {
        name = "some-library";                  // bare specifier; defaults to the class name
        file = QPATHTOF(data\some-library.js);  // required
    };
};
```

The game sends `dependencies: [{ name, file }]` in the `GetAvailableApps`
metadata, so the host knows what to load for each app.

`package.json` declares the same specifiers for the build (`facade` marks a
prefix the facade build provides):

```json
"tacphone": {
  "app": "ACE_TacPhone_Map",
  "dependencies": {
    "some-library": {},
    "tacphone-ol-core": { "facade": "tacphone-ol/" }
  }
}
```

- A `facade` value is a prefix. The build check accepts the prefix itself
  (`tacphone-ol`) and anything under it (`tacphone-ol/Map`), whether it is
  written with or without a trailing slash.
- The app's Vite `external` list is
  `[...SHARED_MODULE_SPECIFIERS, ...Object.keys(pkg.tacphone.dependencies)]`, or
  the facade plugin supplies the external ids itself (the Map app does that with
  `tacphoneFacade`).
- Dev resolves the specifier from `node_modules`; production loads the game file
  named in the config. A dependency file may be plain ESM or a
  `TACPHONE-BUNDLE:1:gzip:<base64>` bundle.
- Import rules are the same as for the app bundle: single-file ESM only, no
  relative imports, no `http:`/`https:`/`ws:`/`wss:`/`file:` specifiers, no
  computed dynamic imports (`data:` and `blob:` URLs are allowed). Only shared
  specifiers and declared bare specifiers resolve.
- Identical file content is imported once (SHA-256 in game, normalized path
  outside the game). Per-app versions use import-map scopes; one dependency file
  shared by apps that need conflicting transitive versions is an explicit error.

Build steps (the facade line is only for an app that uses one):

```powershell
npm run build     # tsc -b + vite build (+ check-shared-imports, bundle-api-types)
tacphone-build facade build --app . --package ol --prefix tacphone-ol --out dist/ace_tacphone_ol.js
```

A facade is one library behind one dependency: `tacphoneFacade()` externalizes
`ol` and `ol/*` (except `.css`) as `tacphone-ol/...` and writes a manifest to
`node_modules/.tacphone-facade/<package>.json`; the CLI turns that manifest into
one compressed facade file exporting `__tacphoneFacade`, and the host expands it
into per-specifier adapters. One facade core per app; apps do not coordinate.
The output is a normal `TACPHONE-BUNDLE:` file copied into the app's game
`data/` folder and declared as a dependency as shown above.

## StrictMode and lifecycle

Development mounts every component twice. Register apps, services, interests,
and subscriptions in an effect that returns its cleanup; never register at module
scope and never assume an effect runs once. `interApp.register()` returns the
unregister function, so return it directly. Do not disable StrictMode to hide a
double mount.

## Creating a new app

Use `SampleApp` as the template. The full checklist, file map and the complete
rename table are in
[`SampleApp/README.md`](../SampleApp/README.md#creating-a-new-tacphone-app); use
it as the canonical guide. In short: pick a config-class name matching
`/^[A-Za-z_][A-Za-z0-9_]*$/`, copy both halves, rename every occurrence, keep the
web build and the SQF registration consistent, add the generated JS path to the
ACE3 root `.gitignore`, build, copy, and verify the app and its request handler
in game.

Nested apps register in their own `ace_tacphone_apps.hpp` (included by their own
`config.cpp`); nothing is added to the root `tacphone` config. Mission-only apps
can register the same class in `description.ext` instead of an addon folder.

Panel `id`s are persisted in saved layouts; pick final names before shipping.
