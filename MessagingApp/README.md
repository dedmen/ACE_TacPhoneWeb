# Messenger app (TacPhone)

Messaging/chat app for TacPhone. This folder is the web half; the game half
lives in `addons/tacphone/apps/messaging`.

| Item | Value |
| --- | --- |
| Visible app / tab title | `Messenger` |
| Config class / routing key / panel id | `Messaging` |
| Inter-app service | `messenger` (version `1`) |
| npm package | `ace-tacphone-messaging` |
| Build output | `dist/ace_tacphone_messaging.js` |
| Generated declarations | `dist/ace_tacphone_messaging.d.ts` |
| Game copy target | `addons/tacphone/apps/messaging/data/ace_tacphone_messaging.js` |
| Dev entry (`ace_tacphone_devFile`) | `src\main.tsx` |

## Development

`websource` is an npm workspace: install once at its root.

```powershell
cd websource
npm install
npm run dev -w ace-tacphone-messaging
```

`npm run dev` forwards to `../ACE_TacPhone_Main`, so the app runs inside the
host page with `window.TacPhone` and the host import map. Open the printed URL
(normally `http://localhost:5173`) and pick **Messenger** in the app chooser.

Discovery uses `package.json`:

```json
"tacphone": { "app": "Messaging" }
```

## Build

```powershell
npm run build -w ace-tacphone-messaging
npm run build:debug -w ace-tacphone-messaging   # unminified + inline source maps
```

Both run `tsc -b`, `vite build`, the shared-import check and
`tacphone-build bundle-api-types`. The result is one self-contained ESM bundle
plus the generated service declarations. Copy the JS for in-game use:

```powershell
Copy-Item MessagingApp\dist\ace_tacphone_messaging.js ..\apps\messaging\data\ace_tacphone_messaging.js
```

The output path is already in the ACE3 root `.gitignore`.

For a full release build run these from `websource`; the Map and host copies are
included because the Messenger contract depends on the current Map service:

```powershell
npm run check
npm run build
npm run check:importmap
Copy-Item MessagingApp\dist\ace_tacphone_messaging.js ..\apps\messaging\data\ace_tacphone_messaging.js
Copy-Item ACE_TacPhone_Map\dist\ace_tacphone_map.js ..\apps\map\data\ace_tacphone_map.js
Copy-Item ACE_TacPhone_Main\dist\index.html ..\data\index.html
```

Then run `hemtt check` and `hemtt build --no-bin` from the ACE3 root. The PBO
contains `apps\messaging\data\ace_tacphone_messaging.js` and registers the
`Messaging` app through `apps\messaging\ace_tacphone_apps.hpp`.

## Status

Implemented (web side):

- app registration (`GetTacPhoneApps`, panel id `Messaging`, title `Messenger`),
  one `OnMessageFromGame` routed through `window.TacPhone.utils.CommandRegistry`;
- the public inter-app contract in `src/api.ts` (kept import-free) and the
  internal request/push types in `src/protocol.ts`;
- a module-level `chatStore` in `src/state/ChatStore.ts`: chunked
  `ChatState.*` sync, `Room.Upsert`/`Presence.Changed`/`PlayerList.State`
  merging, optimistic sends reconciled through `clientMessageId`, failed-send
  marking, unread counts, active room, panel visibility, page visibility
  (`SetClientPresence`) and reconnect re-`Hello` + re-sync;
- `src/notifications.ts`: `Message.New`/invite notifications with
  `sound: "message"` and tap-to-open routing through
  `interApp.resolveAsync({ service: 'messenger', panelId: 'Messaging' })`;
- `src/debug.ts`: `Messaging.Debug.*` helpers behind
  `window.TacPhone.gameInfo.isDebug()` (an `__A3_DEBUG__` game build **and**
  the server/mission `allowDebug` CBA setting);
- `init()` in `src/main.tsx` (idempotent under StrictMode);
- room/message helpers in `src/state/roomUtils.ts` (titles, previews, presence,
  invite detection);
- the Messenger panel (`src/MessengerApp.tsx`): two-pane room list + chat on a
  wide panel, single pane with a back button below 560 px;
- `src/components/`:
  - `RoomList` (search, last message, relative time, unread badge, presence),
  - `ChatView`/`MessageItem`/`Composer` (grouped messages, sender/group names,
    group colour accents, forwarded banner, Enter to send),
  - `ChatObjectCard` (generic object cards, room-invite Join card, texture icon
    cache, deleted-marker fallback) and `objectActions.ts`,
  - `CreateRoomDialog`, `AddParticipantsDialog`, `MemberListDialog` and the
    shared `TargetSelectorDialog` (forward/invite/share, room list plus
    "New room" with the searchable player/group picker),
  - `FloatingDialog` (portal to `document.body`, z-index 950: above
    notifications, below the host target chooser),
  - `ParticipantPicker` (Players/Groups tabs, case-insensitive name search),
  - `DebugToolbar` (only when `gameInfo.isDebug()` is true);
- `src/service.ts`: the `messenger` inter-app service (version 1) implementing
  `MessengerApi`, registered from the panel lifecycle; `shareObject()` opens the
  target selector through `src/dialogBus.ts` and resolves on send or cancel;
- panel lifecycle reporting (`setPanelState`) for notification suppression;
- CSS modules under `src/components/` and `src/styles/theme.module.css`.

Implemented (game side): `addons/tacphone/apps/messaging` is a
server-authoritative backend (rooms, messages, invites, presence, forwarding,
player list, debug commands) registered as the `Messaging` app. Its README is
the wire/behaviour reference.

Map integration: marker sharing and the `map.marker` object renderer live in
`ACE_TacPhone_Map/src/MessagingBridge.ts`; neither app imports the other.

Release bundle: `npm run build` no longer tree-shakes the debug toolbar or its
`Messaging.Debug.*` strings out of `dist/ace_tacphone_messaging.js`; the runtime
`gameInfo.isDebug()` check hides the toolbar unless the game is an `__A3_DEBUG__`
build with `allowDebug` enabled. The single-file build also keeps the bundle
pure ASCII.

Known limitations (tracked in `websource/TODO.md`):

- game-side persistence in `missionProfileNamespace` is scaffolding only and
  disabled; save triggers, migration and size limits are undecided;
- relayed game commands answer `{ ok: true, pending: true }` immediately. Flows
  that need the server result synchronously (the new `roomId` of `CreateRoom`,
  `JoinRoom` or forward-to-new-room) do not get one; the push carries the room,
  but the dialogs cannot select or report it from the response;
- `GetPlayerList` is answered by a `PlayerList.State` push; the request reply
  has no list, so the store keeps the pushed state instead of applying an empty
  one;
- participant `groupColor` is empty until the future group member colour system
  exists;
- the last open room is not remembered across remounts;
- `Messaging.Debug.Reset` does not send a `Room.Remove` push, so a page keeps
  stale rooms until it re-syncs;
- the stored Node WebSocket suite lives in `test/` (see `test/README.md`); it
  needs a running `__A3_DEBUG__` game and is not part of the workspace build.

