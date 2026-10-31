# Messenger browser/UI checklist

These checks need the TacPhone host page open in a browser (in-game or an
external browser) and a running mission. They complement the Node suite in
`../run-tests.mjs`, which covers the protocol only.

Use a debug build for the scripted setup (`Messaging.Debug.*`) and keep the
Developer Tools console visible for warnings. After each block, reset with the
Messenger debug toolbar (or `node ../run-tests.mjs --scenario connection`) so one
check does not hide the next.

## 0. Prerequisites

- [ ] Arma is running an `__A3_DEBUG__` build with the TacPhone messaging add-on
      and the `TacPhone > Allow debug mode` CBA setting enabled.
- [ ] The TacPhone web host is reachable at `https://localhost:8001/` and the
      certificate is trusted.
- [ ] Two Messenger panels can be opened (or one external browser page plus the
      in-game page).
- [ ] The debug toolbar is visible when the game is an `__A3_DEBUG__` build and
      `Allow debug mode` is enabled (fake players, inject message, enemy chat,
      presence, reset).
- [ ] The browser console shows no uncaught errors on boot or StrictMode
      double-mount.

## 1. Notifications and sound

- [ ] Add fake players and inject (or send) a message into a room that is **not**
      the active room while the Messenger panel is open and focused.
      Expected: a notification appears with the sender/room title, a body
      preview, the Messenger icon and the message notification sound.
- [ ] Tap/click the notification.
      Expected: Messenger opens/focuses and selects that room.
- [ ] Send a message into the **currently active** room while the panel is
      mounted, visible and focused.
      Expected: no notification is shown for that message.
- [ ] Switch to another tab/app or blur the document, then receive a message in
      the active room.
      Expected: the notification is shown again.
- [ ] Quickly receive several messages.
      Expected: sounds do not overlap into distortion; notifications remain
      readable and grouped by app.
- [ ] Repeat with a room invite.
      Expected: the invite also notifies and tapping it opens the invite
      message/room.
- [ ] In DevTools, confirm `window.TacPhone.audio` exists; if `AudioContext`
      needed a user gesture, click once and confirm later sounds play.

## 2. Presence transitions

- [ ] With the in-game phone shown as HUD or DIALOG, open room details.
      Expected: the local player is **Available** (green).
- [ ] Close or hide the phone (`CLOSED`/`HIDDEN`), with no external page
      connected.
      Expected: the local player becomes **Minimized** (amber).
- [ ] Open the page in an external browser and make it visible.
      Expected: the player becomes **Available** even if the in-game phone is
      minimized.
- [ ] Hide the external browser tab/page.
      Expected: the player becomes **Minimized** again.
- [ ] Close the external page and leave the in-game phone minimized.
      Expected: the player remains **Minimized**, not offline.
- [ ] Use the debug toolbar to set a fake player to `available`, `minimized` and
      `offline`.
      Expected: the room member list and room list update to green/amber/gray.
- [ ] Restart the game/mission with no page clients registered.
      Expected: the player is **Offline** (gray) until a phone client registers.

## 3. Search in participant and target dialogs

- [ ] Open **Create room** and switch between the Players and Groups tabs.
      Expected: only same-side players are listed by default; groups are
      same-side even when enemy chat is enabled.
- [ ] Type a player name in mixed case.
      Expected: matching is case-insensitive and filters live.
- [ ] Type a group name and a member's name in the Groups tab.
      Expected: the group matches by either its own name or a member name.
- [ ] Enable enemy chat with the debug toolbar, reopen the dialog and search.
      Expected: enemy players appear; enemy groups still do not.
- [ ] Open **Add participants** and **Forward/Invite target selector** and repeat
      the search checks.
      Expected: the same search behavior in every dialog; no result leaks from
      one tab to another.
- [ ] Open **Invite** in a room that already has several members.
      Expected: the "People to invite" list does **not** contain people who are
      already participants; groups whose whole membership is already present are
      hidden too.
- [ ] Add/remove a participant, reopen Invite and confirm the list updates.
      Expected: newly added players disappear from the invite list; removed
      players reappear.

## 4. Floating dialogs from a small panel

- [ ] Resize the Messenger panel to its narrow/single-pane layout (or use a
      narrow browser window).
- [ ] Open Create room, Add participants, Forward target, Invite target and
      Member list.
      Expected: each dialog escapes the panel's scroll clipping, is centered
      over the host page, and is not cut off.
- [ ] With a notification visible, open a floating dialog.
      Expected: the dialog is above notifications.
- [ ] Trigger the host `TargetChooserDialog` (for example by clicking a marker
      card with two Map panels, see section 8).
      Expected: the host chooser is above the Messenger dialog; the Messenger
      dialog closes before routing.
- [ ] Press Escape and click the backdrop.
      Expected: the dialog closes once, without leaving focus trapped or
      duplicating the portal.
- [ ] Hover/focus the three chat header icon buttons (Members, Invite people,
      Add participants).
      Expected: each shows a readable custom tooltip; the in-game Chromium must
      not rely on native title tooltips.

