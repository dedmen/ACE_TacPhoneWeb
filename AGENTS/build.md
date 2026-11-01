# Workspace, build, and release

Read this when changing workspace scripts, packages, build configuration, or
copying artifacts into the game. Runtime rules live in the area docs.

## Layout

| Path | Purpose |
| --- | --- |
| `packages/tacphone-api/` | `@ace-tacphone/api`: the app-facing contract types (`src/index.ts`, `src/globals.ts`). Types only; runtime is `window.TacPhone`. |
| `packages/tacphone-build/` | `@ace-tacphone/build`: `shared-modules.js`, `singlefile.ts`, and the `tacphone-build` CLI. |
| `ACE_TacPhone_Main/` | Host: React UI, layout, networking, app loader, public API. |
| `ACE_TacPhone_Map/` | Reference app, sibling of the host. |
| `MessagingApp/` | Messenger app (chat, rooms, presence), sibling of the host. |
| `SampleApp/` | Minimal example app; also the new-app template. |
| `WebServerExtension/` | .NET 10 NativeAOT `arma_webhost_x64`; external-browser dev only. See [`webhost.md`](webhost.md). |
| `RemoteServer/` | .NET 10 relay + static host for public remote access. Separate deployable, not part of the add-on. See [`remote.md`](remote.md). |
| `WebHostExtension_FeatureFlagsExport/` | C shim for `RVExtensionFeatureFlags`; `WebServerExtension/featureflags.obj` is checked in and linked. |
| `../` (`addons/tacphone`) | Parent game add-on: SQF, config, apps. See [`sqf.md`](sqf.md). |

## Commands

From this directory (workspace root):

```powershell
npm install            # one root lockfile, hoisted workspace deps
npm run dev            # host Vite server; open the printed URL
npm run build          # release: host + Map + SampleApp + Messaging
npm run build:debug    # debug: host + every app
npm run build:host
npm run build:apps
npm run build:apps:debug
npm run check          # tsc -b in every workspace package
npm run lint
npm run check:importmap
npm run sync:api-types -- <source.d.ts> <target-dir-or-file>...
```

**While developing, always build with `npm run build:debug` (or an app's
`build:debug`), never `npm run build`.** Debug output is unminified, keeps
`console.log`, and carries an inline source map, so the in-game developer
console maps the blob-imported bundle back to the original `.tsx`. Run the
release `npm run build` and re-copy the outputs only when the artifact is meant
to ship: a debug bundle is several times larger because the source map is
embedded, and it must not end up in `apps/*/data/`.

Host (`ACE_TacPhone_Main`):

```powershell
npm run build          # tsc -b + vite release build + shared-import check
npm run build:debug    # unminified + inline source maps
npx tsc -b             # typecheck only
Copy-Item dist\index.html ..\..\data\index.html
```

Public relay (`RemoteServer/`, optional): copy the same host build into the
server before publishing/deploying it:

```powershell
Copy-Item ACE_TacPhone_Main\dist\index.html RemoteServer\src\TacPhone.RemoteServer\wwwroot\index.html
Copy-Item ACE_TacPhone_Main\dist\index.html RemoteServer\publish\wwwroot\index.html
```

The relay serves its own copy of the host page. Updating `addons/tacphone/data/index.html`
and the in-game PBO is not enough; an old relay copy silently drops app pushes
that arrive before the app finishes loading.

Apps (`ACE_TacPhone_Map`, `MessagingApp`, `SampleApp`), run from the app folder:

```powershell
npm run build          # tsc -b + vite + shared-import check + bundle-api-types
Copy-Item dist\ace_tacphone_map.js ..\..\apps\map\data\ace_tacphone_map.js
Copy-Item dist\ace_tacphone_ol.js ..\..\apps\map\data\ace_tacphone_ol.js
Copy-Item dist\ace_tacphone_messaging.js ..\..\apps\messaging\data\ace_tacphone_messaging.js
Copy-Item dist\ace_tacphone_sampleapp.js ..\..\apps\SampleApp\data\ace_tacphone_sampleapp.js
```

