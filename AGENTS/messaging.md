# Messenger app (`MessagingApp` and the game-side `Messaging` app)

Read this when changing the Messenger web app or its game-side server. The app
contract and packaging rules are in [`apps.md`](apps.md); the game-side wire and
behaviour reference is
[`../../apps/messaging/README.md`](../../apps/messaging/README.md).
UI text uses `window.TacPhone.localization.t()` with the `Messenger` container of
the add-on stringtable; see [`localization.md`](localization.md).

## File map

| Area | Path |
| --- | --- |
| Web entry, registration, `OnMessageFromGame` | `MessagingApp/src/main.tsx` |
| Panel UI | `MessagingApp/src/MessengerApp.tsx` |
| Chat store | `MessagingApp/src/state/ChatStore.ts` |
| Room/message helpers | `MessagingApp/src/state/roomUtils.ts` |
| Request/push names and wire types | `MessagingApp/src/protocol.ts` |
| Public inter-app contract | `MessagingApp/src/api.ts` (generated `dist/ace_tacphone_messaging.d.ts`) |
| Inter-app service | `MessagingApp/src/service.ts`, `dialogBus.ts` |
| Notifications | `MessagingApp/src/notifications.ts` |
| Debug helpers | `MessagingApp/src/debug.ts` |
| Components | `MessagingApp/src/components/` |
| Game-side server | `../../apps/messaging/functions/` |
| Game-side registration | `../../apps/messaging/ace_tacphone_apps.hpp` |

## Web app

- `main.tsx` exports `apiVersion`, `GetTacPhoneApps()` (panel id `Messaging`,
  title `Messenger`) and one `OnMessageFromGame` routed through
  `window.TacPhone.utils.CommandRegistry`.
- `ChatStore` is module-scope and keeps chunked `ChatState.*` sync,
  `Room.Upsert` / `Presence.Changed` / `PlayerList.State` merging, optimistic
  sends reconciled through `clientMessageId`, failed sends, unread counts, active
  room, panel/page visibility and reconnect `Hello` + re-sync.
- Commands the page sends: `Hello`, `RequestChatState`, `GetPlayerList`,
  `SetClientPresence`, `CreateRoom`, `AddParticipants`, `RemoveParticipants`,
  `SendMessage`, `ForwardMessage`, `InviteToRoom`, `JoinRoom`.
- Pushes the game sends: `ChatState.Room`, `ChatState.Done`, `Room.Upsert`,
  `Message.New`, `Presence.Changed`, `PlayerList.State`, `Error`, and the
  debug-only `Debug.RoomInfo`.
- Room invites use the chat object kind `messaging.room_invite` with
  `{ roomId, roomName, inviteKey?, kind?, inviterName? }`.
- Chat objects are stored compressed (`MessagingApp/src/objectCodec.ts`): the
  `SendMessage` payload carries `kind`/`version`/`preview` plus a
  gzip+base64 envelope `__tacphoneObject { v: 1, codec: 'gzip', enc: 'base64', d }`
  holding `{ data, action }`. Payloads under 512 JSON characters, and payloads
  that do not shrink, stay plain; an object that already has the envelope is
  never compressed again (forwarding). `ChatStore` decodes every `Message.New`
  and `ChatState.Room` object through a FIFO push queue, caches decoded payloads
  and enforces `MAX_ENCODED_MESSAGE_CHARS` (96 KiB per message) before sending;
  a broken payload falls back to `{ kind, version, preview }`. The game stores
  the envelope opaquely and has no size or type checks.
- The `messenger` service (version `1`) implements `MessengerApi` and is
  registered from the panel lifecycle. `shareObject()` opens the target selector
  through `dialogBus.ts` and resolves on send or cancel; other apps register
  chat-object renderers through `registerObjectRenderer()`.
  `getMessages(roomId)` returns the currently loaded messages with stored chat
  objects already decoded; use it for cross-app actions and for debug
  inspection of reproducible payloads (`map.gps_route`, future position
  messages).
- Notifications: `Message.New` and invites raise `sound: "message"` banners and
  route to the room through `interApp.resolveAsync({ service: 'messenger',
  panelId: 'Messaging' })`.
- `Messaging.Debug.*` helpers exist only when `gameInfo.isDebug()` is true (an
  `__A3_DEBUG__` game build and the mission/server `allowDebug` setting). The
  debug toolbar requires those helpers.