## 5. Forward and invite flows

- [ ] Send a message with text and (if available) a marker object.
- [ ] Use the message action to **Forward** it.
      Expected: the shared target selector lists existing rooms and a
      "New room" option; the room list and New room entry are searchable.
- [ ] Forward to an existing room.
      Expected: the target shows the forwarded banner with the source room name,
      original sender and group (when present); the original body/objects remain.
- [ ] Forward to a **New room** with selected players.
      Expected: the room is created, the recipient can see it, and the forwarded
      message is present.
- [ ] In a direct room, have one participant leave.
      Expected: the other participant keeps the room and its history with only
      themselves listed; Invite/Add participants remain available so they can
      revive the conversation with someone new.
- [ ] Open **Invite** in a room and invite another player.
      Expected: an invite card appears in the room with the room name and a
      Join button.
- [ ] Open the invited client and click Join.
      Expected: the room appears with its full history, the invite is not
      duplicated, and the member list includes the new member.
- [ ] Send an invite, try Join with a deliberately corrupted invite key (or use
      the Node `invites` scenario).
      Expected: a clear "invalid invite key" error and no room membership
      change.
- [ ] Verify the invite card still works after closing/reopening the Messenger
      panel or reconnecting the page.

## 6. In-game groups

- [ ] Create a room with the local player's group.
      Expected: the leader carries the `groupInvited` flag; only human members
      are participants, not AI group members.
- [ ] Open the member list.
      Expected: members of the same in-game group are grouped under one header;
      the header shows the member count and "Group invited".
- [ ] Have another player join/leave the in-game group.
      Expected: they are added/removed from the chat automatically; a system
      notice in the chat says it happened because of an in-game group change.
- [ ] Delete the group while a room contains only that group.
      Expected: the whole room disappears for its members.

## 7. Marker share

- [ ] On the Map app, right-click an **icon** marker.
      Expected: "Share to Messenger" is offered only for icon markers, not for
      rectangle/ellipse/polyline markers.
- [ ] Choose Share to Messenger.
      Expected: the Messenger target selector opens (floating, above the panel).
- [ ] Send the marker to a room.
      Expected: the card shows the marker icon/color and text/label, with
      subtitle "Map marker"; **no coordinates** are shown.
- [ ] Forward the marker card to another room.
      Expected: the object and preview survive the forward.
- [ ] Disconnect/reconnect the page, then reopen the room.
      Expected: the marker card still renders from the stored preview even if
      the Map app is not open.

## 8. Deleted marker and "Show last known position"

- [ ] Share a marker, then delete that marker in the Map app.
- [ ] Click the marker card in Messenger.
      Expected: Messenger reports "This marker was deleted" (or equivalent),
      keeps the card visible, and offers "Show last known position".
- [ ] Click "Show last known position".
      Expected: the Map app opens/focuses and centers on the stored
      `data.position` using `flyTo`; no error is raised.
- [ ] With no Map panel open, click the card.
      Expected: the host opens/activates a Map panel first, then focuses the
      marker (or falls back after `focusMarker` returns false).

## 9. Two Map panels and host TargetChooserDialog

- [ ] Open two Map panels (split layout or two tabs/windows on a wide page) and
      add a marker.
- [ ] Share the marker to Messenger, then click the card.
      Expected: the host `TargetChooserDialog` asks which Map panel to use, is on
      top of all Messenger dialogs/notifications, and lists both instances with
      useful titles.
- [ ] Choose one Map panel.
      Expected: only that panel focuses the marker; the other panel is
      unchanged.
- [ ] Cancel the chooser.
      Expected: no panel changes; the marker card remains usable.
- [ ] Delete the marker, repeat the click and choose a Map panel.
      Expected: the deleted-marker fallback from section 7 still applies to the
      chosen panel.

## 10. Release build has no debug UI

- [ ] Build the release bundle (`npm run build -w ace-tacphone-messaging`) and
      copy it to `addons/tacphone/apps/messaging/data/`.
- [ ] Open Messenger in the release page.
      Expected: no debug fake-player toolbar, no debug buttons, no debug menu
      entries.
- [ ] Search the release bundle for `Messaging.Debug` and `AddFakePlayers`.
      Expected: no compiled debug command paths or fake-player UI remain.
- [ ] Run the Node suite against a release game build.
      Expected: it fails immediately at `Messaging.Debug.Status` with the
      "built with __A3_DEBUG__" message, which confirms the SQF debug commands were
      not compiled.
- [ ] Confirm the release build still connects, syncs, sends, forwards, invites
      and shares markers normally.

## Notes

- These checks intentionally mutate live state (fake players, rooms, display
  mode, missionProfileNamespace). Reset the Messenger debug state and leave the
  phone in a normal display mode when finished.
- The Node suite covers the corresponding protocol paths; if a UI check fails,
  run `node MessagingApp/test/run-tests.mjs --scenario <name> --verbose` first to
  separate a transport/protocol problem from a rendering problem.
