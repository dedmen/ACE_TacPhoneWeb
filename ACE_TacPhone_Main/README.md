# ACE TacPhone Web UI

`ACE_TacPhone_Main` is the host UI for ACE TacPhone. It provides the panel
manager, the networking layer, and the build that is embedded in the in-game
`CT_WEBBROWSER` control.

In development the same code runs as a normal web page and talks to a running
Arma client through the `ArmaWebHost` extension over a WebSocket.

## Requirements

| Component | Minimum | Notes |
| --- | --- | --- |
| Node.js | 20.19+ or 22.12+ | Required by Vite 8 / the installed toolchain. |
| Arma 3 | 2.24+ (2.23 dev branch) | TacPhone uses `CT_CONTROL_REF`, `ctrlWebBrowserAction ["SetControlReference", ...]`, and `SetBrowserInternalSize`, which were added in the 2.23 dev branch and ship in 2.24. Arma 3 2.22 stable does not expose them. |
| Browser | Chromium 126+ | The in-game browser is Chromium 126. An external browser needs the same minimum feature set: ES modules, import maps, blob-URL module imports, and `CompressionStream` / `DecompressionStream`. |

The in-game browser runs local content in a sandbox. It has no `fetch` /
`XMLHttpRequest`, `localStorage`, or `IndexedDB`. Code that runs in both modes
must not depend on those APIs. Bundle assets inline; use `window.Networking` to
load files from the game.

## Quick start

Run these commands in `ACE_TacPhone_Main`:

```powershell
npm install
npm run dev
```

The development script is `dev`; Vite prints the URL to open (normally
`http://localhost:5173`). Use the `localhost` URL, not `127.0.0.1`: the dev
transport is selected by the `http://localhost` prefix. Keep the TacPhone open
in Arma: in development the page connects to `wss://localhost:8001/ws`, which
is started by the `ArmaWebHost` extension. Without a running game and TacPhone
the page will report a connection failure.

A development app is discovered from its own folder by app name. See
[Developing apps](#developing-apps).

### Debugging

Use an external Chrome/Chromium window with the browser devtools. The checked-in
`.vscode/launch.json` is a starting point; set its `url` to the URL printed by
Vite and keep:

```json
"webRoot": "${workspaceFolder}/websource/ACE_TacPhone_Main"
```

The VS Code integrated browser does not resolve `webRoot` correctly and will
not bind source-map breakpoints.

### Building the in-game UI

```powershell
npm run build
Copy-Item dist\index.html ..\..\data\index.html
```

The build produces a single self-contained `dist/index.html` (inline script and
import map); that is the file loaded by `CT_WEBBROWSER`. `dist/` and the copied
`data/index.html` are ignored by git.

`npm run build` is a release build: the JavaScript is minified, no source map is
embedded, and `console.log` / `console.debug` / `console.info` calls are removed.
Use `npm run build:debug` for an unminified build with an inline source map;
`console.warn` and `console.error` calls are kept in both builds.

## Developing apps

An app is a JavaScript ES module that is loaded dynamically by the host. A mod
can provide one or more apps. During development the host dev server can load an
app from any folder on disk; the app does not have to be below the host web root.

The recommended layout keeps each app repository next to the host:

```text
ACE_TacPhoneWeb/
  ACE_TacPhone_Main/
  ACE_TacPhone_Map/
  ACE_TacPhone_AnotherApp/
```

The host discovers development apps from these places:

1. `dev-apps.local.json` in `ACE_TacPhone_Main` (git-ignored), for apps anywhere:

   ```json
   { "apps": ["../ACE_TacPhone_Map", "D:/dev/ACE_TacPhone_AnotherApp"] }
   ```

   Relative paths are resolved from `ACE_TacPhone_Main`.
2. The `TACPHONE_DEV_APPS` environment variable, using the platform path
   separator (`;` on Windows). Useful for CI or a one-off location.
3. Direct children of the legacy `ACE_TacPhone_Main/devapps/` folder.
4. Sibling folders of `ACE_TacPhone_Main` whose `package.json` declares the app:

   ```json
   {
     "tacphone": { "app": "ACE_TacPhone_MyApp" }
   }
   ```

The declared app name must match the game-side `ace_tacphone_apps` config class
exactly. It is also the routing key used by requests. A folder in `devapps` or a
folder listed in the config/environment may omit the marker; its folder name is
then used as the app name. Sibling folders require the marker so unrelated
folders are never exposed by accident.

The dev server exposes every discovered app under a stable URL:

```text
/devapps/<AppName>/
```

The loader imports the entry named by `ace_tacphone_devFile` in the app config,
defaulting to `src/main.tsx`:

```text
/devapps/<AppName>/src/main.tsx
```

Install the app's own dependencies in its directory (`npm install` inside the
app folder), then start the host with `npm run dev`. Vite serves the app through
the host dev server, so edits to the app hot-reload. Running the app's own Vite
dev server is not enough: it does not provide the TacPhone globals, networking,
or host import map. Restart the host after changing `dev-apps.local.json` or the
environment variable.

