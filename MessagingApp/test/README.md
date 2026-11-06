# Messenger live test suite

Reusable Node tests for the TacPhone Messenger app. The suite talks to the
running game over the same WebSocket protocol as the page: requests are
`{ k, d: { a: "Messaging", c: "...", ... } }`, replies reuse `k`, and game
pushes arrive as `{ k: "command", d: { a: "Messaging", c: "...", ... } }`.

The files are intentionally committed: run them again after game-side, store or
UI changes without editing the tests. There are no npm dependencies and no test
framework; only Node built-ins.

## Prerequisites

Unit tier: **none**. `npm run test:unit` needs only Node (20.19+/22.12+) and the
workspace `vite` devDependency; it does not need Arma, the web host or a browser.

Live tier:

- **Arma 3 is running** a mission with the TacPhone add-on loaded, on the machine
  that owns the player and the TacPhone page (single player or a listen server).
  The WebSocket host, local display mode and `local` page client are per machine.
- **The web host is listening on port 8001** (`wss://localhost:8001/ws`).
- **The game was built with `__A3_DEBUG__`.** The suite calls
  `Messaging.Debug.Status` first and stops with a clear message if debug support
  was not compiled in. Release builds deliberately do not contain the
  `Messaging.Debug.*` commands.
- **The local HTTPS certificate is handled automatically.** The shared runner
  exports the certificate the web host presents to
  `%LOCALAPPDATA%\TacPhone\localhost-test-ca.pem`, installs it for the Node
  process and prints the path. It never disables certificate verification. For
  a manual Node run, set `NODE_EXTRA_CA_CERTS` to the printed path.

- **A current Node release.** Node 20.19+/22.12+ exposes the global `WebSocket`.
  The TacPhone web host requires an `Origin` header on the WebSocket handshake;
  the suite passes it through Node's `{ headers }` WebSocket init object, which
  current Node supports. If your Node release rejects that option, update Node
  rather than disabling TLS or the host's origin check.
- The local player should have a normal side (WEST/EAST). Several scenarios need
  at least one fake player on that side; they stop with an explicit error
  otherwise.

## Run

From `websource`:

```powershell
node MessagingApp/test/run-tests.mjs
npm run test:messaging

# game-free codec unit tests (no game)
npm run test:unit
node MessagingApp/test/run-unit-tests.mjs --only object-codec --verbose
```

`npm run test:all` runs the host, Messenger and Map suites sequentially and
prints one summary; `-- --suite messaging` narrows it to this suite.

Useful options:

```powershell
node MessagingApp/test/run-tests.mjs --list
node MessagingApp/test/run-tests.mjs --scenario messages
node MessagingApp/test/run-tests.mjs --scenario rooms,messages --verbose
node MessagingApp/test/run-tests.mjs --url wss://localhost:8001/ws --timeout 10000
```

Each scenario prints `PASS`/`FAIL`, failures include the expected and actual
values, and the process exits non-zero if any scenario fails. Scenarios run
sequentially on one connection (except where a check explicitly opens a second
connection or reconnects).

## Layout

```text
test/
├── run-tests.mjs                  # CLI, opens the connection, runs scenarios
├── run-browser-tests.mjs          # Playwright Messenger UI suite
├── run-unit-tests.mjs             # game-free codec unit runner (Vite loader)
├── lib/
│   └── fake-players.mjs           # Messaging.Debug.* helpers and fake fixtures
├── unit/
│   └── object-codec.unit.mjs      # gzip envelope, size helper, cache (node:zlib stub)
├── scenarios/
│   ├── connection.test.mjs        # Hello identity, RequestChatState -> Done
│   ├── rooms.test.mjs             # roster, group room, direct room
│   ├── messages.test.mjs          # send + clientMessageId echo + sync
│   ├── forwarding.test.mjs        # forward metadata and original body
│   ├── invites.test.mjs           # invite object, invalid key, JoinRoom
│   ├── groups.test.mjs            # groupInvited leader flag, AI excluded
│   ├── leave.test.mjs             # self-leave, direct leave, group-invite lock
│   ├── presence.test.mjs          # local modes, external page, fake presence
│   ├── side-filtering.test.mjs    # players follow enemy chat, groups do not
│   ├── reconnect-sync.test.mjs    # close/reopen + full history resync
│   ├── persistence-scaffold.test.mjs # explicit save/load only, no auto-save
│   ├── map-marker.test.mjs        # map.marker object round-trip (protocol only)
│   ├── browser-ui.test.mjs        # Playwright: rooms, messages, marker share + focus
│   ├── layout-scrollbars.test.mjs # Playwright: visible short-panel scrollbars
│   └── audio-notifications.test.mjs # Playwright: synthesised notification presets
└── browser/
    └── ui-checklist.md            # manual browser checks with the game running
```

