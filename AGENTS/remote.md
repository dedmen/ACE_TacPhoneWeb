# Remote access (public relay)

Read this when changing the native relay WebSocket, the in-game Remote Access
panel, the in-game relay hub, pairing codes / share links, or the public server.

The production relay client is Arma's native `webRequest` WebSocket, driven from
SQF. The relay is **WebSocket only**: one outbound `wss://` from the game, no
WebRTC, no TURN, no port forwarding. Direct LAN access
(`https://<lan-ip>:8001/`) is a **debug-only** extension path. Plans for a
peer-to-peer transport live at the workspace root:
`tacphone-remote-p2p-future.md`; the native-WebSocket decision is recorded in
`plans/completed/tacphone-native-websocket-future.md`.

## Topology

```
phone browser ──https──▶ tacphone.arma3.io (static index.html)
phone browser ──wss────▶ tacphone.arma3.io/ws ──▶ RemoteServer (SQLite)
                                              ◀── wss (outbound) ── SQF webRequest
                                                                     │ opaque text
                                                                     ▼
                                                     in-game Web UI hub (RelayManager)
LAN browser ──wss──▶ debug arma_webhost_x64.dll ──WEBHOST:──▶ SQF ──▶ same hub
```

SQF is a dumb pipe: it opens/closes the socket, stores the handle in
`localNamespace`, forwards opaque transport strings in both directions, and
handles a small `RemoteAccess.*` command set. All relay protocol state, control
frames, peers, codes/shares, reconnect, request rewrite/correlation,
terrain/texture production, interest aggregation and fan-out live in the in-game
Web UI (`ACE_TacPhone_Main/src/Backend/RelayManager.ts`, owned by
`NetworkingA3`).

The game opens the outbound socket only when the in-game **Remote Access** panel
is opened. It stays connected until `Stop` or mission end. WebSocket handles are
not serializable, so the handle is null after a save/load; the next `Forward`
reports `lost`, and the hub clears the old peers and reconnects (or returns to
`idle` after `Stop`).

## Files

| Area | Files |
| --- | --- |
| SQF relay pipe | `addons/tacphone/functions/fnc_remoteAccess.sqf`, `fnc_forwardTransportMessage.sqf`, `fnc_sendCommandToPhone.sqf`, `fnc_processBrowserRequest.sqf`, `XEH_preInit.sqf`, `XEH_postInit.sqf` |
| In-game relay hub | `ACE_TacPhone_Main/src/Backend/RelayManager.ts` (owned by `Networking.ts` / `NetworkingA3`) |
| Web transport | `ACE_TacPhone_Main/src/Backend/Networking.ts` (`NetworkingWebsocket` with `direct`/`remote` modes, `remoteSession`, `OnTransportMessage`, `OnRelayEvent`) |
| Pairing gate | `ACE_TacPhone_Main/src/Panels/RemotePairingScreen.tsx` |
| In-game panel | `ACE_TacPhone_Main/src/MainApps/RemoteAccessPanel.tsx` |
| QR shared module | `packages/tacphone-build/shared-modules.js` (specifier `qrcode-generator`; the host serves it through the internal `window.TacPhone.modules` map, not `window.QRCode`) |
| Relay server | `RemoteServer/` (separate deployable, not part of the add-on) |
| Debug LAN extension | `WebServerExtension/` (source kept; `Remote/` unused). See [`webhost.md`](webhost.md). |

## Protocol (summary)

The game socket is **text only**. Binary game frames are rejected. Inbound from
game: control frames only (`auth`, `send`, `code-new`, `share-create`,
`share-revoke`, `kick`, `ping`, `pong`, `files`, …). All application data uses
the `send` op:

```json
{ "t": "send", "targets": ["p_..."], "data": "<browser payload>" }
```

A single peer is a one-element `targets` array. The server expands `"*"`,
dedupes, drops unknown peers and replies:

```json
{ "t": "send-result", "requested": 1, "delivered": 1, "unknown": [] }
```

All relay → game text is `RELAY:` + base64 of the text: control frames are
`RELAY:<base64 of {"t":"auth-ok",...}>`, browser data is
`RELAY:<base64 of <peerId>\n<payload>>`. Browser sockets stay unprefixed and
unencoded; their application payload is the existing `{k, d}` protocol. The
browser side is unchanged.

SQF never base64-encodes or JSON-parses transport payloads. `RelayManager`
strips the prefix and decodes once. The one SQF-originated path
(`sendCommandToPhone`) still uses `toJSON` + `ToBase64`.

`RemoteAccess.*` reaching SQF (`"arma_webhost"` is not involved):

