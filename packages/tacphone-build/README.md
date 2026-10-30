# @ace-tacphone/build

Shared build tooling for the TacPhone host and apps: the `tacphone-build` CLI,
the single shared module list, and the one custom single-file plugin.

The package is a workspace dependency of `ACE_TacPhone_Main`, `ACE_TacPhone_Map`,
and `SampleApp`. It is `private` and never published; it holds build-time code
only and must not import host or app source.

## CLI

```text
tacphone-build bundle-api-types --app <dir> [--entry src/api.ts] [--name <name>] [--output <file>]
tacphone-build sync-api-types <source.d.ts> <target-dir-or-file>...
tacphone-build check-shared-imports
```

`tacphone-build --help` prints the same usage. Every command exits non-zero with a
`FAIL <message>` line on error; run it through `npx tacphone-build ...` or an npm
script.

### `bundle-api-types`

Bundles one app's inter-app service contract into a self-contained declaration
file.

```powershell
tacphone-build bundle-api-types --app . --entry src/api.ts --name ACE_TacPhone_Map
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--app` | Required | App folder (contains `package.json` and `tsconfig.app.json`). |
| `--entry` | `src/api.ts` | App-relative TypeScript entry that exports the service contract. |
| `--name` | package `name`, then the folder name | Display name used in the banner and error messages. |
| `--output` | `package.json` `types`, then `main` with `.d.ts`, then `dist/<snake_case_name>.d.ts` | Output file. |

What it does:

1. Emits declarations for `--entry` into a temporary directory with the app's
   `tsconfig.app.json` options (declaration-only, no incremental state).
2. Rolls them up with `@microsoft/api-extractor` into the output file.
3. Prepends a "generated, do not edit" banner that points at the source entry.
4. Fails when the result is empty, still contains an external `import`/`export
   ... from`, has TypeScript errors, or is missing an export the entry declares.
5. Verifies `package.json` `types` against the written file, and fills it in when
   it is missing.

The host contract is **not** generated here: it comes from `@ace-tacphone/api`.
This command only bundles an app's own service types such as the Map's `MapApi`.

Every app's build script runs it after Vite, so a successful app build always
leaves a fresh `dist/<app>.d.ts` next to the JS bundle.

### `sync-api-types`

Copies one generated app declaration into explicit consumer locations.

```powershell
# from the workspace root
npm run sync:api-types -- ACE_TacPhone_Map/dist/ace_tacphone_map.d.ts SampleApp/src
```

- A target that ends in `.d.ts` is written as-is; any other target is treated as
  a directory and receives the source file name.
- Missing parent directories are created; targets that already match are reported
  as up to date.
- It copies bytes verbatim, so never hand-edit a synced copy: rebuild the source
  app instead.

This is the only sync path left. It distributes app service declarations between
apps that consume them; it is never used for the host contract and the host build
no longer generates or syncs any `TacPhoneMain.d.ts`.

### `check-shared-imports`

Verifies the built host import map and every discovered development app bundle
against `shared-modules.js`. It is also exposed as `npm run check:importmap` in
the host and app packages, and runs at the end of every build.

Checks:

- `ACE_TacPhone_Main/dist/index.html` (skipped when the host is not built) has an
  import map with exactly the shared specifiers, each a `data:text/javascript,`
  URL that reads the matching `window.<global>`.
- Every discovered app's `dist/*.js` has no bare import outside the shared list,
  scanning only the top-level import prologue so example imports in comments do
  not cause false positives.

The command fails when nothing could be checked, which usually means neither the
host nor an app has been built yet.

## `shared-modules.js`

`@ace-tacphone/build/shared-modules` is the single source of truth for the bare
module specifiers the host provides:

| Specifier | `window` global |
| --- | --- |
| `react` | `window.React` |
| `react-dom` | `window.ReactDOM` |
| `react-dom/client` | `window.ReactDOMClient` |
| `react/jsx-runtime` | `window.ReactJSXRuntime` |
| `react/compiler-runtime` | `window.ReactCompilerRuntime` |

It exports `SHARED_MODULES` (`{ specifier, global }` objects, frozen) and
`SHARED_MODULE_SPECIFIERS` (the specifier strings). It drives the host import map,
the host `src/main.tsx` globals, the host Vite `resolve.dedupe` list, the app
build `external` list, and `check-shared-imports`.

Add a module here **and** assign its global in `ACE_TacPhone_Main/src/main.tsx`
(both are type-checked against each other). Apps cannot add mappings on their
own; anything else must be bundled into the app.

## `singlefile.ts`

`@ace-tacphone/build/singlefile` is the one custom single-file Vite plugin used by
every app:

```ts
import { viteSingleFile } from '@ace-tacphone/build/singlefile';
```

It inlines CSS and assets as `data:` URLs so the built app is a single
self-contained ES module that can be imported from a blob URL. Apps cannot use
relative imports, dynamic chunk imports, local `React.lazy` chunks, CSS side
files, or `new URL(..., import.meta.url)`.

It also rewrites every non-ASCII code unit in the final JavaScript to a
`\uXXXX` escape. The in-game loader gets app text through `A3API.RequestFile`,
which decodes the file's UTF-8 bytes as the system ANSI codepage, so raw emoji
or accents arrive as mojibake. Keeping the bundle ASCII makes the text invariant
under that conversion; the JS parser restores the characters at runtime, so
source files can keep literal emoji.

The host is different: it builds an HTML page and uses
`vite-plugin-singlefile` instead. Do not swap them.

## Notes

- Requires Node 20.19+ or 22.12+ (same as the workspace).
- Depends on `typescript`, `@microsoft/api-extractor`, `vite`, `rollup`, and
  `micromatch`; the shared plugin exposes Vite/Rollup types, so app packages
  resolve those from the workspace.
- `paths.mjs` finds the workspace root, the host package, and the dev app list
  used by the checker; it is internal and not part of the published exports.
