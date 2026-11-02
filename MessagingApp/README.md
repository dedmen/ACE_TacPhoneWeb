# Messenger app

Messaging/chat app for TacPhone: direct and group rooms, invites, member
management, forwarding, presence, unread badges and shared objects such as map
markers. The web half lives here; the game half is the server-authoritative
`Messaging` app in `addons/tacphone/apps/messaging`.

## Features

- Direct and group rooms with a searchable room list, last-message preview and
  unread counts.
- Create rooms, add/remove participants (players or whole groups), leave rooms.
- Invites with Join cards and group membership system messages.
- Message forwarding, including forwarding into a new room.
- Presence (`available`, `minimized`, `offline`) and side filtering.
- Optional debug toolbar in `__A3_DEBUG__` builds with `allowDebug` enabled.
- Chat objects: messages can carry shared cards from other apps. The Map app
  uses this to share markers, with a click action that focuses the marker on the
  Map. Object payloads are gzip+base64 encoded for storage
  (`src/objectCodec.ts`); the game never inspects them and Messenger decodes
  them again before rendering, so providers always hand over a plain
  `ChatObject`.

## Usage

Open **Messenger** from the app chooser. On a wide panel the room list and chat
share the screen; on a narrow panel the chat replaces the list and a back button
returns to it. Enter sends a message.

Room actions are in the room header and the compose area: add participants,
members/leave, forward a message, and share an object (when another app offers
one). The target selector can send to an existing room or create a new one.

## Development

`websource` is an npm workspace: install once at its root.

```powershell
npm install
npm run dev -w ace-tacphone-messaging
```

`npm run dev` forwards to the host, so the app runs inside the host page with
`window.TacPhone`, the host import map and the WebSocket connection. Open the
printed URL (normally `http://localhost:5173`) and pick **Messenger** in the app
chooser. The host discovers the folder through
`"tacphone": { "app": "Messaging" }` in `package.json`.

## Build

```powershell
npm run build:debug -w ace-tacphone-messaging   # default for development
npm run build -w ace-tacphone-messaging         # release, only when requested
```

The build emits a single self-contained `dist/ace_tacphone_messaging.js` and the
generated `dist/ace_tacphone_messaging.d.ts` service types. The root
`npm run build:debug` also copies the bundle into
`addons/tacphone/apps/messaging/data/`. Packaging rules are in
[`AGENTS/apps.md`](../AGENTS/apps.md).

The game side must be built and loaded: build the PBO from the ACE3 root
(`hemtt build --no-bin` for a local build) and restart Arma after changing the
app registration.

## Inter-app service

Each mounted Messenger panel registers the `messenger` service (version `1`):

| Method | Meaning |
| --- | --- |
| `getRooms()` / `getRoom(id)` | Room summaries, newest message first. |
| `getMessages(roomId)` | Loaded messages, oldest first, with stored chat objects decoded. |
| `openRoom(id)` | Select a room in the panel, opening Messenger if needed. |
| `sendMessage(roomId, content, objects?)` | Send text with optional chat objects. |
| `shareObject(object, options?)` | Open the target selector and resolve on send/cancel; pass `roomId` to send directly. |
| `joinRoom(roomId, inviteKey?)` | Join through an invite. |
| `registerObjectRenderer(renderer)` | Render a chat object kind and own its click behavior (`activate`); returns the unregister function. |

The app that provides an object kind registers its renderer and activation. For
example, the Map app owns `map.marker` previews and focusing the marker;
Messenger contains no kind-specific routing.

Resolve it with
`window.TacPhone.interApp.resolveAsync({ service: 'messenger', panelId: 'Messaging', openIfMissing: true })`.
Types come from the generated declaration.

## Localization

UI text is read with `window.TacPhone.localization.t()` and lives in the
`Messenger` container of `addons/tacphone/stringtable.xml`. Presence labels,
dialog titles and target-selector labels are resolved when they render. See
[`AGENTS/localization.md`](../AGENTS/localization.md).

## Tests

```powershell
npm run test:messaging
npm run test:messaging-ui
npm run test:all
```

`test:messaging` is the Node WebSocket suite; `test:messaging-ui` drives the
Messenger panel with Playwright (rooms, messages, marker sharing and the Map
focus highlight). Both need a running `__A3_DEBUG__` game, the TacPhone web host
and a trusted local HTTPS certificate. Add `-- --slow` to the UI suite to watch
the browser.

## Limitations

- Message history is not persisted across sessions yet; the game-side
  persistence is scaffolding and disabled.
- Relayed requests answer `pending: true` immediately, so dialogs that need the
  server's new room id cannot select or report it from the response.
- Participant group colors are not available yet.
- The last open room is not restored after the app remounts.

## Related documentation

- [`AGENTS/messaging.md`](../AGENTS/messaging.md) — internals, protocol and known
  limitations.
- [`../../apps/messaging/README.md`](../../apps/messaging/README.md) — game-side
  wire and behaviour reference.
- [`AGENTS/apps.md`](../AGENTS/apps.md) — app contract and services.