| Command | Behavior |
| --- | --- |
| `Start` | Parse `remoteHost`, open the WebSocket with `origin: "arma://ACE_TacPhone"`, store the handle in `localNamespace`, return `{ok, webBase}`. No auth. |
| `Stop` | Close the handle, bump the generation, clear local state. |
| `Forward` | Send `data` exactly: `webRequest #{type:"send", connection:_handle, data:_data}`. |
| `CopyToClipboard` | Unchanged. |
| `GetAuthIdentity` | Return the opaque identity JSON from `profileNamespace` (or `""`). |
| `SetAuthIdentity` | Store the opaque identity JSON in `profileNamespace`. |

The **array form** of `callExtension` returns `[result, returnCode, errorCode]`,
not a string. For the debug LAN `SendTo`/`FileContent` calls, unwrap element 0
before comparing. The native relay path does not use the extension at all.

## Identity, codes, shares

- The hub owns the relay session. On `Start` it reads the identity with
  `RemoteAccess.GetAuthIdentity`, stores the `files` manifest the panel passes
  (the SHA-256 list from `appDirectory.getFileManifest()`), sends `auth` after
  `established`, and on `auth-ok` stores a new secret with
  `RemoteAccess.SetAuthIdentity` and sends the manifest (`{t:"files", files}`).
  The relay only uses it to learn the expected hash of a path; an empty list is
  not sent.
- First arm: the relay issues `hostId` + secret, stored as opaque JSON in
  `profileNamespace` under `ace_tacphone_remoteIdentity`.
- One-time code: 10 chars `XXXX-XXXX-XX`, 120 s, single use. URL
  `https://<host>/#p=<code>`. When the relay consumes it for an attach it sends
  `code-used`; the hub updates the panel.
- Share link: 16-char key, TTL 15 min / 1 h / 4 h / 8 h / 24 h. Exactly one
  active share per host; creating a new one deletes the old one and disconnects
  its devices. URL `https://<host>/#s=<key>`. The hub keeps the key across a
  relay reconnect so the panel can still show the URL; a fresh game process
  cannot recover an old share and must mint a new one.
- The browser stores `{hostId, deviceToken}` in `localStorage`
  (`tacphone.device.<host>`), so it reconnects without a code once the game is
  connected. Share devices expire with the share.
- Keys are in the URL **fragment**, not the query string, so they do not land in
  nginx access logs.

## Security rules

- `RemoteAccess.*` from a remote client is rejected by the hub; only the in-game
  page (`"local"`) may mint codes, create shares, or kick peers. SQF additionally
  gates `WebHost.Send` and `Client.Disconnected` to `"local"`.
- The stored live tests use `Debug.RemoteAccess`. The hub handles it in JS,
  gated by `gameInfo.debug`; it is not part of the app-facing contract.
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

`RemoteAccessPanel` starts the hub on mount, polls `Status` every second, and
offers: a one-time code + QR, share TTL + link + QR + revoke, connected devices
with their first-connected time and a kick button, and Stop. `Status`, codes,
shares and kick are answered by the hub; only `Start`, `Stop` and
`CopyToClipboard` reach SQF. Copying uses the ACE extension
(`clipboard:append` + `clipboard:complete`) because `copyToClipboard` does not
work in multiplayer.

## Front end