The Map app's build also runs `tacphone-build facade build` after `vite build`
and writes `dist\ace_tacphone_ol.js`; that artifact is a normal
`TACPHONE-BUNDLE:` file and goes into the app's game `data\` folder like the app
bundle. See [`apps.md`](apps.md#runtime-dependencies).

All copy destinations are git-ignored in ACE3. The build does not copy them for
you. A successful app build also emits the generated `dist/<name>.d.ts` used by
consumers.

## Applying the game build

HEMTT writes the PBO to `.hemttout/build/addons/ace_tacphone.pbo`; it does not
update the game's dev mod directory.

When the PBO needs to be updated and Arma is running, ask the user to exit the
game first. Then copy the built PBO over the dev mod copy and let the user
restart:

```powershell
Copy-Item .hemttout\build\addons\ace_tacphone.pbo `
    'D:\Spiele\SteamLibrary\steamapps\common\Arma 3\@acedev\addons\ace_tacphone.pbo' -Force
```

The game loads that PBO from `@acedev\addons` on the next start. Never replace it
while Arma has the file open.

The native extension is separate: the game loads
`D:\Spiele\SteamLibrary\steamapps\common\Arma 3\arma_webhost_x64.dll`. After
rebuilding `WebServerExtension`, ask the user to exit the game, back up the old
DLL, then replace that file. The game only picks it up on restart.

## Build behavior

- `npm run build` is a release build: minified, no source map, and
  `console.log/debug/info` calls are removed. `console.warn` and `console.error`
  stay in both modes; keep them useful.
- `npm run build:debug` is unminified with an inline source map.
- An app bundle is never stored as plain JavaScript. Both modes write one ASCII
  line, `TACPHONE-BUNDLE:1:gzip:<base64>`, because `loadFile` and
  `A3API.RequestFile` pass text through C strings and would truncate raw gzip at
  its first NUL byte. The single-file plugin does this after the inline source
  map is attached, so debugging still works. `AppDirectory` unpacks it; there is
  no plain-bundle fallback. See `packages/tacphone-build/README.md`.
- The host produces one self-contained `dist/index.html` (inline script and
  import map) for the in-game `CT_WEBBROWSER`. The host is not compressed this
  way; only app bundles are.
- An app produces one self-contained ESM bundle plus a self-contained
  declaration file. See [`apps.md`](apps.md) for the packaging rules.
- There are no tests. `npm run check` is the typecheck; builds run the
  shared-import checker automatically. That checker decodes the bundle first; a
  bundle without the header fails the build of its own package and only warns
  while another package is built, so a stale `dist/` cannot block unrelated
  builds.

## `@ace-tacphone/api`

The single source of truth for what an app may import:

- `TACPHONE_API_VERSION` (currently `1`) and the app module/panel types.
- `TacPhoneHost` (`window.TacPhone`) and every host service type.
- The `Window.TacPhone` augmentation in `src/globals.ts`.

Add or change public types here first, then implement them in
`ACE_TacPhone_Main/src/Backend/Host.ts` (and the owning service module). Host
code re-exports the same contract through `src/TacPhoneMain.ts`; apps must not
import that file.

## `@ace-tacphone/build`

Read [`packages/tacphone-build/README.md`](../packages/tacphone-build/README.md)
before changing it. The parts that affect day-to-day work:

- `shared-modules.js` is the sole source for the host import map, the host module
  map (`window.TacPhone.modules`), Vite dedupe, app build externals, and the
  checker. To add a shared module, update this file **and** publish its namespace
  in `ACE_TacPhone_Main/src/Backend/SharedModules.ts`; apps cannot add mappings.
- `singlefile.ts` (`@ace-tacphone/build/singlefile`) inlines CSS/assets for app
  bundles. The host uses `vite-plugin-singlefile` instead; do not swap them.
- `tacphone-build bundle-api-types --app . --entry src/api.ts --name <Name>`
  bundles an app's inter-app types into `dist/<name>.d.ts`.
- `tacphone-build sync-api-types <source.d.ts> <target...>` copies an already
  generated app declaration to consumers. Never hand-edit a synced copy.
- `tacphone-build facade build --app <dir> --package <name> --prefix <prefix>
  --out <file>` turns the specifiers a `tacphoneFacade()` build externalized into
  one compressed facade module; the Map app runs it after `vite build`.
- `tacphone-build check-shared-imports` validates the host import map and every
  discovered app bundle; it also runs at the end of every build.

The host no longer generates or syncs `TacPhoneMain.d.ts`, and no app keeps a
copy of the host contract.
