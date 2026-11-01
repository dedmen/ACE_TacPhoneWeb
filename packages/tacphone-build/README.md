# @ace-tacphone/build

Shared build tooling for the TacPhone host and apps: the `tacphone-build` CLI,
the single shared module list, the app dependency/facade tooling, and the one
custom single-file plugin.

The package is a workspace dependency of `ACE_TacPhone_Main`, `ACE_TacPhone_Map`,
and `SampleApp`. It is `private` and never published; it holds build-time code
only and must not import host or app source.

## CLI

```text
tacphone-build bundle-api-types --app <dir> [--entry src/api.ts] [--name <name>] [--output <file>]
tacphone-build sync-api-types <source.d.ts> <target-dir-or-file>...
tacphone-build check-shared-imports
tacphone-build facade build --app <dir> --package <name> --prefix <prefix> --out <file> [--manifest <file>]
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
  URL that reads its namespace from `window.TacPhone.modules.get("<specifier>")`
  and re-exports the required names. An entry that reads a legacy per-module
  window global (`window.<Module>` namespaces from before the module map) fails
  the check.
- Every discovered app's `dist/*.js` is decoded from its
  `TACPHONE-BUNDLE:<version>:<codec>:<base64>` container and every static and
  dynamic `import` specifier is extracted with `es-module-lexer`. Allowed are the
  shared specifiers, the app's own `package.json` `tacphone.dependencies` keys,
  a declared `facade` prefix itself and anything under it (the prefix may be
  written with or without a trailing slash), and `data:`/`blob:` URLs. Relative
  specifiers, network or file schemes, unknown bare specifiers, and dynamic
  imports with a computed (non-literal) URL are errors.

`es-module-lexer` parses modules, not JSX, so the checker only ever scans the
built bundles. Errors name the bundle, the offending specifier, and the fix:
bundle it, declare it in `package.json` `"tacphone.dependencies"`, or add it to
`shared-modules.js`.

A bundle without the header is a hard failure when it belongs to the package that
is being built (an app's own bundle must be compressed), and a `WARN ... rebuild`
for the other apps, so building one app never fails because another app's `dist/`
is stale. Running the command from the workspace root checks every bundle
strictly. The game also rejects an uncompressed bundle at load time with the same
rebuild hint, so a stale artifact cannot be shipped silently.

Each checked bundle is reported as `OK  <path> (<n> imports)`. The command fails
when nothing could be checked, which usually means neither the host nor an app has
been built yet.

## `shared-modules.js`

`@ace-tacphone/build/shared-modules` is the single source of truth for the bare
module specifiers the host provides:

| Specifier |
| --- |
| `react` |
| `react-dom` |
| `react-dom/client` |
| `react/jsx-runtime` |
| `react/compiler-runtime` |
| `qrcode-generator` |

It exports `SHARED_MODULES` (`{ specifier }` objects, frozen) and
`SHARED_MODULE_SPECIFIERS` (the specifier strings). It drives the host import
map, the host `resolve.dedupe` list, the app build `external` list,
`check-shared-imports`, and the dependency list a facade build may rely on.

There is no per-module `window` global any more. The host publishes each
namespace on the internal `window.TacPhone.modules` map (`Map<string, unknown>`),
keyed by specifier, and the import map entry re-exports that namespace:

```
data:text/javascript,const __m = window.TacPhone.modules.get("react"); export default __m; export const useState = __m.useState; ...
```

`window.TacPhone.modules` is internal to the loader; apps never read it. An app
gets the namespace by importing the bare specifier, which the import map
resolves. Add a module here **and** publish its namespace in the host's
`ACE_TacPhone_Main/src/Backend/SharedModules.ts`; apps cannot add mappings on
their own. Anything else must be bundled into the app or declared as an app
dependency.

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

Finally, in `writeBundle` (after Rollup wrote the file, so inlined CSS, escaping
and the inline source map of a debug build are already in it), the plugin
rewrites the single emitted `.js` as `TACPHONE-BUNDLE:1:gzip:<base64>` and logs
the size ratio. Every app bundle is compressed; there is no option to disable it
and no plain variant. Gzip output contains NUL bytes and the game moves file text
through C strings, so base64 is what makes a compressed bundle loadable at all.

The host is different: it builds an HTML page and uses
`vite-plugin-singlefile` instead. Do not swap them.

## App dependencies

An app may need a library that is too large to re-bundle into every app, or that
must stay one shared copy at runtime. Declare it as an app dependency: the game
ships one extra file per dependency, the host maps the bare specifier onto it,
and the app bundle keeps importing the specifier as external.

### Game config

Dependencies live next to the app in the game add-on's `ace_tacphone_apps`
class:

```cpp
class EGVAR(tacphone,apps) {
    class ACE_TacPhone_Map {
        // ...app entries...
        class EGVAR(tacphone,dependencies) {
            class some_library {
                name = "some-library";                      // bare specifier; defaults to the class name
                file = QPATHTOF(data\some-library.js);      // required
            };
            class tacphone_ol_core {
                name = "tacphone-ol-core";
                file = QPATHTOF(data\ace_tacphone_ol.js);
            };
        };
    };
};
```

`name` is the bare specifier the app imports (empty means the class name), `file`
is required. Dependencies are read in parallel, imported in **config definition
order**, and that order is their execution order. List a transitive dependency
before the module that imports it so side effects happen in the intended order.

### `package.json`

`tacphone.dependencies` tells the build which specifiers stay external. The key
is the specifier; `facade` marks a prefix that the facade build provides:

```json
"tacphone": {
  "app": "ACE_TacPhone_Map",
  "dependencies": {
    "some-library": {},
    "tacphone-ol-core": { "facade": "tacphone-ol/" }
  }
}
```

A `facade` dependency allows the prefix itself (`tacphone-ol`) and every
specifier under that prefix (`tacphone-ol/Map`, `tacphone-ol/View`, ...) without
listing each one. The prefix may be written with or without a trailing slash.

### Vite config

Add the declared keys to the app's `external` list so the single-file plugin
never tries to inline them:

```ts
import pkg from './package.json' with { type: 'json' };
import { SHARED_MODULE_SPECIFIERS } from '@ace-tacphone/build/shared-modules';

external: [...SHARED_MODULE_SPECIFIERS, ...Object.keys(pkg.tacphone?.dependencies ?? {})],
```

A facade dependency needs no entry here: `tacphoneFacade()` marks the rewritten
`tacphone-ol/...` ids external itself, which is why the Map app only lists
`SHARED_MODULE_SPECIFIERS`.

### Build and copy

```powershell
# in the app folder: build the app (writes dist/<app>.js, a TACPHONE-BUNDLE)
npm run build
# build the dependency file, then copy both into the game add-on
tacphone-build facade build --app . --package ol --prefix tacphone-ol --out dist/ace_tacphone_ol.js
Copy-Item dist\ace_tacphone_map.js ..\..\apps\map\data\ace_tacphone_map.js
Copy-Item dist\ace_tacphone_ol.js ..\..\apps\map\data\ace_tacphone_ol.js
```

Both destinations are git-ignored; the build never copies them for you. The Map
app's `npm run build` runs the facade command itself after `vite build` and
writes `dist/ace_tacphone_ol.js`, which is then copied into the game add-on the
same way as the app bundle.

### Dev versus production

- **Dev** (`npm run dev`): the facade plugin is inert, so the real package
  resolves from `node_modules` and the import map is irrelevant.
- **Production**: the app bundle imports the external specifier, and the host
  registers the dependency file's URL for it. The game reads the file named in
  the app's config; nothing resolves from `node_modules` in game.

### File format

A dependency file may be a plain ES module or a `TACPHONE-BUNDLE` (the same
container an app uses). Plain text is fine for a hand-written shim; a
built library should be compressed, because `loadFile` and
`A3API.RequestFile` truncate raw gzip at its first NUL byte.

### Import rules

An app bundle is one self-contained module, and the in-game browser has no
network:

- No relative imports (`./`, `../`, `/`) and no `http:`, `https:`, `ws:`,
  `wss:`, `file:`, or protocol-relative `//` URLs.
- `data:` and `blob:` URLs are allowed.
- A bare specifier is allowed only when it is a shared module (see
  `shared-modules.js`) or declared in `tacphone.dependencies` / under a declared
  facade prefix.
- A dynamic import must use a literal specifier; a computed URL cannot be
  resolved through the shim.

`tacphone-build check-shared-imports` enforces all of this after every build.

## Facade builds

A subpath-heavy library such as OpenLayers cannot be shipped as separate chunks,
and the app cannot import `ol/Map` unless the module map knows that name. A facade
build turns the modules the app actually used into one plain ESM file, exported
under a prefix, and records the mapping in a manifest.

### Vite plugin: `tacphoneFacade()`

```ts
import pkg from './package.json' with { type: 'json' };
import { tacphoneFacade } from '@ace-tacphone/build/facade';

plugins: [
  tacphoneFacade({ packageName: 'ol', prefix: 'tacphone-ol' }),
  // ...
]
```

| Option | Meaning |
| --- | --- |
| `packageName` | Library to externalize, e.g. `ol`. |
| `prefix` | Facade prefix, e.g. `tacphone-ol`; `ol/Map` becomes `tacphone-ol/Map`. |
| `manifestFile` | Optional manifest path; defaults to `node_modules/.tacphone-facade/<packageName>.json` under the Vite root. |

The plugin (`enforce: 'pre'`, build only) resolves `packageName` and every
`packageName/...` import except `.css` to `prefix + subpath`, marks it
`external: true`, and writes a manifest with every specifier it saw:

```json
{ "packageName": "ol", "prefix": "tacphone-ol", "specifiers": ["ol", "ol/Map"] }
```

In dev the plugin is inert, so the real package resolves from `node_modules`.

### CLI: `tacphone-build facade build`

```text
tacphone-build facade build --app <dir> --package <name> --prefix <prefix> --out <file> [--manifest <file>]
```

1. Reads the manifest the plugin wrote (build the app first; the command fails
   with that hint when it is missing).
2. Resolves every specifier from the app's `node_modules` and imports each
   namespace.
3. Generates a temporary entry module that re-exports every key under a unique
   alias and writes one `__tacphoneFacade` map from facade specifier to those
   aliases.
4. Builds it with Vite and `viteSingleFile({ failOnNotInlined: true })`, so the
   facade is one self-contained module that `singlefile.ts` compresses to
   `TACPHONE-BUNDLE:1:gzip:<base64>`.
5. Copies the result to `--out`, removes the temporary directory, and logs the
   path and byte size.

The host reads `__tacphoneFacade` and generates tiny `data:` adapters
(`tacphone-ol/Map` -> the aliases in the core file), so the app bundle only ever
imports facade specifiers. Ship one facade file per app; apps do not coordinate.

## Standalone reuse outside TacPhone

The in-game loader has to survive the same constraints in any Arma project that
loads a web UI from game files. These modules are independent of TacPhone and
Arma types:

| File | Purpose |
| --- | --- |
| `packages/tacphone-build/singlefile.ts` | `viteSingleFile`: inlines CSS/assets, escapes non-ASCII, gzip+base64 bundle. |
| `packages/tacphone-build/bundle-format.js` | `TACPHONE-BUNDLE` marker and header parser (browser-safe, no imports). |
| `packages/tacphone-build/facade.js` | `tacphoneFacade()` Vite plugin and `tacphone-build facade build`. |
| `packages/tacphone-build/shared-modules.js` | Example host module list (optional). |
| `ACE_TacPhone_Main/src/Backend/` dependency loader | Runtime counterpart: `es-module-shims` bootstrapping, ordered dependency loading, blob URLs, per-specifier import maps. See `PLAN_APP_DEPENDENCIES.md`. |
| `ACE_TacPhone_Main/src/Backend/AppDirectory.ts` | Shows how the bundle header is unpacked before a blob import; it imports `bundle-format.js`. |

Copy `bundle-format.js` too whenever you copy the loader or `AppDirectory`: both
sides must agree on the header, and it must never be inlined as a copy of the
string.

npm dependencies: `es-module-shims` (shim-mode import maps), `es-module-lexer`
(bundle import scanning), `vite` (build), and `micromatch` (asset globs in the
single-file plugin).

Minimal usage:

```ts
import { defineConfig } from 'vite';
import { viteSingleFile } from './singlefile';
import { tacphoneFacade } from './facade';

export default defineConfig({
    build: { lib: { entry: 'src/main.ts', formats: ['es'], fileName: 'app.js' } },
    plugins: [
        tacphoneFacade({ packageName: 'ol', prefix: 'tacphone-ol' }),
        viteSingleFile({ failOnNotInlined: true }),
    ],
});
```

```js
// host side
const loader = createDependencyLoader({
    importShim: window.importShim,
    loadText: path => myGame.readTextFile(path),
    sharedImportMap: { imports: { /* host modules */ } },
});

