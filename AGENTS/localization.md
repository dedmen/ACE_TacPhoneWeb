# Localization

Read this when adding, changing or reviewing any user-readable text in the
TacPhone web UI or its game-side stringtable. It is the single reference for the
stringtable layout, key naming and what must not be translated.

Related: [`apps.md`](apps.md) (app contract), [`host.md`](host.md) (host
services), [`sqf.md`](sqf.md) (game-side requests), [`build.md`](build.md)
(build tooling).

## Where the strings live

- One stringtable per add-on: `addons/tacphone/stringtable.xml`. There is no
  per-app stringtable in this add-on; the host, Map, Messenger and SampleApp all
  share this file.
- In-game path: `\z\ace\addons\tacphone\stringtable.xml`, returned by
  `QPATHTOF(stringtable.xml)` and reported through `Localization.Info`.
- **The XML file is not currently readable in-game.** HEMTT compiles it to
  `stringtable.bin` and does not ship the source. The whole table is therefore
  bundled into the host `index.html` at build time
  (`virtual:tacphone-stringtable`), and `Localization.Info` is only used for the
  game language. The runtime XML loader is kept behind
  `LOAD_STRINGTABLE_FILE = false` in `Backend/Localization.ts` for when the file
  is available again; **do not enable it** until then.
- SQF must never read or parse the stringtable; game-side code only answers
  `Localization.Info` (`language` + path) and the on-demand `Localization.Get`
  fallback.
- CI constraints (`tools/stringtable_validator.py`): the file has one
  `<Package>` named `Tacphone`; keys start with `STR_ACE_Tacphone_`; `<English>`
  is the first entry of every key; no `<Original>`; IDs are unique; indent with
  4 spaces and never tabs.
- Restart the game after editing the stringtable. It is read at game start, not
  per request.

## Containers inside `<Package name="Tacphone">`

| Container | Contents |
| --- | --- |
| `Settings` | Existing CBA setting names/descriptions. Do not move or rename. |
| `Common` | Text shared by two or more areas (Cancel, Close, Done, Retry, …). |
| `Host` | Host shell: app chooser, tab chrome, target chooser, notifications, error boundary, host log. |
| `Options` | Host Options panel chrome. App option text stays with the app's own container. |
| `RemoteAccess` | Remote Access panel and the remote pairing screen. |
| `Map` | Map app, marker dialogs, polylines, layers, Map options. |
| `Messenger` | Messenger app and its notifications. |
| `SampleApp` | The template app. |

