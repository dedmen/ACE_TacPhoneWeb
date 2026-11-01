# Map marker dialog — manual browser checklist

Fallback for machines where Playwright (or an installed Chrome channel) is not
available. The automated equivalent is `npm run test:map -- --scenario marker-ui`
(see [`../README.md`](../README.md)); this checklist covers the same behaviour
plus the visual items that DOM assertions cannot check.

## Prerequisites

- Arma 3 with the current TacPhone PBO, the TacPhone web host on port 8001, and
  the host page open (in-game browser or `http://localhost:5173/`).
- DevTools open on the page (Console and Elements tabs).
- A Map panel is open (`ACE_TacPhone_Map`) and shows terrain.

## Create dialog

1. Double-click empty terrain. A marker dialog opens.
2. **Headerless and compact.** There is no title row and no close `×`; only the
   fields and the Cancel/Create buttons. The panel is roughly 230 px wide.
3. **Semi-transparent.** The map/grid is visible through the panel. In DevTools
   select the dialog and check that the computed background has alpha < 1.
4. **Bottom-right placement.** With room around the marker, the dialog sits
   below-right of the icon and the marker plus its label stay visible.
5. Type a long marker name. The dialog does **not** move while typing, and the
   label is not covered.
6. Drag the marker near the bottom-right corner of the map and reopen the
   dialog: it falls back to another corner but stays fully inside the map.

## Dropdowns (SelectMenu)

1. Click the marker type trigger. The menu appears **above** the dialog and
   floats over the map; the dialog does not grow.
2. Run this in the console while the menu is open:

   ```js
   const d = document.querySelector('[data-testid="marker-create-dialog"]');
   const m = document.querySelector('[data-dropdown-menu]');
   ({
     dialogScroll: { scrollHeight: d.scrollHeight, clientHeight: d.clientHeight },
     menuParentIsBody: m.parentElement === document.body,
     menuInsideDialog: d.contains(m),
     menuPosition: getComputedStyle(m).position,
     menuZIndex: getComputedStyle(m).zIndex,
     dialogZIndex: getComputedStyle(d).zIndex,
   });
   ```

   Expected: `menuParentIsBody: true`, `menuInsideDialog: false`,
   `menuPosition: 'fixed'`, `menuZIndex` above `dialogZIndex`, and the dialog
   `scrollHeight` unchanged compared to before opening the menu.
3. Type `flag` in the menu's search field. Only matching types remain; select
   `flag_NATO`.
4. Close the dialog and reopen it: the marker is still compact and has no
   scrollbar of its own. Repeat the console snippet: `dialogScroll` still shows
   no overflow on a large screen.
5. In multiplayer, open the channel menu: same portal behaviour. Press Escape
   once — only the menu closes, the dialog stays open. Press Escape again — the
   dialog closes.

## Colors

1. Select `flag_NATO`. The color picker starts on the highlighted `Default`
   swatch and that swatch is **white** (the type's `color[]`).
2. Pick `Red`; place the marker. The marker and its label text are red, not
   white.
3. Pick `Black`; same check: the label text is black on light terrain.
4. Switch the type back to `flag_NATO` while `Default` is selected; the Default
   swatch and the type-preview icon turn white.
5. Edit the marker and set the color to `Default`; Save. The marker is
   recreated with the type color (same as a channel change).
6. The marker picker shows exactly one `Default` swatch.

## Polyline picker

1. Open the polyline panel (pencil button). The swatch grid shows `Black` and
   does **not** show a second `Default` swatch.
2. Draw a line and press Done. It is created with the selected color class.

## Text length

1. Paste 300 characters into the marker name. The input stops at 256
   characters.

## Create / edit / cancel

1. Create a marker with the defaults. It appears with the chosen type, color,
   direction and scale.
2. Cancel a create dialog: nothing is created.
3. Double-click the marker: the edit dialog opens with the marker's values;
   change type/color/direction/scale/channel and Save.
4. No console errors during the whole flow.

## Notes on permitted analysis

DOM/geometry/computed-style checks are the primary evidence. Local OCR or image
analysis is allowed only on the test machine without a cloud service; AI image
analysis needs a `@LocalAgentHigh` subagent on the maintainer's machine and the
user's prior approval.
