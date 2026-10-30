# App contract and packaging

Read this when writing or changing any TacPhone app, or when adding a new app.
Host internals are in [`host.md`](host.md); the Map app's own details are in
[`map.md`](map.md). The full user-facing reference is
[`ACE_TacPhone_Main/README.md`](../ACE_TacPhone_Main/README.md#app-contract) and
[`SampleApp/README.md`](../SampleApp/README.md).

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
| `notifications` | Toast banners. |
| `utils` | `CommandRegistry`, `PanelContext`, `usePanel()`. |

Panel components receive the live instance as `props.panel`; deeper components
can use `window.TacPhone.utils.usePanel()` or `PanelContext`.

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
- Keep `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, and
  `react/compiler-runtime` external. The host import map provides them. A second
  React copy breaks hooks/context.
- Extra JavaScript/CSS files may be shipped separately and loaded through
  `window.TacPhone.networking.LoadGameFileText`; they are still leaf modules with
  no relative imports. Cache them and expect an extra game-file read.
- `tacphone-build check-shared-imports` runs after every build and fails on a bare
  import the host does not provide.

The host build uses `vite-plugin-singlefile`; apps use the shared
`@ace-tacphone/build/singlefile` plugin. Do not swap them.

## StrictMode and lifecycle

Development mounts every component twice. Register apps, services, interests,
and subscriptions in an effect that returns its cleanup; never register at module
scope and never assume an effect runs once. `interApp.register()` returns the
unregister function, so return it directly. Do not disable StrictMode to hide a
double mount.

## Creating a new app

Use `SampleApp` as the template. The full checklist is
[`SampleApp/README.md`](../SampleApp/README.md#creating-a-new-tacphone-app).
The short version:

1. Pick a config-class name matching `/^[A-Za-z_][A-Za-z0-9_]*$/`; it is the
   routing key (`a`), the `ace_tacphone_apps` class, and `tacphone.app`.
2. Copy `websource/SampleApp` and `addons/tacphone/apps/SampleApp`; rename every
   occurrence using the SampleApp table.
3. Keep `src/main.tsx`, `src/api.ts`, `package.json` (`main`, `types`, build
   scripts), `vite.config.ts`, and the SQF registration consistent.
4. Add the generated JS path to the ACE3 root `.gitignore`.
5. Build, copy the JS into `apps/<folder>/data/`, verify the app appears in the
   chooser, and verify the SQF request handler runs in-game.
6. If the folder is not a sibling of `ACE_TacPhone_Main`, add it to
   `dev-apps.local.json` or `TACPHONE_DEV_APPS` and restart Vite.

Panel `id`s are persisted in saved layouts; pick final names before shipping.