`hemtt ln sort` orders containers and keys alphabetically; keep the file in that
order (`Common, Host, Map, Messenger, Options, RemoteAccess, SampleApp,
Settings`) so HEMTT's `L-L01` warning stays quiet. Keys with AI translations carry
`ai-translated="true"`; see [AI translations](#ai-translations).

Rules:

- A key belongs to the container of the area that owns the text, not to the
  file where the call happens. Use `Common` only for text that two or more areas
  actually show.
- A new app adds one `<Container name="...">` to its add-on's stringtable.
  Never add a second `<Package>`: the validator only reads the first one.
- Keep keys sorted by ID inside a container so merges stay readable.

## Key naming

`STR_ACE_Tacphone_<Area>_<Component>_<Name>`. Every underscore-separated token
starts with a capital letter (UpperCamelCase with underscores, the ACE standard);
camelCase inside one token is kept:

```
STR_ACE_Tacphone_Host_AppChooser_Search
STR_ACE_Tacphone_Map_MarkerDialog_EditTitle
STR_ACE_Tacphone_Messenger_ChatView_NotConnected
```

- `Settings` keeps its existing CBA setting keys (`..._allowDebug_name`); they
  predate the web UI and are referenced from SQF, so do not rename them.
- Plurals use `_One` / `_Other`; the caller picks the key from the count.
- Interpolation uses `%1`..`%9`.
- Keys are case-insensitive at runtime (the engine and the host store them
  upper-case), but write one casing everywhere.
- Third-party apps use their own add-on prefix (`STR_<MOD>_...`) in their own
  stringtable and never `STR_ACE_Tacphone_`.

## Base-game strings

Do not add a new key when the base game already has the right text. Run:

```powershell
npx tacphone-build base-strings --download
```

The tool compares every `<English>` value with every official Arma 3 stringtable
entry and prints the candidate keys with all their translations. Reuse is worth
it: the base game ships every supported language, so a reused key needs no new
translation. Prefer general UI strings (`Cancel`, `Save`, `Players`, the chat
channel names `str_channel_*`) and check that the candidate's translations mean
the same thing; unrelated contexts can share an English word but translate
differently.

Base-game keys are **not** in this add-on's stringtable, so they are not in the
bundled default table. Each JS side keeps the list in its `i18n.ts` and preloads
it before rendering:

```ts
// ACE_TacPhone_Map/src/i18n.ts
export const MAP_BASE_GAME_STRINGS = ['str_channel_global', 'str_channel_side', ...];

// main.tsx init()
await window.TacPhone.localization.load(MAP_BASE_GAME_STRINGS);
```

The host does the same with `HOST_BASE_GAME_STRINGS` in `Backend/i18n.ts` after
`whenReady()`. The pre-connection UI (remote pairing, loading line, fatal error)
must never use a base-game key, because the game is not reachable yet: those
strings are duplicated into `stringtable.xml` and bundled.

## AI translations

Machine translation is allowed for all supported languages, but each machine
translated **language tag** must say so: add `ai-translated="true"` to that tag.
English is never marked.

```xml
<Key ID="STR_ACE_Tacphone_Map_PanelTitle">
    <English>Map</English>
    <German ai-translated="true">Karte</German>
    ...
</Key>
```

This keeps human translations distinguishable per language: if German was
rewritten by a person, only the `<German>` tag loses the attribute while the
other languages stay marked.

Supported languages (in file order): `English`, `Czech`, `French`, `Spanish`,
`Italian`, `Polish`, `Portuguese`, `Russian`, `German`, `Korean`, `Japanese`,
`Chinese` (Traditional), `Chinesesimp`, `Turkish`, `Slovak`, `Ukrainian`,
`Latin`, `Bulgarian`, `Hungarian`.

Add or refresh them with the build tool:

```powershell
tacphone-build translate --check              # report missing translations
tacphone-build translate                      # fill every missing language
tacphone-build translate --only German,French # one or more languages
tacphone-build translate --force              # re-translate everything
```

The tool caches results in `node_modules/.cache/tacphone/translation-cache.json`
and only requests keys/languages that are missing or changed. Languages it fills
get the `ai-translated` attribute automatically; do not remove the attribute
unless a human rewrites that language. The per-key AI language list is also kept
in `node_modules/.cache/tacphone/ai-translated.json`
(`{ "<Key>": ["Czech", "German", ...] }`).

**HEMTT drops unknown attributes.** `hemtt ln sort` strips
`ai-translated="true"`, so run this after any sort:

```powershell
tacphone-build mark-ai                 # re-apply the saved per-language list
tacphone-build mark-ai --check         # report missing/unexpected attributes
tacphone-build mark-ai --save          # rebuild the list from the current XML
tacphone-build mark-ai --from-translations  # bootstrap: every non-English language
tacphone-build mark-ai --clear STR_ACE_Tacphone_...  # a human rewrote this key
```

`mark-ai` writes attributes only from the saved list; it never guesses. When a
human rewrites one language of a key, clear that key and let `translate --only`
refill the remaining languages, or edit the manifest/list to keep the rest.

## Adding a string

1. Check `base-strings` first; if no base-game entry fits, add `<Key ID="...">`
   with `<English>` (first) to the right container.
   - Reuse generic base-game actions where the meaning matches, for example
     `str_disp_arcmap_clear` for **Clear** and `str_mprole_start` for **Start**;
     add them to the app's `*_BASE_GAME_STRINGS` list.
   - **Do not add a key when there is nothing to translate.** If the whole text
     is a unit, symbol, separator or placeholder pattern (`%1 km`,
     `%1 · %2 · %3`, `--`), build it as a literal in code. A stringtable key
     whose only content is `km` or dots forces translators to "translate" a
     unit and adds noise to every language. Use the base-game unit key only
     when the base game itself owns that unit string.
2. Use it from code with `t('STR_ACE_Tacphone_...')` — the literal key, never a
   template-built key.
3. Run `npm run check` (runs `tacphone-build check-strings`); a key that is used
   but undefined, or defined without English text, fails the check.
4. Run `npm run build:all` (rebuilds and installs the PBO) and restart the game.

Do not invent a key in code first: define it in the stringtable in the same
change.

## Using `t()`

```ts
// Host code imports `t` from Backend/i18n; apps from their own src/i18n.ts.
const text = t('STR_ACE_Tacphone_Map_PanelTitle');
const label = t('STR_ACE_Tacphone_Map_Channel_Number', 3);
```

- `t(key, ...args)` is synchronous, cached, and never waits on the game.
- `%1`..`%9` are replaced only when arguments are passed.
- A missing key returns the key and queues an on-demand lookup. There is no
  fallback parameter, and call sites never pass a hardcoded default.
- `has(key)`, `load(keys)`, `language()` and `onDidChange()` complete the API.
  `load()` is for an explicit demand load; the host chunks it at 100 keys per
  request.
- Never call `t()` at module scope. Convert constants that hold labels into
  functions or build them inside `init()` / render (`MAP_OPTIONS`,
  `PRESENCE_LABEL`, `TITLES`, `TTL_OPTIONS` are examples).
- Do not add another i18n library or import host internals from an app.

## What must NOT be localized

- Units and symbols: `m`, `km`, `mil`, `°`, `px`, `×`, `·`, `----`, and any
  numeric formatting. Only the words around them are translated.
- A stringtable key whose entire text is a unit, symbol or separator. Build it
  literally in code instead; units and punctuation never belong in
  `stringtable.xml`.
- Text supplied by the game or the relay: player, group and room names, marker
  type and colour names, host-log bodies, relay/server error text. Display it
  as sent.
- `console.*` output, thrown `Error` messages and internal diagnostics.
- Debug/dev UI such as the host panel inspector or the Messenger debug toolbar.
- Protocol values, CSS classes, DOM ids and test identifiers.

`aria-label`, `title`, `placeholder` and `data-tooltip` are read by users or
screen readers, so they **are** localized.

## Bundled table and fallback

The host `index.html` contains a gzip+base64 `{ language: { key: text } }`
mapping built from the **whole** stringtable by the `tacphoneStringtable` Vite
plugin (`virtual:tacphone-stringtable`). It is decoded with
`decompressFromBase64` before the first render, so the remote pairing screen, the
loading line and the fatal error screen have text even when the game is
unreachable.

- Before the game connects, the browser language selects the bundled language
  block.
- `Localization.Info` supplies the game language; after it arrives, the page
  selects that language block from the same bundled table. No XML file is read
  while `LOAD_STRINGTABLE_FILE` is `false`.
- If a key is not in the bundled table (base-game keys, or keys from an app in
  another add-on), the page asks the game for it through `Localization.Get`, at
  most 100 per request.
- The runtime XML loader and per-app stringtable loader remain in
  `Backend/Localization.ts`, disabled by `LOAD_STRINGTABLE_FILE`. When HEMTT
  ships `stringtable.xml` again, flip that constant; until then a failed file
  load must not be expected or logged.

The bundled table is not a contract: an app from another add-on must define its
own keys (they resolve through the on-demand fallback while the XML is
unavailable) or preload them as listed below.

## Apps from other add-ons

An app whose UI text lives outside `addons/tacphone/stringtable.xml` names its
stringtable in the app config:

```cpp
class MyApp {
    scope = 2;
    ace_tacphone_file = QPATHTOF(data\myapp.js);
    ace_tacphone_stringtable = "\my_mod\addons\myapp\stringtable.xml";
    ace_tacphone_requestProcessor = QFUNC(processBrowserRequest);
};
```

The path is copied into `GVAR(AppInfo)` as `stringtable`. While
`LOAD_STRINGTABLE_FILE` is `false` it is not read: the app's keys resolve through
the on-demand `Localization.Get` fallback (or the app can preload them with
`localization.load()`). When the XML file is available again, the loader reads
the path before `init()` runs. Leave it empty when the app shares the host
stringtable.

## Safety net and verification

- `tacphone-build check-strings` (part of `npm run check`) fails on web keys
  that are undefined or have no English text, and lists keys not referenced by
  web code (non-fatal; game-only keys are expected to appear there).
- `python tools/stringtable_validator.py` and `python tools/check_strings.py`
  must stay clean. `check_strings.py -u` additionally reports web-only keys as
  unused, which is expected.
- `npm run build:all`, then restart the game and check the RPT for
  `String ... not found`.

## Common mistakes

- Hardcoding a default string next to `t()`.
- Calling `t()` at module scope (runs before the table exists).
- Building a key from a variable; `check-strings` and grep stop working.
- Adding keys outside the first `<Package>` (the validator ignores them).
- Translating units, or translating game-supplied names.
- Adding a key whose whole text is a unit or separator (`%1 km`, `%1 · %2 · %3`); build it literally instead.
- Forgetting to restart the game after a stringtable edit.
