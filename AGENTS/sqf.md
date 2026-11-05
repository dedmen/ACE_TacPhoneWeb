# Game side (SQF and config)

Read this only when working in the parent add-on (`addons/tacphone`): SQF,
config, app registration, the web protocol, interests, or the debug LAN bridge.
All paths below are relative to `addons/tacphone` unless stated otherwise. Web
app rules are in [`apps.md`](apps.md); the Map's handlers are in
[`map.md`](map.md); the .NET side is in [`webhost.md`](webhost.md). The add-on's
[`README.md`](../../README.md) covers display modes and the SQF API for app
authors.

## File map

| Path | Purpose |
| --- | --- |
| `config.cpp`, `script_component.hpp` | Addon config, version/patches, shared macros. |
| `XEH_preStart.sqf`, `XEH_preInit.sqf`, `XEH_postInit.sqf`, `XEH_clientInit.sqf` | Lifecycle entry points (see below). |
| `CfgEventHandlers.hpp` | Wires the XEH scripts. |
| `CfgWeapons.hpp`, `CfgUIGrids.hpp`, `gui.hpp`, `initKeybinds.inc.sqf`, `initSettings.inc.sqf` | Phone item, UI, HUD/layout, keybinds, settings. |
| `functions/fnc_dispatchRequest.sqf` | Resolves `a` and calls the app's request processor. |
| `functions/fnc_processBrowserRequest.sqf` | Built-in `main` app: `GetFile`, layout, interests, transport helpers, etc. |
| `functions/fnc_forwardTransportMessage.sqf` | Forwards one pre-encoded relay/LAN transport string to the in-game Web UI. |
| `functions/fnc_remoteAccess.sqf` | SQF relay pipe: open/close the native WebSocket, `Forward`, auth identity, clipboard. |
| `functions/fnc_sendCommandToPhone.sqf` | Game → web push; the in-game hub broadcasts it to every web client. |
| `functions/fnc_loadPhoneBackground.sqf` | Hidden background browser and the in-game request bridge. |
| `functions/fnc_openDisplay.sqf`, `fnc_loadPhoneHud.sqf`, `fnc_loadPhoneForeground.sqf`, `fnc_canShow.sqf` | Display modes and the phone UI. |
| `functions/fnc_interestSet.sqf`, `fnc_interestClearClient.sqf`, `fnc_getInterestClients.sqf` | Interest registry and targeting. |
| `apps/<App>/` | Per-app sub-addon: `config.cpp`, `ace_tacphone_apps.hpp`, XEH, `functions/fnc_processBrowserRequest.sqf`, `data/*.js`. |
| `data/index.html` | Copied host build (git-ignored); `main` serves it for `/`. |
| `XEH_PREP.hpp` | `PREP()` list; every `fnc_*.sqf` must be here. |

## Lifecycle

- `preStart` / `preInit`: compile and prepare functions, install settings, create
  `GVAR(AppInfo)` and `GVAR(AppDataInterests)`, initialise the native relay state
  (`localNamespace` handle `scriptNull`, armed flag, generation, URL, web base),
  and register the built-in `main` app (`requestprocessor` =
  `fnc_processBrowserRequest`).
- `postInit`: collect every `scope > 0` class under `ace_tacphone_apps` from
  `configFile` and `missionConfigFile`, build `GVAR(AppInfo)` entries, and open
  the hidden background browser via `loadPhoneBackground`. In `__A3_DEBUG__`
  builds only, start the LAN web host (`StartServer 8001`) and install the
  `ExtensionCallback` handler before that.
- `clientInit` (client only): initializes the closed display mode, registers the
  device key, and loads the keybinds.
- Display modes are `CLOSED`, `HUD`, `DIALOG`, and internal `HIDDEN`;
  `fnc_openDisplay` toggles/switches and `fnc_canShow` guards them. The hidden
  background browser must stay loaded even when the phone is closed, because it
  is the in-game Web UI hub for external-browser requests.

## Request flow (web → game)

In-game browser:

1. `NetworkingA3.Request` calls `window.A3API.SendAlert`; the engine raises a
   `JSDialog` on the hidden background browser control.
