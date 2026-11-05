# `WebServerExtension` (.NET web host, debug only)

Read this when changing the debug LAN web host, the WebSocket/HTTP protocol,
extension exports, TLS/origin handling, or the feature-flags shim. The LAN
extension is started and installed only in `__A3_DEBUG__` builds; release builds
use the native SQF relay instead (see [`remote.md`](remote.md)). The in-game
browser uses the `A3API` bridge (see [`host.md`](host.md) and
[`sqf.md`](sqf.md)).

## Build and publish

From `WebServerExtension/`:

```powershell
dotnet publish ArmaServerSide.csproj -c Release -p:Platform=x64
```

`npm run build:all` from the workspace root does this only in a debug build, when
the native sources are newer than the publish DLL, then copies it to the Arma
root. Release builds neither publish nor install the DLL. It refuses to install
while Arma is running.

Output: `bin\x64\Release\net10.0\win-x64\publish\arma_webhost_x64.dll`.

- `dotnet build` produces managed IL only; use `publish` for the NativeAOT DLL.
- Do not build `ArmaServerSide.slnx` with the dotnet CLI; the C++ vcxproj needs VS
  MSBuild. Build the csproj directly.
- Keep `featureflags.obj` linked. It comes from
  [`WebHostExtension_FeatureFlagsExport`](../WebHostExtension_FeatureFlagsExport)
  and exports `RVExtensionFeatureFlags` so the engine passes unescaped extension
  arguments. The checked-in object is compiled from that C shim.
- The published DLL is not packaged or committed.

## Files

| File | Purpose |
| --- | --- |
| `DllEntry.cs` | Native exports: `RVExtension`, `RVExtensionArgs`, `RVExtensionVersion`, callback registration, and a try/catch around every export. |
| `WebServer.cs` | Kestrel host, HTTP file endpoint, WebSocket endpoint, file cache, origin checks. |
| `Transports/` | `IClientTransport` + the LAN WebSocket adapter; the connection manager routes both LAN and relay clients (the relay path is debug-only legacy). |
| `Remote/` | Unused outbound relay client retained as source; the production relay client is the native SQF `webRequest` WebSocket. See [`remote.md`](remote.md). |
| `ArmaServerSide.csproj` | NativeAOT publish settings and native link inputs. |
| `featureflags.obj` | Checked-in C shim object; kept linked. |
| `linker.xml`, `Properties/launchSettings.json`, publish profile | Legacy/cleanup items; see `TODO.md` before relying on them. |

## Extension API (`RVExtensionArgs`)

| Method | Arguments | Result |
| --- | --- | --- |
| `StartServer` | `port` | Starts (or replaces) the server. `OK`, or `ERROR: ...` with the failure reason. |
| `SendTo` | one JSON payload `{ "targets": [...], "data": "..." }` | Sends the exact browser string to those WebSocket clients; `"*"` broadcasts. Returns `OK <delivered> <requested>` or an error. |
| `FileContent` | `fileName`, `content` | Completes a pending HTTP file request with the game's answer; `OK`. |
| `RemoteAccess` | `subcommand`, then its arguments | Legacy relay-client export from `Remote/`; unused by the native relay path. |

`SendTo` parses the payload itself: SQF never builds or splits a target list.
`data` is sent byte-for-byte as the browser payload.

## HTTP and WebSocket behaviour

- `GET /{**path}` asks the game for the file through the `GetFile` extension
  callback. The game answers through `FileContent`. The request has a 2-second
  timeout, the content type is derived from the extension, and an empty answer is
  a 404. `/` maps to the TacPhone `index.html` on the SQF side.
- `/ws` validates the `Origin` header (same `Host` authority, or loopback for
  dev), then forwards each JSON frame to the game via the `Request` callback as
  `WEBHOST:` + base64 of the framed `{s, k, d}` JSON. Connection ids are
  prefixed with `LOCAL_`. SQF forwards the string unchanged to
  `window.TacPhone.networking.OnTransportMessage`, which strips the prefix and
  base64-decodes it. The game replies with `SendTo` and one JSON payload
  `{targets, data}` containing `{k, d}`; game pushes use `{k: "command", d: {...}}`.
- On disconnect the extension calls the `Disconnect` callback with the plain
  `LOCAL_…` id; SQF clears that client's interests, fires the local
  `clientDisconnected` event and forwards `WEBHOST_DISCONNECT:<id>` to the hub.
  A peer that disappears without a close frame (killed browser/tab, dropped
  link) is a normal disconnect; the handler treats
  `WebSocketException`/`IOException` as such instead of logging an error.
- The outbound relay client (`Remote/`) is no longer used at runtime. The
  production relay is the native SQF `webRequest` WebSocket plus the in-game
  `RelayManager` hub; keep `Remote/` as unused source only.
- CORS is loopback-only. The game can serve any path the VFS exposes and the WS
  API is unauthenticated; see the security/TLS decisions in `TODO.md` before
  exposing the port beyond loopback.

## Protocol-change checklist

When changing the wire format, update all of these together:

1. [`ACE_TacPhone_Main/src/Backend/Networking.ts`](../ACE_TacPhone_Main/src/Backend/Networking.ts)
   and [`RelayManager.ts`](../ACE_TacPhone_Main/src/Backend/RelayManager.ts)
   (request IDs, `{k, d}`, `{k: "command"}`, timeouts, queueing, transport
   prefixes, LAN client set).
2. [`addons/tacphone/XEH_postInit.sqf`](../../XEH_postInit.sqf) (the
   `ExtensionCallback` handling for `GetFile`, `Request`, `Disconnect` and
   `Log`, inside `#ifdef __A3_DEBUG__`).
3. [`sqf.md`](sqf.md) and [`host.md`](host.md) if the documented flow changes.
4. This file, if exports or the HTTP/WS surface changes.

Keep the file and SQF `clientId` semantics aligned (`"local"` in-game,
`LOCAL_…` for LAN clients, `p_…` for relay peers), and keep errors visible: a
managed exception crossing a native reverse P/Invoke terminates the Arma process,
so every export must catch and return a status.

## Debugging

Startup errors are returned by `StartServer` and logged in
[`XEH_postInit.sqf`](../../XEH_postInit.sqf); the game also prints a failure to
`systemChat`. The extension has no console: every diagnostic goes through
`ExtensionLog` and the `Log` extension callback, SQF buffers it, and the in-game
page receives `Host.Log` (dev console plus a notification for warnings/errors).
`GetHostLog` replays the buffer on page boot. Check the page's dev console and
notifications, then the port (`8001`), the HTTPS certificate, and the event log
when the page cannot connect.