## Unit tier (game-free)

`run-unit-tests.mjs` loads `unit/object-codec.unit.mjs` with
`ACE_TacPhone_Main/test/lib/ts-module.mjs`, which bundles the real
`src/objectCodec.ts` in memory with Vite and imports it from a `data:` URL. No
game, browser or build output is involved, and a missing `vite` is a `SKIP`.

The module stubs `globalThis.window.TacPhone.utils.compressAndToBase64` /
`decompressFromBase64` with `node:zlib` inside `run()` and deletes the stub in
`finally`. It pins:

- a small payload stays the same object reference (no envelope),
- a large payload becomes `__tacphoneObject { v: 1, codec: 'gzip', enc: 'base64', d }`
  with `kind`, `version` and `preview` unchanged and `data`/`action` removed,
- decoding restores `data` and `action`, a corrupted payload keeps the preview
  and warns exactly once, forwarding an already-encoded object is a no-op,
- the bounded decode cache (hit, `resetObjectDecodeCache()`, 100-entry limit),
- `checkEncodedObjects()` / `MAX_ENCODED_MESSAGE_CHARS`: an oversized object is
  rejected, a normal route is accepted. That is the helper
  `ChatStore.sendMessage()` uses instead of its old inline comparison.

## How the helpers work

`ACE_TacPhone_Main/test/lib/ws-client.mjs` (shared harness):

- `new WsClient(url, { app: 'Messaging' })` / `openClient(url, { app: 'Messaging' })`
  connect to `wss://localhost:8001/ws` by default and send the same loopback
  `Origin` a browser would send. The client defaults to `a: "main"`, so the
  Messenger suite always passes its app name.
- `request(command, payload)` sends one request and waits for the reply with the
  matching key, with a clear timeout error.
- `waitForPush(command, predicate, timeout)` / `waitForCommand(...)` consume the
  next matching game push. `collectChatState(client)` gathers all
  `ChatState.Room` chunks until `ChatState.Done`.
- `reconnect()` closes and reopens the same client and clears stale pushes.
- `clearPushes(commands)` and `pendingPushCount` manage the push queue.

`lib/fake-players.mjs`:

- `new FakePlayers(client)` calls `Messaging.Debug.Status` before every debug
  scenario. `addFakePlayers()`, `reset()`, `injectMessage()`,
  `setAllowEnemyChat()`, `setPresence()`, `saveState()` and `loadState()` wrap
  the SQF commands. `setLocalDisplayMode()` calls the Main app's
  `Debug.SetLocalDisplayMode`.
- Fake fixtures match `fnc_debugAddFakePlayers.sqf`: `fake_1` … `fake_8`,
  `fake_grp_1` (WEST), `fake_grp_2` (WEST), `fake_grp_3` (EAST), with their
  deterministic names, colours and presence.
- `createGroupRoom`, `createDirectRoom`, `sendMessage`, `forwardMessage` and
  `sync` wait for the relevant push, because relayed requests do not return the
  server result (see below). `setLocalDisplayMode()` calls the Main app's
  `Debug.SetLocalDisplayMode` command, because display mode belongs to the host.

`ACE_TacPhone_Main/test/lib/assertions.mjs` provides `assert`/`ok`/`equal`/
`deepEqual`/`includes`/`isString`/`isNumber`/`isBoolean`/`oneOf`, readable
`expected`/`actual` output, and `runSuite()`.

## Adding a scenario

1. Create `scenarios/<name>.test.mjs`.
2. Export `name`, an optional `description`, and
   `async run({ client, fake, self, openClient, collectChatState })`.
3. Start with `await fake.reset()` and `await fake.addFakePlayers()` unless the
   check is specifically about existing state.
4. Create rooms with `uniqueRoomName(...)` so `Room.Upsert` can be selected
   without relying on timing.
5. Prefer pushes (`fake.sync()`, `waitForPush`) over request replies; see the
   protocol notes below.