2. `fnc_loadPhoneBackground.sqf` parses `{k, d}`, calls
   `[d, "local", callback] call FUNC(dispatchRequest)`.
3. The callback base64-encodes the result and calls
   `A3API._response(key, base64)` in the page.

Relay and debug LAN clients:

1. The in-game `RelayManager` hub receives the transport string
   (`RELAY:`/`WEBHOST:`), decodes it, and owns all peer/session state.
2. The hub rewrites the request with a fresh A3API `k` and sends it to SQF as a
   normal `main` request through `NetworkingA3.RequestTracked`.
3. SQF sees `{k, d}` only; it never sees `__client`, `__requestKey`, `__silent`
   or any other source metadata. It dispatches exactly as for the in-game page.
4. The hub correlates the reply by the local `k` and sends it back to the
   originating relay/LAN client with the browser's original key.

`fnc_dispatchRequest` looks up `a` in `GVAR(AppInfo)`, calls the app's
`requestprocessor` with `[request, clientId, callback, callbackArgs]`, and handles
a promise return via `continueWith`. `clientId` is `"local"` for the in-game page
and for every remote request; the hub owns the remote identity. Web code
validates data; do not repeat type checks in SQF. That means no
`isEqualType`/`typeName`/`count` validation of web-supplied fields, no `params`
type annotations for them, and no fallback branch for a wrong type. Use
`getOrDefault` only for an optional field that the protocol says may be absent;
if it is present, trust it.

### Processor contract

A request processor may declare only the arguments it needs:

```sqf
params ["_request"];                            // most app processors
params ["_request", "_clientId"];               // needs the requester
params ["_request", "_clientId", "_callback", "_callbackArgs"]; // replies itself
```

The last two are optional for the processor but are now always passed by
`dispatchRequest`:

- `_callback` — the reply callback `dispatchRequest` would normally call with
  `[_result, _callbackArgs]`. In-game it base64-encodes the result into
  `A3API._response`; over the WebSocket it wraps it as `{k, d: _result}`.
- `_callbackArgs` — the opaque arguments for that callback (for WebSocket
  requests the sender id and the original `{k, d}` envelope).

A processor that answers on its own (streaming, multiple replies, replies from a
later request) returns the sentinel hashmap:

```sqf
createHashMapFromArray [["__tacphone_stream", true]]
```

`dispatchRequest` then sends no reply of its own. Without the sentinel it calls
`[_result, _callbackArgs] call _callback` exactly once, as before.

### Terrain and texture

Terrain and texture production is owned entirely by the in-game Web UI hub. A
remote `RequestTerrainSVG`/`RequestTexture` is handled in `RelayManager`, which
calls `LoadGameTerrain`/`LoadGameFileTexture` through the normal transport and
sends the reply frames itself. SQF has no terrain/texture proxy: no pending
transfer map, no `uid` counter, no `ReplyRequestTerrainSVG` /
`ReplyRequestTexture` branches, no `fnc_terrainRequestCleanup`.