- Layout: two panes (room list + chat) on a wide panel; below 560 px it switches
  to one pane with a back button.
- Scrollbars: `styles/theme.module.css` sets `scrollbar-color` and styles the
  WebKit scrollbar pseudo-elements. The in-game Chromium otherwise uses overlay
  scrollbars, which hide the gutter when the panel is too short for the room or
  message list. Keep the styling on `.theme` so dialogs (portaled to
  `document.body` with their own `.theme` root) inherit it too.
- Audio: `window.TacPhone.audio` synthesises the `message`, `alert` and `success`
  presets with Web Audio; there are no sound assets. The Playwright scenario
  `audio-notifications.test.mjs` plays all three (audible in a headed `--slow`
  run), checks the 400 ms per-preset cooldown and the `enumerateDevices`/
  `setSinkId("")` contract.

## Game side

`addons/tacphone/apps/messaging` is a server-authoritative backend: rooms,
messages, invites, forwarding, presence, player list, side filtering and debug
commands. The web app sends requests with `a: "Messaging"`; the server pushes
room/message/presence updates to interested clients. The game half of the
protocol, state model, persistence status and debug commands are documented in
[`../../apps/messaging/README.md`](../../apps/messaging/README.md).

## Tests

`MessagingApp/test/` has two tiers:

- **Unit, game-free:** `npm run test:unit` runs
  `MessagingApp/test/run-unit-tests.mjs`, which bundles
  `test/unit/object-codec.unit.mjs` in memory through
  `ACE_TacPhone_Main/test/lib/ts-module.mjs` and exercises the codec against a
  `node:zlib` stub of `window.TacPhone.utils`: small payloads stay plain, large
  ones become the gzip envelope, decoding restores `data`/`action`, a corrupted
  payload keeps the preview, forwarding is idempotent, and the decode cache is
  bounded. It also pins `checkEncodedObjects()` /
  `MAX_ENCODED_MESSAGE_CHARS` (the size helper `ChatStore.sendMessage()` uses to
  reject oversized objects). No game, no browser, no Arma.
- **Live, game needed:** the Node WebSocket suite needs a running
  `__A3_DEBUG__` game with the TacPhone host on port 8001 and Node trusting the
  local HTTPS certificate (`NODE_EXTRA_CA_CERTS`). It exercises rooms, messages,
  forwarding, invites, groups, group events, AI groups, leave, presence, side
  filtering, reconnect sync and map-marker sharing through fake players; see
  [`../MessagingApp/test/README.md`](../MessagingApp/test/README.md). It is not part
  of `npm run check`.

## Object renderers and activation

An app that provides a chat object kind registers a `MessengerObjectRenderer`:

```ts
interface MessengerObjectRenderer {
    kind: string;
    describe(data, storedPreview): ChatObjectPreview | undefined | Promise<...>;
    activate?(data): void | Promise<void>;
}
```

- `describe()` renders the card while the provider is mounted; the stored
  `preview` is the fallback after a reconnect or when the provider is closed.
- `activate()` owns the entire click behavior of that kind, including stale or
  deleted targets. Messenger only invokes it and reports a rejection in the card.
- The serialized `action` on the chat object is the fallback when no renderer is
  registered. Messenger routes it through `interApp.resolveAsync()` and treats a
  `false` result as "no longer available".
- Messenger source must not contain map-specific (or any other app-specific)
  routing. The provider app handles it: for `map.marker` this lives in
  `ACE_TacPhone_Map/src/MessagingBridge.ts`.

## Known limitations

- Game-side persistence in `missionProfileNamespace` is scaffolding only and
  disabled; save triggers, migration and size limits are undecided.
- Relayed game commands answer `{ ok: true, pending: true }` immediately. Flows
  that need the server result synchronously (the new `roomId` of `CreateRoom`,
  `JoinRoom` or forward-to-new-room) do not get one; the push carries the room,
  but the dialogs cannot select or report it from the response.
- `GetPlayerList` is answered by a `PlayerList.State` push; the request reply has
  no list, so the store keeps the pushed state instead of applying an empty one.
- Participant `groupColor` is empty until a future group member colour system.
- The last open room is not remembered across remounts.
- `Messaging.Debug.Reset` does not send a `Room.Remove` push, so a page keeps
  stale rooms until it re-syncs.