Apps keep their own `node_modules`; the host deduplicates every package in
[`shared-modules.js`](shared-modules.js) to its own copies. The host's
`server.fs.allow` list is generated from the discovered app folders, so an app
outside the host root can still be served.
Requests to an undiscovered app return a 404 with a short explanation.

## App contract

### Game-side registration

Register the app in the addon config (or in `description.ext`):

```cpp
class ace_tacphone_apps {
    class ACE_TacPhone_MyApp {
        scope = 2;
        icon = "\A3\ui_f\data\map\markers\nato\c_ship.paa"; // optional/reserved
        ace_tacphone_file = QPATHTOF(data\ace_tacphone_myapp.js);
        ace_tacphone_devFile = "src\main.tsx";
        ace_tacphone_requestProcessor = QFUNC(processBrowserRequest);
    };
};
```

| Field | Required | Meaning |
| --- | --- | --- |
| `scope` | Yes | Must be greater than `0`; use `2`. |
| `ace_tacphone_file` | Yes, except `main` | Path to the production ES module entry in the game filesystem. It is read with `LoadGameFileText` and imported from a blob URL. |
| `ace_tacphone_devFile` | Recommended | Entry point relative to the app folder, for example `src\main.tsx`. The development loader imports this path from `/devapps/<AppName>/`; if omitted it falls back to `src/main.tsx`. |
| `ace_tacphone_requestProcessor` | For app requests | Name of the SQF function that handles requests sent with `a: "<AppName>"`. It receives the request hashmap and may return any JSON-serializable value or a promise. |
| `icon` | No | Currently reserved; panel icons come from `GetTacPhoneIcon()`. |

`<AppName>` is also the routing key. It is the `a` field in requests and is the
folder name used by the development loader.

### Module exports

The entry module must export:

```ts
import React from 'react';
import type { AppPanelInfo } from './TacPhoneMain';

export function GetTacPhoneApps(): AppPanelInfo[] {
    return [{
        id: 'ACE_TacPhone_MyApp',
        appComponent: MyPanel,
        GetDefaultTitle: () => 'My App',
        GetTacPhoneIcon: () => 'data:image/svg+xml,...',
    }];
}

export function OnMessageFromGame(message: object): void | Promise<void> {
    // Optional. Messages from the game are delivered here.
}
```

`AppPanelInfo` is part of the host API declarations. The host build generates
`dist/TacPhoneMain.d.ts` from [`src/TacPhoneMain.ts`](src/TacPhoneMain.ts) and
syncs it to the `src` directory of every discovered development app. For an app
that is not discovered yet, copy the generated file into the app's `src`
directory, or run `npm run sync:api-types -- <path-to-app-src>`. Do not edit the
copied file by hand; change the host API source instead.

| Panel field | Contract |
| --- | --- |
| `id` | Globally unique across all apps. It is used as the panel key and in saved layouts; do not use `AppChooser`. |
| `appComponent` | A React class or function component. The host creates it with `React.createElement(component, null)`, so it receives no props. |
| `GetDefaultTitle()` | Returns the tab title. Must return a string. |
| `GetTacPhoneIcon()` | Returns an image URL. Data URLs and blob URLs work best because the in-game browser cannot load external files. |

The host wraps app components in an error boundary. A broken app is recorded in
`window.AppDirectory.failedApps` and does not prevent the other apps from
loading.

### Requests and messages

App code talks to the game through `window.Networking.Request`:

```ts
const result = await window.Networking.Request({
    a: 'ACE_TacPhone_MyApp', // registered app name
    c: 'GetSomething',       // command understood by the SQF request processor
    // ...additional JSON-serializable fields
});
```

The request is routed to the app's `ace_tacphone_requestProcessor`. Returning a
promise from SQF is supported; the host waits for it and forwards the resolved
value.

Messages pushed from the game to a browser arrive at `OnMessageFromGame`. The
`a` field identifies the target app. Use the host's command registry to route a
single app handler to individual panels:

