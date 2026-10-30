# Remote access (public relay)

Read this when changing the outbound relay client, the in-game Remote Access
panel, pairing codes / share links, or the public server.

The relay is **WebSocket only**: one outbound `wss://` from the game, no WebRTC,
no TURN, no port forwarding. Direct LAN access (`https://<lan-ip>:8001/`) is
unchanged. Plans for a peer-to-peer transport and for moving the client into SQF
live at the workspace root: `tacphone-remote-p2p-future.md` and
`tacphone-native-websocket-future.md`.

## Topology

```
phone browser ──https──▶ tacphone.arma3.io (static index.html)
phone browser ──wss────▶ tacphone.arma3.io/ws ──▶ RemoteServer (SQLite)
                                              ◀── wss (outbound) ── arma_webhost_x64.dll
```

The game opens the outbound socket only when the in-game **Remote Access** panel
is opened. It stays connected until `Stop` or mission end.

## Files

| Area | Files |
| --- | --- |
| Extension relay client | `WebServerExtension/Remote/RelayConnection.cs`, `RelayProtocol.cs`, `RelayPeerTransport.cs`, `RemoteAccessService.cs` |
| Extension transport abstraction | `WebServerExtension/Transports/IClientTransport.cs`, `WebSocketTransport.cs` |
| Extension wiring | `WebServerExtension/WebServer.cs` (manager holds transports), `DllEntry.cs` (`RemoteAccess` export) |
| Relay server | `RemoteServer/` (separate deployable, not part of the add-on) |
| Web transport | `ACE_TacPhone_Main/src/Backend/Networking.ts` (`NetworkingWebsocket` with `direct`/`remote` modes, `remoteSession`) |
| Pairing gate | `ACE_TacPhone_Main/src/Panels/RemotePairingScreen.tsx` |
| In-game panel | `ACE_TacPhone_Main/src/MainApps/RemoteAccessPanel.tsx` |
| QR shared module | `packages/tacphone-build/shared-modules.js` (`qrcode-generator` → `window.QRCode`) |
| SQF | `addons/tacphone/initSettings.inc.sqf`, `functions/fnc_remoteAccess.sqf`, `fnc_processBrowserRequest.sqf`, `XEH_postInit.sqf` |

## Protocol (summary)

Control frames are text JSON with `t`. Application frames are binary
`0x01 | peerIdLen | peerId | app JSON` on the game link and raw app JSON on the
relay plugin/browser link. The server also accepts text `<peerId>\n<app JSON>`
for the future SQF client.

The application payload is the existing `{k, d}` protocol. The extension injects
`"s" = peerId` exactly like the LAN path, so SQF and apps are unchanged.

`RemoteAccess` export (`"arma_webhost" callExtension ["RemoteAccess", [sub, ...]]`):
`Start(host, identityJson)`, `Stop`, `Status`, `NewCode`, `ShareCreate(ttl)`,
`ShareRevoke`, `Kick(peerId)`. All return JSON and never block the game thread.

The **array form** of `callExtension` returns `[result, returnCode, errorCode]`,
not a string. `fnc_remoteAccess.sqf` unwraps element 0 before `fromJSON`; do the
same for any new extension call.

## Identity, codes, shares

- First arm: the relay issues `hostId` + secret. The extension reports it through
  the `RemoteIdentity` extension callback; SQF stores the JSON in
  `profileNamespace` under `ace_tacphone_remoteIdentity`.
- One-time code: 10 chars `XXXX-XXXX-XX`, 120 s, single use. URL
  `https://<host>/#p=<code>`. When the relay consumes it for an attach it sends
  `code-used` to the game so the in-game panel stops showing a dead code.
- Share link: 16-char key, TTL 15 min / 1 h / 4 h / 8 h / 24 h. Exactly one
  active share per host; creating a new one deletes the old one and disconnects
  its devices. URL `https://<host>/#s=<key>`.
- The browser stores `{hostId, deviceToken}` in `localStorage`
  (`tacphone.device.<host>`), so it reconnects without a code once the game is
  connected. Share devices expire with the share.
- Keys are in the URL **fragment**, not the query string, so they do not land in
  nginx access logs.

## Security rules

- `RemoteAccess.*` is accepted **only** from `_clientId == "local"`; a relay
  client must never mint codes, create shares, or kick peers.
- The share key/code is a bearer capability for the whole phone. Only render it
  in the panel; no HUD/startup toasts.
- Relay traffic is plaintext at the server (TLS ends in nginx).
- There is deliberately **no `GetFile` allowlist**: only packed game/mod files
  are readable, and those are public.

