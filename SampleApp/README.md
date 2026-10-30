# ACE TacPhone Sample App

A minimal TacPhone app: a React panel with a counter and an **Increment** button
that sends one request to the game and raises one phone notification. It exists
to show the smallest end-to-end app — web panel, request/response, SQF handler,
build output — and it doubles as the starting point for a new app. Copy it and
rename it instead of writing the plumbing from scratch.

It does **not** use `OnMessageFromGame` (game-pushed messages). It does expose one
small inter-app service, [`SampleAppApi`](#the-sample-service-api), so the panel
also demonstrates how a service is registered and released. Both are optional.
See [`../ACE_TacPhone_Main/README.md`](../ACE_TacPhone_Main/README.md#app-contract)
for `OnMessageFromGame`, and [`../ACE_TacPhone_Map/README.md`](../ACE_TacPhone_Map/README.md)
for a full reference app with a larger service API.

## File map

| Item | Path |
| --- | --- |
| App registration (game) | `addons/tacphone/apps/SampleApp/ace_tacphone_apps.hpp` |
| Component defines | `addons/tacphone/apps/SampleApp/script_component.hpp` |
| Addon config | `addons/tacphone/apps/SampleApp/config.cpp` |
| Event handlers config | `addons/tacphone/apps/SampleApp/CfgEventHandlers.hpp` |
| Startup SQF | `addons/tacphone/apps/SampleApp/XEH_preStart.sqf`, `XEH_preInit.sqf`, `XEH_postInit.sqf` |
| Function list | `addons/tacphone/apps/SampleApp/XEH_PREP.hpp` |
| SQF request processor | `addons/tacphone/apps/SampleApp/functions/fnc_processBrowserRequest.sqf` |
| Build output (git-ignored) | `addons/tacphone/apps/SampleApp/data/ace_tacphone_sampleapp.js` |
| **File loaded in game** | `addons/tacphone/apps/SampleApp/data/ace_tacphone_sampleapp.js` |
| Package config | `websource/SampleApp/package.json` |
| Vite config | `websource/SampleApp/vite.config.ts` |
| Single-file build plugin | `@ace-tacphone/build/singlefile` (`websource/packages/tacphone-build/singlefile.ts`) |
| Dev HTML entry | `websource/SampleApp/index.html` |
| TypeScript configs | `websource/SampleApp/tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json` |
| Lint config | `websource/SampleApp/.oxlintrc.json` |
| Web `.gitignore` | `websource/SampleApp/.gitignore` |
| Web entry point | `websource/SampleApp/src/main.tsx` (exports `apiVersion` + `GetTacPhoneApps()`) |
| Panel component | `websource/SampleApp/src/SampleApp.tsx` (receives `AppProps`) |
| Inter-app service types | `websource/SampleApp/src/api.ts` (source of the generated `.d.ts`) |
| App-facing host contract | `websource/packages/tacphone-api/src/index.ts` (package `@ace-tacphone/api`) |
| Production bundle | `websource/SampleApp/dist/ace_tacphone_sampleapp.js` |
| Generated service declarations (git-ignored) | `websource/SampleApp/dist/ace_tacphone_sampleapp.d.ts` |

The app no longer carries a copy of the host API declarations. Panel and host
types come from `@ace-tacphone/api`, which the host and every app share.

The game folder is a sub-folder of the `ace_tacphone` PBO. Arma treats a
sub-folder `config.cpp` as its own addon, so the app does not need a top-level
`addons/<name>` folder or an include in the root `config.cpp`.

## Requirements

- Node.js 20.19+ or 22.12+.
- Arma 3 with TacPhone installed and enabled.
- A dev server reached through `http://localhost:<port>`. Never use
  `127.0.0.1`: the host's `IsLocalDev()` check matches the exact
  `http://localhost` prefix, and the dev transport is chosen from it.
- The local ASP.NET TLS certificate must be trusted, otherwise the page cannot
  open `wss://localhost:8001/ws`.
- Arma + TacPhone must be running while you develop: the `ArmaWebHost`
  extension serves the WebSocket. Without it the page reports a connection
  failure.

## Development

`websource` is an npm workspace: install once at its root, then run the app's dev
script.

```powershell
cd websource
npm install
npm run dev -w ace-tacphone-sampleapp
```

`npm run dev` in this folder forwards to `../ACE_TacPhone_Main`, so the app runs
inside the host page and gets `window.TacPhone` (networking, app catalog, panel
directory, inter-app registry, interests, notifications, utils), the host import
map, and the WebSocket connection. Running this app's own Vite server would not.

Then:

1. Open the URL Vite prints (normally `http://localhost:5173`).
2. Select **Sample App** in the TacPhone app chooser.

Discovery: the host treats this folder as a development app because
`package.json` declares

```json
"tacphone": { "app": "SampleApp" }
```

The value must equal the `ace_tacphone_apps` config class; it is the routing key.
The folder name itself does not matter. Alternatives, in the order the host
checks them:

| Source | How |
| --- | --- |
| `ACE_TacPhone_Main/dev-apps.local.json` (git-ignored) | `{ "apps": ["../SampleApp", "D:/dev/OtherApp"] }`, paths relative to `ACE_TacPhone_Main` |
| `TACPHONE_DEV_APPS` environment variable | Same path rules, `;`-separated on Windows |
| Sibling folder with the `tacphone.app` marker | The default for this repo |

A path listed in the config file or environment variable may omit the marker; the
folder name is then used as the app name. **Restart Vite after changing discovery
configuration.**

The host serves the app as `/devapps/SampleApp/` and imports the entry named by
`ace_tacphone_devFile` in `ace_tacphone_apps.hpp`, here `src\main.tsx`, i.e.
`/devapps/SampleApp/src/main.tsx`. Edits hot-reload through the host server.

Dev discovery only serves the web code. The game still has to know the app:
its `ace_tacphone_apps.hpp` must be in the loaded PBO, so build the game side
(`hemtt build` from the ACE3 repo root; add `--no-bin` for a faster local build)
and restart Arma after changing the app registration. Otherwise the app is
served by Vite but never appears in the TacPhone app chooser.

## Build

```powershell
npm run build
npm run build:debug   # unminified + inline source maps
```

Both run `tsc -b`, `vite build`, the shared-import check, and
`tacphone-build bundle-api-types`:

```text
tsc -b
vite build --mode <release|debug>
tacphone-build check-shared-imports
tacphone-build bundle-api-types --app . --entry src/api.ts --name SampleApp
```

The result is one self-contained ES module plus the generated service
declarations:

```text
dist/ace_tacphone_sampleapp.js     # the app bundle
dist/ace_tacphone_sampleapp.d.ts   # generated from src/api.ts, package "types"
```

`npm run build` is a release build: minified, no source map, and
`console.log` / `console.debug` / `console.info` calls are stripped.
`console.warn` and `console.error` are kept in both builds, so keep warnings
useful.

`bundle-api-types` emits declarations for `src/api.ts` only, fails when the
result is empty or still imports another module, and writes the file named by
the package `types` field. Never edit `dist/*.d.ts` by hand: change `src/api.ts`
and rebuild.

Copy the JS output to the path registered by `ace_tacphone_file`:

```powershell
Copy-Item dist\ace_tacphone_sampleapp.js ..\..\apps\SampleApp\data\ace_tacphone_sampleapp.js
```

The copy is required for in-game use: `addons/tacphone/addon.toml` excludes
`websource/**`, so nothing under `websource/` ends up in the PBO. Release and
build tooling must perform the same copy; the generated file is git-ignored.

## The sample request flow

1. Pressing **Increment** bumps the local counter and sends:

   ```ts
   {
       a: 'SampleApp',
       c: 'Increment',
       count,   // new counter value
       text,    // "Counter incremented to N"
   }
   ```

   The request goes through `window.TacPhone.networking`.

2. The host routes it to the app's processor,
   `ace_tacphone_SampleApp_fnc_processBrowserRequest`, called with
   `[request, clientId]`.
3. For `c == "Increment"` the handler runs `hint _text; systemChat _text;` and
   returns a hashmap equivalent to `{ ok: true, count: N }` to the browser:

   ```sqf
   private _result = createHashMap;
   _result set ["ok", true];
   _result set ["count", _count];
   _result
   ```

4. The panel shows a notification with body `Counter incremented to N`:

   ```ts
   const id = window.TacPhone.notifications.show({
       title: 'SampleApp',
       body: `Counter incremented to ${next}`,
       app: 'SampleApp',
   });
   ```

Pressing again calls `window.TacPhone.notifications.dismiss(id)` for the previous banner
before showing the new one, so only the newest notification remains after the
short exit animation; banners do not accumulate. The id is kept in a React ref,
not state, because it is never rendered and should not cause a re-render.

The sample does not export `OnMessageFromGame`: it needs no game-pushed
messages. To add one, export it from `src/main.tsx`, hand the message to
`window.TacPhone.utils.CommandRegistry`, and send with the `a` field set to this
app. Each app has exactly one such export.

## The sample service API

`src/api.ts` is the app's inter-app contract. It must stay tiny,
self-contained, and import-free so the generated `.d.ts` needs nothing else:

```ts
export interface SampleAppApi {
    /** Current value of the panel counter. */
    getCount(): number;
}

export const SAMPLEAPP_SERVICE = 'sampleapp';
export const SAMPLEAPP_SERVICE_VERSION = 1;
```

The panel registers the implementation for as long as it is mounted, using the
`PanelInstance` it receives through `AppProps.panel`, and unregisters on unmount
(the cleanup makes StrictMode's double mount harmless):

```tsx
React.useEffect(() => {
    const api: SampleAppApi = { getCount: () => countRef.current };

    return window.TacPhone.interApp.register(props.panel, {
        service: SAMPLEAPP_SERVICE,
        version: SAMPLEAPP_SERVICE_VERSION,
        api,
    });
}, [props.panel]);
```

Other apps route to it — a missing app is opened as a floating popup by default:

```ts
const provider = await window.TacPhone.interApp.resolveAsync({
    service: SAMPLEAPP_SERVICE,
    panelId: 'SampleApp',
    openIfMissing: true,
});
const api = provider?.api as SampleAppApi | undefined;
console.log(api?.getCount());
```

Service APIs are page-local, never reachable from the game, and have no
permission model: the whole UI is one trust domain. A panel that is not mounted
(background tab, closed popup) has no live registration, which is what
`resolveAsync()` is for.

## Creating a new TacPhone app

1. Pick a valid C++/config class name: letters, digits, and underscores, starting
   with a letter or underscore (`/^[A-Za-z_][A-Za-z0-9_]*$/`). Dev discovery
   rejects anything else. This name is the routing key (`a` in requests), the
   `ace_tacphone_apps` class, and the `tacphone.app` value.
2. Copy `websource/SampleApp` to a new sibling folder and delete `dist`,
   `node_modules`, and any stale `package-lock.json`.
3. Copy `addons/tacphone/apps/SampleApp` to a new game folder under
   `addons/tacphone/apps/`, named exactly like the app (case included).
4. Rename every occurrence using the table in
   [Where the app name is set](#where-the-app-name-is-set). That includes the
   service name/version constants in `src/api.ts` and the `--name` argument of
   `bundle-api-types`.
5. Keep these three consistent: `QFUNC(<name>)` in `ace_tacphone_apps.hpp`,
   `PREP(<name>)` in `XEH_PREP.hpp`, and `functions/fnc_<name>.sqf`. The function
   is `ace_tacphone_<AppName>_fnc_<name>`.
6. Keep the app contract intact:
   - `src/main.tsx` exports `apiVersion = TACPHONE_API_VERSION` and
     `GetTacPhoneApps()`;
   - the panel component takes `AppProps`, reads `props.panel`, and uses the
     global `window.TacPhone` for host services;
   - `src/api.ts` exports the service type and its constants (or, if the app
     needs no service, at least one exported type so the declaration bundle is
     not empty);
   - `package.json` keeps `"types": "./dist/<app>.d.ts"`, `"main": "./dist/<app>.js"`,
     and the `bundle-api-types` step in `build` / `build:debug`.
7. Add the generated JS path to the repo-root `.gitignore`
   (`addons/tacphone/apps/<folder>/data/ace_tacphone_<app>.js`).
8. `npm install` at `websource` root, `npm run build -w ace-tacphone-<app>`, then
   copy the JS output as shown in [Build](#build). Check that the generated
   `dist/<app>.d.ts` is non-empty and mentions your exported service type.
9. Start the host (`npm run dev`) and verify the app appears in the chooser and
   the request handler runs in-game.
10. If the web folder is not a sibling of `ACE_TacPhone_Main`, add it to
    `dev-apps.local.json` or `TACPHONE_DEV_APPS`, then restart Vite.
11. For a third-party or mission-only app, register `class <AppName>` under
    `ace_tacphone_apps` in the mission `description.ext` instead of creating an
    addon folder. Note that `ace_tacphone_file` is not needed for the `main` app
    (it is built into the host), but it **is** required for every normal app.

## Where the app name is set

Panel `id`s are persisted in saved layouts. Changing a panel `id` after release
breaks the saved layouts that reference it; pick the final names before shipping.

| Location | What to change | Literal or derived |
| --- | --- | --- |
| `addons/tacphone/apps/SampleApp/script_component.hpp` | `#define APPNAME SampleApp` and `#define COMPONENT_BEAUTIFIED Tacphone App SampleApp` | Literal. `APPNAME` drives `COMPONENT`, `ADDON`, `GVAR`, `FUNC`, `PATHTO`; `COMPONENT_BEAUTIFIED` is the `CfgPatches` display name. |
| `addons/tacphone/apps/SampleApp/config.cpp` | Nothing: `class ADDON` / `COMPONENT_NAME` come from `APPNAME` | Derived. The folder path also determines the addon/PBO path; keep the folder case equal to `APPNAME` so `PATHTO`/`QPATHTOF` paths match exactly. |
| `addons/tacphone/apps/SampleApp/CfgEventHandlers.hpp` | Nothing: `class ADDON` | Derived. |
| `addons/tacphone/apps/SampleApp/ace_tacphone_apps.hpp` | `class SampleApp` (must equal the routing key and `tacphone.app`); `QPATHTOF(data\ace_tacphone_sampleapp.js)`, `"src\main.tsx"`, `QFUNC(processBrowserRequest)` | Literal class and paths, function name via `QFUNC`. |
| `addons/tacphone/apps/SampleApp/XEH_PREP.hpp` and `functions/fnc_processBrowserRequest.sqf` | `PREP(processBrowserRequest)` and the file name must match `QFUNC(processBrowserRequest)` | Literal, must agree with each other. |
| `websource/SampleApp/package.json` | Package `name`, `"tacphone": { "app": "SampleApp" }`, `"main": "./dist/ace_tacphone_sampleapp.js"`, `"types": "./dist/ace_tacphone_sampleapp.d.ts"`, and `--name SampleApp` in the build scripts | Literal. |
| `websource/SampleApp/vite.config.ts` | `lib.name` and `fileName()` output `ace_tacphone_sampleapp.js` | Literal; must match `ace_tacphone_file`. |
| `websource/SampleApp/src/main.tsx` | Panel `id: 'SampleApp'`, `GetDefaultTitle()` title, `GetTacPhoneIcon()` | Literal panel id (persisted in layouts) and display title. |
| `websource/SampleApp/src/api.ts` | `SAMPLEAPP_SERVICE` / `SAMPLEAPP_SERVICE_VERSION` and the `getCount()` contract | Literal; pick a lowercase service name that no other app uses. |
| `websource/SampleApp/src/SampleApp.tsx` | Notification `app: 'SampleApp'` / `title: 'SampleApp'`, request `a: 'SampleApp'` | Literal; the request `a` and notification `app` must equal the routing key. |
| `D:\dev\ACE3\.gitignore` (repo root) | Generated `addons/tacphone/apps/SampleApp/data/ace_tacphone_sampleapp.js` | Literal path. |
| `addons/tacphone/apps/SampleApp/data/` | Copy destination for the build output | Literal folder. |

The root `addons/tacphone/ace_tacphone_apps.hpp` is for apps that live directly
in the main `tacphone` addon. Nested apps like this one register in their own
`ace_tacphone_apps.hpp`, included by their own `config.cpp`; nothing needs to be
added to the root config. The shared `addons/tacphone/apps/script_component.hpp`
is not edited either: the app's local header defines `APPNAME` and then includes
it.

Optional locations:

| Location | Purpose |
| --- | --- |
| `addons/tacphone/apps/SampleApp/stringtable.xml` | Localized `$STR_...` strings; only needed if you localize titles/messages. |
| `script_component.hpp` + the matching web constant | A data-interest name (`<AppName>.<feature>`), e.g. `INTEREST_...` in SQF and a constant in the app, used with `window.TacPhone.interests.acquire()`. |
| `description.ext` | Registration for mission/third-party apps instead of an addon folder. |
| `dev-apps.local.json` / `TACPHONE_DEV_APPS` | Web folders that are not siblings of `ACE_TacPhone_Main`. |

## Pitfalls / notes

- One `OnMessageFromGame` per app. Route commands through
  `window.TacPhone.utils.CommandRegistry` instead of trying to export per-panel
  handlers.
- The host runs in `<StrictMode>` during development, so effects mount, unmount,
  and mount again. Register services, interests, and subscriptions in a
  `React.useEffect` that *returns* its cleanup; never register at module scope
  and never assume an effect runs once. `interApp.register()` returns the
  unregister function — return it directly.
- The built production app must be one self-contained ESM file. Source relative
  imports are bundled, but the output must not contain relative imports, dynamic
  chunk imports, `React.lazy` for local chunks, CSS side files, or
  `new URL(..., import.meta.url)` assets. Inline CSS and assets (the shared
  `@ace-tacphone/build/singlefile` plugin does this).
- React stays external through the host import map (`react`, `react-dom`,
  `react-dom/client`, `react/jsx-runtime`, `react/compiler-runtime`). Never bundle
  a second React copy. Apps cannot add mappings; extend
  `websource/packages/tacphone-build/shared-modules.js` instead.
- In the in-game browser there is no `fetch` / `XMLHttpRequest`, no
  `localStorage`, and no `IndexedDB`. Use `window.TacPhone.networking` for
  everything.
- `window.TacPhone` is the only host global.
- Panel components receive `AppProps` (`appId`, `panelId`, `node`, `model`,
  `panel`); they are no longer called with no props. The host is the global
  `window.TacPhone`. `window.TacPhone.utils.usePanel()` returns the same
  `PanelInstance` for code that is a component below the panel.