```ts
const registry = new window.TacPhoneUtils.CommandRegistry();

const unregister = registry.register('SomeCommand', payload => {
    // handle payload
});

export function OnMessageFromGame(message: object): void {
    registry.routeMessage(message as { c: string });
}
```

`register()` returns a cleanup function. Each app has only one
`OnMessageFromGame` export, so route messages instead of trying to export one
handler per panel.

### Globals available to apps

The host exposes these before loading apps:

| Global | Purpose |
| --- | --- |
| `window.Networking` | `WhenReady()`, `Request()`, `LoadGameFileText()`, `LoadGameFileTexture()`, `LoadGameTerrain()`. |
| `window.AppDirectory` | Read-only view of `knownApps`, `knownPanels`, and `failedApps`. Do not modify it. |
| `window.TacPhoneUtils.CommandRegistry` | Message router helper shown above. |

Tooling types for these are generated into `dist/TacPhoneMain.d.ts` and synced
into the development apps by the host build.

The public API source is [`src/TacPhoneMain.ts`](src/TacPhoneMain.ts). Add
app-facing classes, types, and `window` globals there; the build bundles them
with the host declarations and updates the app copies. Never edit a synced
`TacPhoneMain.d.ts` directly. Import these declarations with `import type`;
at runtime the host API is accessed through `window`. The bundle also types the
shared module globals (`window.React`, `window.ReactDOM`, and so on).

## Import-map constraints

The host exposes React once and generates an import map in `index.html`. In
development `vite.config.ts` injects it into the served page; in the production
build the same map is embedded in `data/index.html`. It maps exactly these bare
module specifiers:

```json
{
  "imports": {
    "react": "data:text/javascript,export default window.React; ...",
    "react-dom": "data:text/javascript,export default window.ReactDOM; ...",
    "react-dom/client": "data:text/javascript,export default window.ReactDOMClient; ...",
    "react/jsx-runtime": "data:text/javascript,export default window.ReactJSXRuntime; ...",
    "react/compiler-runtime": "data:text/javascript,export default window.ReactCompilerRuntime; ..."
  }
}
```

The generated modules re-export the values that `src/main.tsx` assigns to
`window.React`, `window.ReactDOM`, `window.ReactDOMClient`,
`window.ReactJSXRuntime`, and `window.ReactCompilerRuntime`. The specifier and
global names live in one list, [`shared-modules.js`](shared-modules.js), which
drives the host import map, `src/main.tsx`, and the app build externals.

Rules for app builds:

- Keep `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, and
  `react/compiler-runtime` external. Do not bundle a second copy of React;
  duplicate React copies break hooks and context.
- Only the exact specifiers above are mapped. Other subpaths such as
  `react/jsx-dev-runtime` and `react-dom/server` are not. Bundle them in the
  app, or avoid them.
- A production app bundle is imported from a blob URL but resolves bare imports
  through the host document's import map. Do not rewrite these specifiers to
  file paths.
- If another shared dependency is needed, it must either be bundled or added to
  [`shared-modules.js`](shared-modules.js) and assigned in `src/main.tsx`; apps
  cannot add mappings themselves.
- React Compiler users: keep `react/compiler-runtime` external as well; the host
  maps it to the compiler runtime that belongs to the same React instance.

In development Vite resolves the bare imports for you. The import map matters
most for a prebuilt app bundle loaded with `import()` from a blob URL.

`npm run check:importmap` verifies the built host import map and every discovered
development app's `dist/*.js` bundle against `shared-modules.js`. The host and
app build scripts run the same check automatically.

## Production packaging: one ESM entry file per app

The production loader in `src/Backend/AppDirectory.ts` reads
`ace_tacphone_file` with `LoadGameFileText`, creates a `Blob`, and imports it:

```ts
const content = await window.Networking.LoadGameFileText(appInfo.file);
const url = URL.createObjectURL(
    new Blob([content], { type: 'application/javascript' })
);
return import(/* @vite-ignore */ url);
```

The entry file must be one self-contained ES module. A normal bundle-relative
`import('./chunk.js')`, `React.lazy(() => import(...))`, CSS code splitting, or
an asset URL that points at another emitted file will fail because the blob URL
has no sibling files to resolve against.

Recommended library build settings:

```ts
build: {
    lib: {
        entry: 'src/main.tsx',
        formats: ['es'],
        fileName: () => 'myapp.js',
    },
    rollupOptions: {
        external: [
            'react',
            'react-dom',
            'react-dom/client',
            'react/jsx-runtime',
            'react/compiler-runtime',
        ],
        output: {
            // Vite 8 / Rolldown: never emit separate chunks.
            codeSplitting: false,
        },
    },
}
```

Inline CSS and assets in the bundle. The Map app's custom
[`build/singlefile.ts`](../ACE_TacPhone_Map/build/singlefile.ts) inlines CSS as a
`data:` URL; the host itself uses `vite-plugin-singlefile`. Keep assets as data
URLs rather than separate files.

### Loading additional files manually

Dynamic loading and CSS splitting are still possible. The difference is that
you cannot rely on a relative chunk URL; explicitly read the extra game file
through `window.Networking.LoadGameFileText`, then import it or attach it:

```ts
const moduleCache = new Map<string, Promise<unknown>>();

