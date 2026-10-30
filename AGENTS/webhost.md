# `WebServerExtension` (.NET web host)

Read this when changing the external-browser web host, the WebSocket/HTTP
protocol, extension exports, TLS/origin handling, or the feature-flags shim.
This host is for external-browser development and play; the in-game browser uses
the `A3API` bridge instead (see [`host.md`](host.md) and [`sqf.md`](sqf.md)).

## Build and publish

From `WebServerExtension/`:

```powershell
dotnet publish ArmaServerSide.csproj -c Release -p:Platform=x64
```

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
| `Transports/` | `IClientTransport` + the LAN WebSocket adapter; the connection manager routes both LAN and relay clients. |
| `Remote/` | Outbound relay client, peer bookkeeping, codes, share links. See [`remote.md`](remote.md). |
| `ArmaServerSide.csproj` | NativeAOT publish settings and native link inputs. |
| `featureflags.obj` | Checked-in C shim object; kept linked. |
| `linker.xml`, `Properties/launchSettings.json`, publish profile | Legacy/cleanup items; see `TODO.md` before relying on them. |

## Extension API (`RVExtensionArgs`)

| Method | Arguments | Result |
| --- | --- | --- |
| `StartServer` | `port` | Starts (or replaces) the server. `OK`, or `ERROR: ...` with the failure reason. |
| `SendTo` | one or more targets, then the JSON content as the last argument | Sends to those WebSocket clients; `"*"` broadcasts. Returns `OK <delivered> <requested>` or an error. |
| `FileContent` | `fileName`, `content` | Completes a pending HTTP file request with the game's answer; `OK`. |
| `RemoteAccess` | `subcommand`, then its arguments (`Start` takes host + identity JSON) | Arms/stops the outbound relay, returns status/codes/shares as JSON. See [`remote.md`](remote.md). |

`SendTo` never expands `"*"` in SQF; the extension does. Every target is passed
as a separate extension argument with the JSON last, because the JSON can contain
commas and must stay one argument.

## HTTP and WebSocket behaviour

- `GET /{**path}` asks the game for the file through the `GetFile` extension
  callback. The game answers through `FileContent`. The request has a 2-second
  timeout, the content type is derived from the extension, and an empty answer is
  a 404. `/` maps to the TacPhone `index.html` on the SQF side.
- `/ws` validates the `Origin` header (same `Host` authority, or loopback for
  dev), then forwards each JSON frame to the game via the `Request` callback with
  the sender connection id injected as `s`. The game replies with `SendTo` and
  `{k, d}`; game pushes use `{k: "command", d: {...}}`.
- On disconnect the extension calls the `Disconnect` callback so the game can
  drop that client's data interests.
- The relay client (`Remote/`) is a single outbound `wss://` opened on demand by
  `RemoteAccess.Start`. Relay peers get server-generated ids and share the same
  `SendTo` / `Disconnect` semantics as LAN sockets. When the relay assigns a new
  host identity, the extension calls the `RemoteIdentity` callback; SQF persists
  it in `profileNamespace`.
- CORS is loopback-only. The game can serve any path the VFS exposes and the WS
  API is unauthenticated; see the security/TLS decisions in `TODO.md` before
  exposing the port beyond loopback.

## Protocol-change checklist

When changing the wire format, update all of these together:

1. [`ACE_TacPhone_Main/src/Backend/Networking.ts`](../ACE_TacPhone_Main/src/Backend/Networking.ts)
   (request IDs, `{k, d}`, `{k: "command"}`, timeouts, queueing).
2. [`addons/tacphone/XEH_postInit.sqf`](../../XEH_postInit.sqf) (the
   `ExtensionCallback` handling for `GetFile`, `Request`, and `Disconnect`).
3. [`sqf.md`](sqf.md) and [`host.md`](host.md) if the documented flow changes.
4. This file, if exports or the HTTP/WS surface changes.

Keep the file and SQF `clientId` semantics aligned (`"local"` in-game, the
WebSocket connection id remotely), and keep errors visible: a managed exception
crossing a native reverse P/Invoke terminates the Arma process, so every export
must catch and return a status.

## Debugging

Startup errors are returned by `StartServer` and logged in
[`XEH_postInit.sqf`](../../XEH_postInit.sqf); the game also prints a failure to
`systemChat`. The extension has no console: every diagnostic goes through
`ExtensionLog` and the `Log` extension callback, SQF buffers it, and the in-game
page receives `Host.Log` (dev console plus a notification for warnings/errors).
`GetHostLog` replays the buffer on page boot. Check the page's dev console and
notifications, then the port (`8001`), the HTTPS certificate, and the event log
when the page cannot connect.