Built-in `main` commands include `GetAvailableApps`, `GetGameInfo`, `GetFile`,
`GetPlayerPos`, `GetTime`, `Interest.Set`, `Interest.Clear`, `GetLayout`,
`SaveLayout`, `Client.Disconnected`, and (debug only) `WebHost.Send`.
`Debug.Status` and `Debug.SetLocalDisplayMode` are test-only SQF bridges for the
live host suite, compiled only in `__A3_DEBUG__` builds and requiring the
`Allow debug mode` setting; they are not part of the app-facing contract.
`Debug.RemoteAccess` is handled in the in-game hub (JS), gated by
`gameInfo.debug`.
`GetGameInfo` is the one-time
mission snapshot for the host (`multiplayer`, `playerId`, `missionName`,
`terrainName` via `worldName`, `gameVersion`, and a debug flag that requires both
`__A3_DEBUG__` and the `allowDebug` CBA setting).
`SaveLayout` stores the layout as an opaque, gzipped-and-base64-encoded string
in `profileNamespace` under `ace_tacphone_layout` (one layout per player
profile); `GetLayout` returns that string, or `""` when nothing was saved yet.
`SaveLayout` only rejects an oversized value (an empty layout is valid) and skips
the profile write when the layout is unchanged. It does not call
`saveProfileNamespace`; the game writes the profile on its own. `GetFile` remaps `/` or `""` to
`data\index.html`, normalises `/` to `\`, and returns `""` when the file does
not exist.

## Extension calls

The **array form** of `callExtension` returns an array, not a string:
```sqf
private _response = "arma_webhost" callExtension ["SendTo", [_payload]];
// _response is [result, returnCode, errorCode]
private _status = if (_response isEqualType []) then { _response param [0, ""] } else { _response };
```

`SendTo` takes one JSON payload `{targets, data}`; SQF never builds a target list.
The extension parses it and returns `OK <delivered> <requested>`.

- Always unwrap element 0 before `fromJSON`, `parseSimpleArray`, string comparison,
  or splitting `OK <delivered> <requested>`.
- The single-argument form (`"ext" callExtension "arg"`) still returns a string.
  Do not assume one shape at a shared call site.
- Existing examples: `fnc_processBrowserRequest.sqf` (`WebHost.Send`),
  `XEH_postInit.sqf` (`GetFile`/`FileContent`, `StartServer`).
- A `fromJSON` on the raw array fails with "Type array, expected string"; that is
  this mistake, not a bad extension response.

### Extension diagnostics

The extension has no console. `arma_webhost` sends `{level, message, time}`
through the `Log` extension callback; `XEH_postInit.sqf` buffers the last 50
entries and pushes `Host.Log` to the in-game page, which writes it to the dev
console and shows warnings/errors as notifications. `GetHostLog` (local only)
returns and clears the buffer; the host `main` app replays it from `init()`.

## Game → web push

```sqf
[createHashMapFromArray [["a", "ACE_TacPhone_Map"], ["c", "Marker.Upsert"], ...]] call FUNC(sendCommandToPhone)
```

- One argument only; there is no target list. The in-game page displays the
  message and broadcasts it to **all** relay and LAN clients. SQF returns `false`
  only when the in-game phone browser is not open.
- The message must contain `a` (target app) and `c` (command). The host delivers
  it to that app's `OnMessageFromGame`; the app routes `c` with
  `window.TacPhone.utils.CommandRegistry`.
- Interest gating still decides whether the game produces data at all, but the
  hub does not filter the resulting broadcast. Do not broadcast expensive data
  without an interest check.

## App registration

Register an app as a config class under `ace_tacphone_apps`, either in the addon
or in a mission `description.ext`:

```cpp
class ace_tacphone_apps {
    class MyApp {
        scope = 2;
        icon = "\path\to\icon.paa";              // optional default panel icon
        ace_tacphone_file = QPATHTOF(data\myapp.js);
        ace_tacphone_devFile = "src\main.tsx";   // dev entry, relative to the app folder
        ace_tacphone_stringtable = "\my_mod\addons\myapp\stringtable.xml"; // optional
        ace_tacphone_requestProcessor = QFUNC(processBrowserRequest);
    };
};
```

- The class name is the routing key (`a` in requests) and must equal the app's
  `tacphone.app` value and panel id conventions.
- `requestprocessor` is looked up in `missionNamespace`; it must be a prepared
  function (`PREP(name)` plus `functions/fnc_name.sqf`).
- Nested apps under `apps/<App>/` are their own addon (own `config.cpp`), so they
  do not need a root config entry. `apps/script_component.hpp` provides the
  shared `APPNAME`/`COMPONENT` macros.
- `ace_tacphone_file` is required for normal apps; `main` is built into the host
  and needs no file.
- `ace_tacphone_stringtable` is optional; set it when the app's text lives in a
  different add-on. It is exposed as `stringtable` in `GVAR(AppInfo)` and loaded
  before the app's `init()`. Keys and containers are documented in
  [`localization.md`](localization.md).

## Localization requests

The host bundles the whole stringtable into `index.html` at build time; HEMTT
ships only `stringtable.bin`, so the XML file is not read at runtime. SQF never
reads or parses the stringtable; it only answers these cheap `main` commands:

| Command | Fields | Result |
| --- | --- | --- |
| `Localization.Info` | — | `{ language, stringtable }`; `language` is the engine `language`, `stringtable` is `QPATHTOF(stringtable.xml)`. |
| `Localization.Get` | `keys` (array of key IDs) | `{ key: text }` for up to 100 keys, using `localize`. On-demand fallback only. |

Key ownership and naming are in [`localization.md`](localization.md). Do not add
bulk string lookups in SQF; bulk data must come from the file request.

## Interests

The web side calls `window.TacPhone.interests.acquire(name)`; SQF sees it as a
`main` command:

| Command | Fields | Effect |
| --- | --- | --- |
| `Interest.Set` | `interest`, `active` | Add/remove the client. Idempotent. |
| `Interest.Clear` | — | Remove every interest of the client (page unload). |

`GVAR(AppDataInterests)` maps interest name → `{ clients, active }`.
`fnc_interestSet` fires `ace_tacphone_interestActivated` /
`ace_tacphone_interestDeactivated` (CBA local events, payload `[interestName]`)
only on the first client joining or the last one leaving.
The hub aggregates all remote clients and only ever sends SQF `"local"`, so SQF
keeps a single entry per interest. `fnc_getInterestClients` returns the ids, but
they are only used to decide whether anybody is interested; game pushes are
broadcasts. `fnc_interestClearClient` drops all interests of a disconnected
client (used by the debug LAN `Disconnect` path).

Pattern for an app:

1. Register the two CBA handlers in `postInit`; make them idempotent.
2. On activation, add exactly the game event handlers the app needs; on
   deactivation, remove exactly those handlers. Handlers run synchronously, so
   keep them small and do no data assembly there.
3. In each data handler, early-out when `getInterestClients` returns `[]` before
   building data. Call `sendCommandToPhone` with one message; the hub broadcasts.
4. On disconnect, SQF clears the client's interests via `interestClearClient` or
   the hub's `Client.Disconnected`; no app action is needed.

## SQF rules

- `callExtension` with the array syntax returns `[result, returnCode, errorCode]`,
  not a string. Unwrap `param [0, ""]` before parsing or comparing. See
  [Extension calls](#extension-calls).
- Performance is critical. Prefer the cheapest expression that does the job and
  avoid per-call allocation/iteration, especially in event handlers and
  per-frame code.
- Avoid type checks. The web code validates data before sending it; assume the
  types are correct. Type checks are expensive and redundant here.
- Do not poll for interest state; install handlers on activation and remove them
  on deactivation.
- Keep the interest transition handlers cheap (add/remove handlers only).
- Use `getInterestClients` and early-out before assembling marker/terrain data;
  the send itself is always a broadcast.

## Common tasks

- **New request command**: add a branch to the app's
  `fnc_processBrowserRequest.sqf`, return a hashmap (or a promise), and call it
  from the app with `Request({ a, c, ... })`. For a multi-part reply that arrives
  as several later requests, use the callback/sentinel pattern described in
  [processor contract](#processor-contract).
- **Push to the page**: build `{a, c, ...}` and call `sendCommandToPhone`; the hub
  broadcasts it to the in-game page and every web client.
- **New interest**: define the name in the app's `script_component.hpp` and as a
  web constant, acquire it from the panel, register CBA transitions in
  `XEH_postInit.sqf`, and early-out through `getInterestClients`.
- **New app**: copy `apps/SampleApp` (see
  [`SampleApp/README.md`](../SampleApp/README.md)), register the class, keep
  `QFUNC`/`PREP`/file names consistent, build the web side, and copy the JS into
  `apps/<folder>/data/`.

## Build

Build the game side from the ACE3 repository root:

```powershell
hemtt build            # add --no-bin for a faster local build
```

`addon.toml` excludes `websource/**`, so web bundles must be copied into
`apps/<folder>/data/` for in-game use. Restart Arma (or reload the mission) after
changing config, app registration, or SQF. Web changes hot-reload only in the dev
server; a production phone needs the rebuilt host `data/index.html`.