export function loadGameModule(path: string): Promise<unknown> {
    let promise = moduleCache.get(path);
    if (!promise) {
        promise = (async () => {
            const source = await window.Networking.LoadGameFileText(path);
            const url = URL.createObjectURL(
                new Blob([source], { type: 'text/javascript' }),
            );
            try {
                return await import(/* @vite-ignore */ url);
            } finally {
                URL.revokeObjectURL(url);
            }
        })();
        moduleCache.set(path, promise);
        promise.catch(() => {
            if (moduleCache.get(path) === promise)
                moduleCache.delete(path);
        });
    }
    return promise;
}

const stylesheetCache = new Map<string, Promise<void>>();

export function loadGameStylesheet(path: string): Promise<void> {
    let promise = stylesheetCache.get(path);
    if (!promise) {
        promise = (async () => {
            const css = await window.Networking.LoadGameFileText(path);
            const url = URL.createObjectURL(
                new Blob([css], { type: 'text/css' }),
            );
            await new Promise<void>((resolve, reject) => {
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = url;
                link.onload = () => resolve();
                link.onerror = () => {
                    link.remove();
                    URL.revokeObjectURL(url);
                    reject(new Error(`Failed to load stylesheet ${path}`));
                };
                document.head.appendChild(link);
            });
        })();
        stylesheetCache.set(path, promise);
        promise.catch(() => {
            if (stylesheetCache.get(path) === promise)
                stylesheetCache.delete(path);
        });
    }
    return promise;
}
```

Use game-filesystem paths in the same format as `ace_tacphone_file`, and ship
the extra files in the PBO:

```ts
const { openAdvancedMap } = await loadGameModule(
    '\\z\\my_mod\\addons\\my_app\\data\\advanced-map.js',
) as typeof import('./advanced-map');

await loadGameStylesheet(
    '\\z\\my_mod\\addons\\my_app\\data\\advanced-map.css',
);
```

A split JavaScript file is another ES module. It can use the host-provided bare
imports (`react`, `react/jsx-runtime`, and so on), but it cannot resolve relative
imports of its own: those specifiers would resolve against the blob URL and
fail. The same applies to `new URL(..., import.meta.url)` asset lookups; inline
those assets too. Build each split module as a leaf with no relative imports,
and load any dependency explicitly through `loadGameModule`. A module that
default-exports a component works with `React.lazy`:

```ts
const AdvancedMap = React.lazy(() =>
    loadGameModule('\\z\\my_mod\\addons\\my_app\\data\\advanced-map.js')
        as Promise<{ default: React.ComponentType }>,
);
```

For CSS, you can also use a `data:text/css` URL instead of a blob URL. A split
stylesheet cannot resolve relative `url()` references either; inline images and
fonts as data URLs.

Build each extra JavaScript module as its own single-file ES library build.
Build the CSS with your usual CSS/Sass build, or enable CSS code splitting and
ship the resulting file. Do not ship Vite's automatically generated chunk graph
with relative imports; only ship files that the manual loader can read and
import directly.

This does have a cost. Every additional file is another game-filesystem read,
blob creation, and module parse/evaluation (or stylesheet load). The first use
is therefore slower than a normal bundler chunk, especially through the external
WebSocket transport; a large CSS file also has to be fetched and parsed before
the styles apply. Cache loaded modules/styles per path, and prefetch on idle if
a feature is likely to be opened. During development the file must be available
through the game/WebHost filesystem, not only from the Vite output directory.

Do not use a bundle-relative dynamic import in the production entry module; use
`LoadGameFileText` for any file that is not part of the entry bundle.

## Related documentation

- [`../ACE_TacPhone_Map/README.md`](../ACE_TacPhone_Map/README.md) —
  the reference app and its build.