6. Restore global debug state (`setAllowEnemyChat(false)`) in `finally` when the
   scenario changes it.
7. Add the module to the `ALL_SCENARIOS` list in `run-tests.mjs`.

Scenarios must not edit app or SQF source. They may use only the public debug
commands and the wire protocol.

## Protocol notes and known mismatches found while writing the suite

Remote Access / relay share-link coverage lives in the host suite at
`ACE_TacPhone_Main/test/scenarios/remote-access.test.mjs`; it is not a Messenger
protocol concern.

- **Relayed commands answer `{ ok: true, pending: true }` immediately.** Only
  `Hello`, `SetClientPresence` and `Messaging.Debug.Status` are handled locally.
  `GetPlayerList`,
  `CreateRoom`, `SendMessage`, `JoinRoom`, etc. return `pending` and deliver
  their real result through pushes (`PlayerList.State`, `Room.Upsert`,
  `Message.New`, `ChatState.*`, `Error`). The tests therefore assert on pushes,
  not request replies.
- **The remaining Messaging debug commands are relayed.** Their server-side
  `{ ok, ... }` result is not sent back to the page either; the helpers observe
  the resulting push instead.
- **`SendMessage` does not return `messageId` in the request reply.** It arrives
  in the `Message.New` echo keyed by `clientMessageId`.
- **The WebSocket host rejects handshakes without an allowed `Origin`.** Node's
  built-in WebSocket does not send one by default, so the suite passes
  `Origin: https://localhost:8001` through the WebSocket init object. This is
  why the suite needs a current Node and why `rejectUnauthorized: false` is
  never used.
- **`JoinRoom` with a wrong key is only reachable for non-members.** With one
  real player the suite removes itself from a group room first
  (`RemoveParticipants` allows this), then checks the invalid-key error and the
  successful join.
- **The local player cannot become `offline` while the in-game phone client is
  registered.** Presence tests cover HUD/DIALOG → Available, CLOSED/HIDDEN →
  Minimized, external visible/hidden, and fake-player `available`/`offline` via
  `SetPresence`. The plan's "all clients disconnected → Offline" is only
  feasible for a player without any phone client.
- **Persistence has no protocol status field.** `GVAR(serverPersistenceEnabled)`
  is not exposed. The scenario verifies the observable contract instead:
  `Debug.SaveState` + `Debug.Reset` does not auto-restore, and only an explicit
  `Debug.LoadState` brings rooms back. The test leaves an empty saved state in
  `missionProfileNamespace` at the end.
- **`Debug.Reset` pushes `Room.Upsert` with `removed: true`.** The server
  broadcasts it to every participant before clearing the database, so the page
  is told that its rooms disappeared.
- **Map UI behavior is not protocol-testable.** `map-marker.test.mjs` checks the
  object shape and `data.position` round-trip only. Live `focusMarker`, deleted
  markers, `flyTo` and the host target chooser are in
  `browser/ui-checklist.md`.

## Live UI checks

`run-browser-tests.mjs` is the automated Playwright suite:

```powershell
npm run test:messaging-ui
npm run test:messaging-ui -- --slow
```

It opens Map and Messenger in two flexlayout tabsets, adds fake players, creates
a room, sends a message, shares a marker through the Map context menu, then
clicks the marker card and verifies that the Map focuses the marker, fits the
800 m focus box and shows the temporary highlight. It needs a debug game and the
host dev page; see `browser-ui.test.mjs`.

`layout-scrollbars.test.mjs` is independent of the Map and terrain. It creates a
fake room, injects enough messages to overflow a 480x300 panel and asserts that
the message list has a visible scrollbar color, a reserved gutter in a headed
browser, and still scrolls with the wheel.

`audio-notifications.test.mjs` instruments Web Audio and plays the `message`,
`alert` and `success` presets. In a headed run (`--slow`) the three synthesised
sounds are audible on the default output device; headless Chromium is muted by
Playwright but still checks the scheduled tones, the per-preset cooldown, device
enumeration and the `setSinkId("")` error path.

`browser/ui-checklist.md` contains the manual browser checks: notifications and
sound, presence transitions, dialog search, floating dialogs from a small panel,
forward/invite flows, marker sharing, deleted-marker fallback (now owned by the
Map app), two Map panels with the host `TargetChooserDialog`, and the release
build's absent debug UI.
