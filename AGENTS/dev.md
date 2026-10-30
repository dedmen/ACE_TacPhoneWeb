# Development server and debugging

Read this when running the UI outside Arma, changing app discovery, or debugging
host/app source maps. For the in-game browser constraints see the root
[`AGENTS.md`](../AGENTS.md); for shipped build outputs see [`build.md`](build.md).

## Preconditions

- `npm install` once at the workspace root.
- Keep Arma and TacPhone running: the extension serves `wss://localhost:8001/ws`.
- Trust the local ASP.NET TLS certificate, otherwise the dev page cannot open the
  WebSocket.
- Open the printed `http://localhost:<port>` URL. Never use `127.0.0.1`:
  `IsLocalDev()` matches the exact `http://localhost` prefix and loads apps from
  the dev server. (The transport itself is chosen by `IsArma()`: a `blob:` page
  URL means the in-game browser.)

## Where discovery lives

- [`ACE_TacPhone_Main/dev-apps.js`](../ACE_TacPhone_Main/dev-apps.js) discovers
  app folders. Extend or change discovery here.
- [`ACE_TacPhone_Main/vite.config.ts`](../ACE_TacPhone_Main/vite.config.ts)
  serves `/devapps/<AppName>/`, generates `server.fs.allow`, and rewrites app
  source maps. The plugin is `devAppsPlugin`.
- Restart Vite after changing `dev-apps.local.json`, `TACPHONE_DEV_APPS`, or the
  marker in a `package.json`; discovery runs once at server start.

Discovery order:

1. `ACE_TacPhone_Main/dev-apps.local.json` (git-ignored):
   `{ "apps": ["../ACE_TacPhone_Map", "D:/dev/MyApp"] }`; relative paths resolve
   from `ACE_TacPhone_Main`.
2. The `TACPHONE_DEV_APPS` environment variable, using the platform path
   separator (`;` on Windows).
3. Sibling folders of `ACE_TacPhone_Main` whose `package.json` contains
   `"tacphone": { "app": "<AppName>" }`.

The declared app name must match the game-side `ace_tacphone_apps` config class
exactly. It is also the request routing key (`a`). A folder listed in the config
file or environment variable may omit the marker; the folder name is then used as
the app name. Sibling folders require the marker.

The host serves each app as `/devapps/<AppName>/` and imports the entry named by
`ace_tacphone_devFile` in the app config (default `src/main.tsx`), for example
`/devapps/ACE_TacPhone_Map/src/main.tsx`.

## Running

```powershell
npm run dev                            # host, from the workspace root
npm run dev -w ace-tacphone-map        # forwards to the host server
npm run dev -w ace-tacphone-sampleapp  # forwards to the host server
```

Apps have no standalone dev server. Running an app's own Vite server would miss
`window.TacPhone`, the host import map, networking, and panel layout.

## Debugging

Use an external Chrome/Chromium with devtools. The checked-in
[`addons/tacphone/.vscode/launch.json`](../../.vscode/launch.json) is a starting
point; its `webRoot` is `${workspaceFolder}/websource/ACE_TacPhone_Main` when the
workspace folder is `addons/tacphone`.

App files are outside the Vite root and are served from `/@fs/<absolute path>`
URLs. `devAppsPlugin` rewrites their dev source maps to absolute source paths, so
breakpoints in app sources bind to the real files. Keep that rewrite: without it
breakpoints land in temporary `.../@fs/D:/...` files. Host files map through
`webRoot`. Do not add a `sourceMapPathOverrides` workaround for `/@fs/` URLs, and
do not use the VS Code integrated browser (it does not resolve `webRoot`).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Page cannot connect | Arma + TacPhone running, TLS cert trusted, URL is `localhost` not `127.0.0.1`. |
| App missing from the chooser | `package.json` marker / config entry name equals the SQF config class; Vite restarted; the game-side `ace_tacphone_apps.hpp` is in the loaded PBO. |
| App loads but `window.TacPhone` is missing | The page is served by the host server, not the app's own Vite server. |
| Breakpoints do not bind in app sources | Keep the `devAppsPlugin` source-map rewrite; do not add `sourceMapPathOverrides`. |
| `npm run preview` uses dev app URLs but 404s | `/devapps/` is `apply: 'serve'`; this is a known limitation (see `TODO.md`). |
| Hosted page shows "The game is not connected" | The in-game Remote Access panel was never opened this session, the relay is down, or the CBA `Remote host` is wrong. See [`remote.md`](remote.md). |
| LAN page shows the pairing screen | The page was opened through a public hostname; the direct/relay detection treats only loopback, LAN IPs and `.local` as direct (see `TODO.md`). |
