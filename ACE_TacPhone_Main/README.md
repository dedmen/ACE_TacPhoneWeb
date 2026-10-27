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

A development app is loaded from `devapps` by app name. See
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

## Developing apps

An app is a JavaScript ES module that is loaded dynamically by the host. A mod
can provide one or more apps. During development an app must live at:

```text
ACE_TacPhone_Main/devapps/<AppName>/
```

`<AppName>` must match the config class name exactly. The current development
loader imports:

```text
/devapps/<AppName>/src/main.tsx
```

Install the app's own dependencies in its directory (`npm install` inside the
app folder), then start the host with `npm run dev`. Vite serves the app through
the host dev server, so edits to the app hot-reload. Running the app's own Vite
dev server is not enough: it does not provide the TacPhone globals, networking,
or host import map.

Because the app folder has to be below the host web root, keep it there while
developing, or copy/junction it into `devapps`. A plain symlink inside `devapps`
has not worked reliably with Vite.

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
| `ace_tacphone_file` | Yes, except `main` | Path to the single production ES module in the game filesystem. It is read with `loadFile` and imported from a blob URL. |
| `ace_tacphone_devFile` | Recommended | Entry point relative to the app folder. Keep it as `src\main.tsx`. The current dev loader uses the folder name and the fixed `src/main.tsx` path. |
| `ace_tacphone_requestProcessor` | For app requests | Name of the SQF function that handles requests sent with `a: "<AppName>"`. It receives the request hashmap and may return any JSON-serializable value or a promise. |
| `icon` | No | Currently reserved; panel icons come from `GetTacPhoneIcon()`. |

`<AppName>` is also the routing key. It is the `a` field in requests and is the
folder name used by the development loader.

### Module exports

The entry module must export:

```ts
import React from 'react';

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

`AppPanelInfo` is declared in [`src/TacPhoneMain.d.ts`](src/TacPhoneMain.d.ts);
copy that declaration file into an app if it does not already have it.

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
| `window.A3API` | The engine-provided browser API. Prefer `window.Networking` so the same app works in external-browser mode. |

Tooling types for these are also in `src/TacPhoneMain.d.ts`.

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
    "react/jsx-runtime": "data:text/javascript,export default window.ReactJSXRuntime; ...",
    "react/compiler-runtime": "data:text/javascript,export default window.ReactCompilerRuntime; ..."
  }
}
```

The generated modules re-export the values that `src/main.tsx` assigns to
`window.React`, `window.ReactDOM`, `window.ReactJSXRuntime`, and
`window.ReactCompilerRuntime`.

Rules for app builds:

- Keep `react`, `react-dom`, `react/jsx-runtime`, and `react/compiler-runtime`
  external. Do not bundle a second copy of React; duplicate React copies break
  hooks and context.
- Only the exact specifiers above are mapped. Subpaths such as
  `react-dom/client`, `react/jsx-dev-runtime`, and `react-dom/server` are not.
  Bundle them in the app, or avoid them.
- A production app bundle is imported from a blob URL but resolves bare imports
  through the host document's import map. Do not rewrite these specifiers to
  file paths.
- If another shared dependency is needed, it must either be bundled or added to
  the host import map in `vite.config.ts`; apps cannot add mappings themselves.
- React Compiler users: keep `react/compiler-runtime` external as well; the host
  maps it to the compiler runtime that belongs to the same React instance.

In development Vite resolves the bare imports for you. The import map matters
most for a prebuilt app bundle loaded with `import()` from a blob URL.

## Production packaging: one ESM file per app

The production loader in `src/Backend/AppDirectory.ts` reads
`ace_tacphone_file` with `LoadGameFileText`, creates a `Blob`, and imports it:

```ts
const content = await window.Networking.LoadGameFileText(appInfo.file);
const url = URL.createObjectURL(
    new Blob([content], { type: 'application/javascript' })
);
return import(/* @vite-ignore */ url);
```

That loader can fetch exactly one file. Therefore an app's production output
must be:

- one JavaScript file,
- an ES module (`format: 'es'`),
- self-contained: no relative imports, no dynamic chunks, and no sidecar CSS,
  JSON, image, font, worker, or WASM files.

A dynamic `import('./chunk.js')`, `React.lazy(() => import(...))`, CSS code
splitting, or an asset URL that points at another emitted file will fail because
the blob URL has no sibling files to load.

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
[`build/singlefile.ts`](devapps/ACE_TacPhone_Map/build/singlefile.ts) inlines CSS
as a `data:` URL; the host itself uses `vite-plugin-singlefile`. Keep assets as
data URLs rather than separate files.

## Related documentation

- [`devapps/ACE_TacPhone_Map/README.md`](devapps/ACE_TacPhone_Map/README.md) —
  the reference app and its build.