`Networking.ts` picks `remote` mode when the page is not `blob:`, not
`http://localhost`, and not a loopback/LAN/mDNS host. `RemotePairingScreen`
overlays the app until the session attaches and shows the Patreon supporter
note. App bundles and their dependency files are loaded with `GetFile` over the
relay, not from the static host; the relay answers repeat requests from its
[file cache](#file-cache).

## Testing

- Debug LAN: `https://<lan-ip>:8001/` must still work with no pairing UI.
- Dev: `npm run dev` + `wss://localhost:8001/ws` must still work (debug build).
- Relay: open the panel, pair a phone on cellular, then create a share link and
  open it in a second browser; revoke and confirm both drop.
- Native relay: connect/auth succeed from a release build without the DLL,
  reconnect after a forced drop returns to online with backoff, and a save/load
  leaves the handle null; the next `Forward` reports lost and the hub
  clears/reconnects (or returns to idle after `Stop`).
- Automated: `npm run test:host -- --scenario remote-access` starts the relay,
  mints a share link, connects real relay clients, verifies they reach the game
  and checks dead-peer cleanup. Relay clients go through the in-game hub; LAN
  clients still need an `__A3_DEBUG__` build.
- Restart Arma: the same `hostId` must come back from `profileNamespace`.
- Multiplayer clipboard: copy must work through ACE, not `copyToClipboard`.
- Keepalive: the relay pings every 30 s and drops idle peers after 120 s. Both
  the hub and the page answer `pong`; a paused/resumed phone must survive longer
  than two minutes without traffic.
- CORS: `OPTIONS /ws` with `Origin: arma://ACE_TacPhone` returns that origin with
  `GET, OPTIONS, UPGRADE, CONNECT`, `*` headers and max-age 600.

## Notes from the server implementation

- The server enforces `proto: 1` on the first frame, serves `index.html` for
  unknown paths (hash-routed UI), and clamps shares to `[60, 86400]` seconds.
- Share keys are stored as hashes only. The hub keeps its key across a relay
  reconnect so the in-game panel can still show the URL; a fresh game process
  cannot recover an old share and must mint a new one.
- Attach rate limiting is per IP and counts successful attaches; several
  devices behind one NAT share the 10/min budget.
- Bounded graceful closes take up to ~2 s per peer so `peer-kicked` /
  `host-offline` are not lost to a TCP reset.
- The relay caches the game's `RequestTerrainSVG` reply in memory as one pin per
  game host session plus a global payload pool keyed by the SHA-256 of the
  combined payload content. A current host streams one frame per compressed layer
  part (`ReplyRequestTerrainSVG`, indexed by `index`/`part`); the relay buffers
  them per `(peer, request key)`, combines them into one canonical
  `{width,height,layers:[{name,data}]}` entry, pins the host and re-emits the
  layer frames. Legacy whole-SVG string replies are still cached and forwarded as
  one frame. The request config is not a cache key; the pin stores its hash only to
  decide whether a request matches. A hit is answered by the relay and never
  reaches the game; the pin and buffered transfers are dropped on host disconnect
  so a reconnect re-renders its own terrain. Every lookup logs a hit or miss at
  `Information`; a miss includes the reason (cache disabled, no pin, config
  mismatch, or missing payload), never payload/config contents.
  `TacPhone:TerrainCache:*` bounds memory; `/health` reports
  `terrainCacheEntries/Bytes/Hosts/Hits/Misses` plus
  `terrainCachePending/PendingBytes`.
- The relay also keeps a **global** texture cache for `RequestTexture` replies,
  keyed by normalized `path` + `maxSize` (replace `/` with `\`, strip the leading
  `\`, lowercase). Unlike terrain there is no per-host pin and host disconnect
  does not clear it; entries survive host and browser sessions until the relay
  restarts or LRU eviction. `TacPhone:TextureCache:*` bounds entries/bytes/entry
  size; only non-empty string replies are stored. `/health` reports
  `textureCacheEntries/Bytes/Hits/Misses/Evictions/Pending`.
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
  page boot. This path exists only in debug builds now.

## File cache

The relay caches the `.js` files the game serves for apps and their runtime
dependencies, so a page reload or a second device does not pull them through the
game again. `RemoteServer/src/TacPhone.RemoteServer/Realtime/FileCache.cs` owns
the state; `FileRequest.cs` recognizes the frames.

- A browser `{"a":"main","c":"GetFile","path":"….js"}` (only `.js`, never a path
  with `..`) is answered from the cache or forwarded to the game and stored when
  the reply arrives.
- Content is pooled globally by the SHA-256 of the original text; pins are keyed
  by `(hostId, normalized path)`, and the `files` manifest supplies the expected
  hash per path. A reply whose hash differs is logged as a warning but is still
  cached.
- Plain ESM is stored Brotli (`SmallestSize`) and decompressed on a hit;
  `TACPHONE-BUNDLE:` payloads are already compressed and stored verbatim.
- Eviction drops unpinned entries first (fewest observations, then oldest
  access) and pinned entries last. Content stays resident after the host
  disconnects, and its observation count survives; only the pin and the expected
  hash go away.
- `UnpinHost` runs on host disconnect and `DropPeer` when a client detaches;
  forwarded requests still waiting for a reply are swept after
  `PendingTimeoutSeconds`.
- `TacPhone:FileCache:{Enabled,MaxTotalBytes,MaxEntries,MaxEntryBytes,
  PendingTimeoutSeconds}`, defaults `true`, 128 MiB, 512 entries, 16 MiB per
  entry, 60 s. `/health` reports `fileCacheEntries/Bytes/Hits/Misses/Evictions/
  Pending/Pinned/Sticky/Expected`; `Sticky` counts observed content that is
  currently unpinned.
- Tests: `RemoteServer/tests/TacPhone.RemoteServer.Tests/Realtime/FileCacheTests.cs`
  and `FileRequestTests.cs`.

## Known follow-ups

- Device labels come from `User-Agent`; a rename UI is a TODO.
- Terrain is chunked per layer part (each part caps at 6 MiB of base64). The
  in-game hub produces the chunks directly through `LoadGameTerrain` and sends
  each `ReplyRequestTerrainSVG` frame to the originating client; SQF only sees
  normal requests. Measure a large map and record the worst frame. Texture
  replies are single strings and are not chunked.
- No `GetFile` allowlist (decision).
- The server does not terminate TLS; run it behind nginx.