## Settings

- `ace_tacphone_remoteEnabled` (default true) — feature switch, does not connect
  on its own.
- `ace_tacphone_remoteHost` (default `tacphone.arma3.io`) — relay host; accepts a
  bare host, `https://host`, or `wss://host/ws`.

## In-game panel

`RemoteAccessPanel` arms on mount, polls `Status` every second, and offers: a
one-time code + QR, share TTL + link + QR + revoke, connected devices with their
first-connected time and a kick button, and Stop. Copying uses the ACE extension
(`clipboard:append` + `clipboard:complete`) because `copyToClipboard` does not
work in multiplayer.

## Front end

`Networking.ts` picks `remote` mode when the page is not `blob:`, not
`http://localhost`, and not a loopback/LAN/mDNS host. `RemotePairingScreen`
overlays the app until the session attaches and shows the Patreon supporter
note. App bundles are loaded with `GetFile` over the relay, not from the static
host.

## Testing

- LAN: `https://<lan-ip>:8001/` must still work with no pairing UI.
- Dev: `npm run dev` + `wss://localhost:8001/ws` must still work.
- Relay: open the panel, pair a phone on cellular, then create a share link and
  open it in a second browser; revoke and confirm both drop.
- Restart Arma: the same `hostId` must come back from `profileNamespace`.
- Multiplayer clipboard: copy must work through ACE, not `copyToClipboard`.
- Keepalive: the relay pings every 30 s and drops idle peers after 120 s. Both
  the extension and the page answer `pong`; a paused/resumed phone must survive
  longer than two minutes without traffic.

## Notes from the server implementation

- The server enforces `proto: 1` on the first frame, serves `index.html` for
  unknown paths (hash-routed UI), and clamps shares to `[60, 86400]` seconds.
- Share keys are stored as hashes only. The extension keeps its key across a
  relay reconnect so the in-game panel can still show the URL; a fresh game
  process cannot recover an old share and must mint a new one.
- Attach rate limiting is per IP and counts successful attaches; several
  devices behind one NAT share the 10/min budget.
- Bounded graceful closes take up to ~2 s per peer so `peer-kicked` /
  `host-offline` are not lost to a TCP reset.
- The relay caches the game's `RequestTerrainSVG` reply (gzip+base64 string) in
  memory as one pin per game host session plus a global payload pool keyed by the
  SHA-256 of the payload content. The request config is not a cache key; the pin
  stores its hash only to decide whether a request matches. A hit is answered by
  the relay and never reaches the game; the pin is dropped on host disconnect so
  a reconnect re-renders its own terrain. `TacPhone:TerrainCache:*` bounds memory;
  `/health` reports `terrainCacheEntries/Bytes/Hosts/Hits/Misses`.
- The relay writes a rolling log file as well as console/journald:
  `TacPhone:LogFile` (default `logs/tacphone-remote.log`), 10 MiB per file,
  5 rotated files, configurable level. Fatal startup failures are written as
  `[Critical]` before exit. On systemd, point it at
  `/var/lib/tacphone-remote/logs/...` because `/opt` is read-only under
  `ProtectSystem=strict`.
- The hosted `wwwroot/index.html` is precompressed at startup: SHA-256 of the
  source is compared with `index.html.sha256` in `TacPhone:CompressedStaticPath`
  (default `compressed-static` next to the SQLite DB, the only writable path in
  production), and Brotli/gzip variants are rebuilt only when the hash changed or
  a variant is missing. Variants are kept in memory (a read-only cache only logs
  one warning) and served for `/` and `/index.html` with `Content-Encoding`,
  `Vary: Accept-Encoding`, `Content-Length` and `no-store`, honouring
  `Accept-Encoding` q-values; anything else falls back to the static files.
  Replacing `index.html` therefore regenerates on the next restart, with no
  manual `gzip` step and no nginx `gzip_static`.
- Extension diagnostics (server errors, relay failures, connection lifecycle)
  never go to a console. `ExtensionLog` sends them through the `Log` extension
  callback; SQF buffers them and the in-game page writes them to its dev console
  and shows warnings/errors as notifications. `GetHostLog` replays the buffer on
  page boot.

## Known follow-ups

- Device labels come from `User-Agent`; a rename UI is a TODO.
- No chunking: very large messages (terrain SVG) rely on the relay/server frame
  cap. The future SQF client caps at 10 MB; split the SVG on the sending side if
  needed.
- No `GetFile` allowlist (decision).
- The server does not terminate TLS; run it behind nginx.
