# AGENTS.md

TacPhone web UI and development web host. This directory is the `ACE_TacPhoneWeb`
submodule at `addons/tacphone/websource`; the parent HEMTT build excludes it.
Build here, then copy the outputs into the parent add-on. The root `package.json`
is an npm workspace. Every incomplete task or placeholder must be listed in
`TODO.md`.

Web code is in `ACE_TacPhone_Main` (host), `ACE_TacPhone_Map` and `SampleApp`
(apps), and `packages/` (contract/build tooling). The game side is the parent
`addons/tacphone` add-on.

## Read only the file for your task

The documentation is split by area so a task does not need to load unrelated app
or SQF details. Pick the row below; every linked file is self-contained and has
its own file map, rules, and links to the deeper READMEs.

| If the task is about... | Read |
| --- | --- |
| Game side: SQF, config, request/response protocol, interests, extension bridge | [`AGENTS/sqf.md`](AGENTS/sqf.md) |
| Host UI (`ACE_TacPhone_Main`): panels, layout, app loading, networking, inter-app, notifications | [`AGENTS/host.md`](AGENTS/host.md) |
| Map app (`ACE_TacPhone_Map`), web UI or game-side handlers | [`AGENTS/map.md`](AGENTS/map.md) |
| App contract, packaging, creating an app, SampleApp | [`AGENTS/apps.md`](AGENTS/apps.md) |
| Workspace commands, packages, build/release, tooling | [`AGENTS/build.md`](AGENTS/build.md) |
| Development server, app discovery, VS Code debugging | [`AGENTS/dev.md`](AGENTS/dev.md) |
| .NET `WebServerExtension` | [`AGENTS/webhost.md`](AGENTS/webhost.md) |
| Remote access: public relay, pairing codes, share links | [`AGENTS/remote.md`](AGENTS/remote.md) |

When a change crosses an area, read the other file only for that boundary. When
you change behavior, update the matching `AGENTS/*.md` file and its README
section in the same change.

## Rules that apply to every area

- **PowerShell Commands**: All commands must be run using **PowerShell**. Use semicolons (`;`) to separate multiple commands on one line, not `&&`. Example: `Copy-Item file1.txt ..\data\file1.txt; Copy-Item file2.txt ..\data\file2.txt`. Using shell operators like `&&` will cause PowerShell parser errors.
- The in-game browser is sandboxed Chromium 126: no `fetch`/XHR, `localStorage`,
  or `IndexedDB`. Use `window.TacPhone.networking` for everything. Open dev
  pages through `http://localhost:<port>`, never `127.0.0.1`; `IsLocalDev()`
  matches that exact prefix to load apps from the dev server.
- `StrictMode` is enabled in `ACE_TacPhone_Main/src/main.tsx` on purpose: React
  mounts components twice in development. App loading, panel-instance creation,
  layout restore, and every app lifecycle effect must stay idempotent. Never
  disable StrictMode to hide a double-mount bug.
- `window.TacPhone` is the only app-facing global and `@ace-tacphone/api` the
  only app contract. Apps never import host code or `TacPhoneMain.ts`, and the
  host is not passed as a prop or argument.
- A production app is one self-contained ESM imported from a blob URL: no
  relative imports, dynamic chunk imports, local `React.lazy` chunks, CSS side
  files, or `new URL(..., import.meta.url)`. Inline CSS/assets with
  `@ace-tacphone/build/singlefile`.
- Shared modules are fixed in `packages/tacphone-build/shared-modules.js`: only
  `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, and
  `react/compiler-runtime`. Keep them external; apps cannot add mappings.
- Only the selected tab of a tabset is mounted, so a background panel has no live
  instance or registered API. Route with `window.TacPhone.interApp.resolveAsync()`
  (it activates the panel and waits); native window popouts (`window.open`) are
  unsupported in the in-game browser.
- `dist/`, `data/index.html`, and `apps/*/data/*.js` are generated, git-ignored
  artifacts. Never edit them by hand. There are no tests; release builds strip
  `console.log/debug/info` and keep `warn`/`error`. Node 20.19+ or 22.12+.

## Deeper reference

- [`ACE_TacPhone_Main/README.md`](ACE_TacPhone_Main/README.md) — host contract,
  app authoring, inter-app API, interests, notifications, packaging.
- [`ACE_TacPhone_Map/README.md`](ACE_TacPhone_Map/README.md) — reference app.
- [`SampleApp/README.md`](SampleApp/README.md) — minimal end-to-end app and the
  new-app checklist.
- [`packages/tacphone-api/README.md`](packages/tacphone-api/README.md) — exported
  contract types.
- [`packages/tacphone-build/README.md`](packages/tacphone-build/README.md) —
  `tacphone-build` CLI, shared modules, single-file plugin.
- [`TODO.md`](TODO.md) — all known incomplete work and placeholders.