await loader.register([{ name: 'some-library', file: '\\path\\to\\some-library.js' }]);

const app = await loader.importApp(appBlobUrl);
```

## `bundle-format.js`

The on-disk app bundle format, shared by the build and the host loader:

```
TACPHONE-BUNDLE:<version>:<codec>:<base64>
```

| Export | Meaning |
| --- | --- |
| `APP_BUNDLE_MARKER` | `TACPHONE-BUNDLE:`, the start of every bundle regardless of version or codec. |
| `APP_BUNDLE_VERSION` | Container version the build writes (`1`). |
| `APP_BUNDLE_CODEC_GZIP` | The only codec the build writes and the reader accepts. |
| `formatAppBundleHeader(version?, codec?)` | Builds the header line. |
| `parseAppBundleHeader(text)` | Returns `{ version, codec, payload }`, or `{ error }` when the text is not a bundle. |

Version and codec are separate fields so brotli can become
`TACPHONE-BUNDLE:1:brotli:<base64>` without changing the header shape; an old
host then reports the codec instead of trying to parse it as JavaScript.

`bundle-format.js` is browser-safe and imports nothing, because
`ACE_TacPhone_Main/src/Backend/AppDirectory.ts` imports the header helpers to
unpack an app before importing it from a blob URL. The Node half,
`@ace-tacphone/build/bundle-format/node`, exports `encodeAppBundle(code)` and
`decodeAppBundle(text)` and is what `singlefile.ts` and `check-shared-imports`
use. Keep the two in sync through this module; never inline a copy of the header
string elsewhere.

## Notes

- Requires Node 20.19+ or 22.12+ (same as the workspace). The facade CLI imports
  `singlefile.ts` through the package `exports` map, so Node must be able to load
  TypeScript sources (Node 22.18+ strips types by default).
- Depends on `typescript`, `@microsoft/api-extractor`, `vite`, `rollup`,
  `es-module-lexer`, and `micromatch`; the shared plugin exposes Vite/Rollup
  types, so app packages resolve those from the workspace.
- `paths.mjs` finds the workspace root, the host package, and the dev app list
  used by the checker; it is internal and not part of the published exports.
