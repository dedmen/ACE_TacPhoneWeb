# Game side (SQF and config)

Read this only when working in the parent add-on (`addons/tacphone`): SQF,
config, app registration, the web protocol, interests, or the extension bridge.
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
| `functions/fnc_processBrowserRequest.sqf` | Built-in `main` app: `GetFile`, layout, interests, proxy, etc. |
| `functions/fnc_sendCommandToPhone.sqf` | Game → web push, with target routing. |
| `functions/fnc_loadPhoneBackground.sqf` | Hidden background browser and the in-game request bridge. |
| `functions/fnc_openDisplay.sqf`, `fnc_loadPhoneHud.sqf`, `fnc_loadPhoneForeground.sqf`, `fnc_canShow.sqf` | Display modes and the phone UI. |
| `functions/fnc_interestSet.sqf`, `fnc_interestClearClient.sqf`, `fnc_getInterestClients.sqf` | Interest registry and targeting. |
| `apps/<App>/` | Per-app sub-addon: `config.cpp`, `ace_tacphone_apps.hpp`, XEH, `functions/fnc_processBrowserRequest.sqf`, `data/*.js`. |
| `data/index.html` | Copied host build (git-ignored); `main` serves it for `/`. |
| `XEH_PREP.hpp` | `PREP()` list; every `fnc_*.sqf` must be here. |

## Lifecycle

- `preStart` / `preInit`: compile and prepare functions, install settings, create
  `GVAR(AppInfo)` and `GVAR(AppDataInterests)`, and register the built-in `main`
  app (`requestprocessor` = `fnc_processBrowserRequest`).
- `postInit`: collect every `scope > 0` class under `ace_tacphone_apps` from
  `configFile` and `missionConfigFile`, build `GVAR(AppInfo)` entries, start the
  web host extension (`StartServer 8001`), install the extension callback, and
  open the hidden background browser via `loadPhoneBackground`.
- `clientInit` (client only): initializes the closed display mode, registers the
  device key, and loads the keybinds.
- Display modes are `CLOSED`, `HUD`, `DIALOG`, and internal `HIDDEN`;
  `fnc_openDisplay` toggles/switches and `fnc_canShow` guards them. The hidden
  background browser must stay loaded even when the phone is closed, because it
  serves external-browser file/terrain/texture requests.

## Request flow (web → game)

In-game browser:

1. `NetworkingA3.Request` calls `window.A3API.SendAlert`; the engine raises a
   `JSDialog` on the hidden background browser control.
2. `fnc_loadPhoneBackground.sqf` parses `{k, d}`, calls
   `[d, "local", callback] call FUNC(dispatchRequest)`.
3. The callback base64-encodes the result and calls
   `A3API._response(key, base64)` in the page.

External browser (WebSocket):

1. The extension receives `{k, d, s}` and raises the `Request` extension callback;
   `XEH_postInit.sqf` calls `[d, s, callback] call FUNC(dispatchRequest)`.
2. The callback wraps the result as `{k, d: result}` and calls the extension
   `SendTo` for that client id.

`fnc_dispatchRequest` looks up `a` in `GVAR(AppInfo)`, calls the app's
`requestprocessor` with `[request, clientId]`, and handles a promise return via
`continueWith`. `clientId` is `"local"` in-game and the WebSocket connection id
remotely. Web code validates data; do not repeat type checks in SQF.

Built-in `main` commands include `GetAvailableApps`, `GetFile`, `GetPlayerPos`,
`GetTime`, `Interest.Set`, `Interest.Clear`, `GetLayout`, `SaveLayout`, and the
terrain/texture proxies. `RequestTexture` checks `fileExists` first and
returns `{ok: false}` instead of forwarding when the texture is missing, since
the engine would otherwise open an error popup. `GetFile` remaps `/` or `""` to
`data\index.html`, normalises `/` to `\`, and returns `""` when the file does
not exist.

## Game → web push

```sqf
[_targets, createHashMapFromArray [["a", "ACE_TacPhone_Map"], ["c", "Marker.Upsert"], ...]] call FUNC(sendCommandToPhone)
```

- Targets: `"local"` (in-game page), a WebSocket connection id, `"*"` (local plus
  one broadcast to all remote clients), or an array mixing them. Empty/duplicate
  entries are dropped; `"*"` is never expanded in SQF.
- The message must contain `a` (target app) and `c` (command). The host delivers
  it to that app's `OnMessageFromGame`; the app routes `c` with
  `window.TacPhone.utils.CommandRegistry`.
- Do not broadcast expensive data. Prefer interest-targeted sends (below).

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
`fnc_getInterestClients` returns the client ids, including `"local"`; pass the
result straight to `sendCommandToPhone`. `fnc_interestClearClient` drops all
interests of a disconnected WebSocket client.

Pattern for an app:

1. Register the two CBA handlers in `postInit`; make them idempotent.
2. On activation, add exactly the game event handlers the app needs; on
   deactivation, remove exactly those handlers. Handlers run synchronously, so
   keep them small and do no data assembly there.
3. In each data handler, get the target clients first and early-out on `[]`
   before building data. Send only to those clients.
4. On disconnect, the extension callback clears the client's interests; no app
   action is needed.

## SQF rules

- Performance is critical. Prefer the cheapest expression that does the job and
  avoid per-call allocation/iteration, especially in event handlers and
  per-frame code.
- Avoid type checks. The web code validates data before sending it; assume the
  types are correct. Type checks are expensive and redundant here.
- Do not poll for interest state; install handlers on activation and remove them
  on deactivation.
- Keep the interest transition handlers cheap (add/remove handlers only).
- Use `getInterestClients` and early-out before assembling marker/terrain data.

## Common tasks

- **New request command**: add a branch to the app's
  `fnc_processBrowserRequest.sqf`, return a hashmap (or a promise), and call it
  from the app with `Request({ a, c, ... })`.
- **Push to the page**: build `{a, c, ...}` and call `sendCommandToPhone` with the
  narrowest target list.
- **New interest**: define the name in the app's `script_component.hpp` and as a
  web constant, acquire it from the panel, register CBA transitions in
  `XEH_postInit.sqf`, and push through `getInterestClients`.
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
