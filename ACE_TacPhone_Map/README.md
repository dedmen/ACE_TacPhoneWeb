# ACE TacPhone Map

The Map app for ACE TacPhone: a north-up OpenLayers terrain map with markers,
multiplayer chat channels, polyline measurement drawing, and marker sharing with
Messenger.

## Features

- Terrain rendering from the game's map data, with configurable quality and tile
  caching for weak phones.
- Icon markers created from the map, with searchable marker types, color
  classes, custom RGBA colors, direction, scale and channel.
- Player-created markers can be dragged, edited and deleted from the phone.
  Markers placed by the mission are read-only.
- In multiplayer, one layer per chat channel with layer checkboxes, an active
  channel and 45% dimming for inactive channels.
- Polyline drawing in freehand or click-per-point mode, with distances, total,
  bearings, angles, terrain heights and `Δh` labels.
- Marker notifications and optional "Share to Messenger" for icon markers.
- The `map` inter-app service, used by Messenger to open and focus markers.

## Usage

Open **Map** from the app chooser. The map is always north-up; two-finger touch
gestures pan and zoom only.

### Markers

- **Create**: double-click the map on desktop, or long-press it on touch/pen.
  The dialog opens next to the marker; the live preview follows type, color,
  direction and scale.
- **Edit**: double-click a player marker, or long-press/right-click it and choose
  Edit. Marker text is optional and limited to 256 characters.
- **Move**: press and hold a marker briefly, then drag. Touch/pen markers lift with
  a drop shadow while dragged.
- **Delete**: hover a marker and press `Delete`, or use the marker context menu.
- **Colors**: the picker offers the type's own default color, the
  `CfgMarkerColors` classes and a **Custom** swatch whose popover holds the
  native color picker and alpha slider. Custom colors use Arma's `#(r,g,b,a)`
  format; alpha never goes below 20%, and a black type default is not offered a
  second time.
- **Share**: for icon markers, the context menu can share the marker to Messenger
  when Messenger is installed.

### Marker channels (multiplayer)

The layer switcher lists the map layers and the marker channel section:

- checkboxes show/hide a channel layer;
- the radio button selects the channel used for new markers and polylines;
- markers on inactive channels are drawn at 45% opacity;
- custom radio channels appear only while they are in use.

Singleplayer always uses the Group channel; there is no channel selector.

### Polylines

Use the pencil button below the layers button. Drag to draw freehand, or enable
**Click per point** to tap vertices; dragging then pans the map. Right-drag pans
while drawing. The panel shows the line color, point count, `Undo`, `Cancel` and
`Done`; `Done` needs at least two vertices.

Click-per-point lines show measurement labels: per-segment distance, total
distance, compass bearing, interior angles and terrain-height labels with height
differences. The measurements are preview data and stay out of the marker text
except for an internal tag used to rebuild them on other clients.

## Options

Open the host **Options** panel (app chooser → Options → Map). Presets are
**Weak phone**, **Balanced** and **Desktop**.

| Option | Default | Effect |
| --- | --- | --- |
| Terrain detail | Balanced | Zoom depth/finest resolution: Low 4/0.5, Balanced 5/0.2, High 6/0.1 |
| Tile cache | 48 tiles | Tiles kept per SVG layer; the main memory knob |
| Pixel ratio | Device | Caps the render pixel ratio; 1x is fastest |
| Tile preload | 0 | How many extra tile levels to preload |
| Smooth scaling | on | Canvas smoothing and tile interpolation |

Terrain tiles are fixed at 128 px. Changing a tiling option rebuilds the tile
sources from the already-decoded terrain, without asking the game again.

## Development

The app runs inside the host dev server, not its own `index.html`:

```powershell
npm install
npm run dev
```

Open the printed URL (normally `http://localhost:5173`) and pick **Map** in the
app chooser. Keep Arma running with TacPhone open so the page connects to the
game. The host discovers this folder as `ACE_TacPhone_Map` through `package.json`;
see [`AGENTS/dev.md`](../AGENTS/dev.md) for other discovery options.

## Build

```powershell
npm run build:debug    # default for development
npm run build          # release, only when explicitly requested
```

The build emits `dist/ace_tacphone_map.js`, `dist/ace_tacphone_ol.js` and the
generated `dist/ace_tacphone_map.d.ts` service types. The root build scripts copy
the bundles into `addons/tacphone/apps/map/data/`. Packaging rules are in
[`AGENTS/apps.md`](../AGENTS/apps.md).

## Inter-app service

Each mounted Map panel provides the `map` service (version `1`):

| Method | Meaning |
| --- | --- |
| `flyTo({ x, y, bbox?, resolution?, animate?, highlight? })` | Move the view. `bbox` is `[minX, minY, maxX, maxY]` and fits the box; `highlight` adds the temporary glow. Omitting `resolution` keeps/fits the zoom; `animate: false` jumps. |
| `getView()` | `{ x, y, resolution }`, or `undefined` while the view is not ready. |
| `isReady()` | True when the map and terrain view exist. |
| `hasMarker(name)` | True while a marker with that internal name is loaded. |
| `focusMarker(name, options?)` | Flies to a marker and fits a box (default 800 m); `highlight` shows the glow. A missing marker opens `options.fallbackPosition` when provided. Resolves `false` when neither exists. |

Use `window.TacPhone.interApp.resolveAsync({ service: 'map', ... })` to route to a
mounted Map, including one that is not currently selected. Types are exported by
the generated `dist/ace_tacphone_map.d.ts`.

## Localization

UI text is read with `window.TacPhone.localization.t()` and lives in the `Map`
container of `addons/tacphone/stringtable.xml`. Map option labels and presets are
built when the app registers them, not at module scope. See
[`AGENTS/localization.md`](../AGENTS/localization.md).

## Tests

```powershell
npm run test:map                       # protocol + browser scenarios
npm run test:map -- --scenario marker-channels
npm run test:map -- --slow             # show the browser, slow every action
npm run test:all                       # host, Messenger and Map suites
```

The suite needs Arma, the TacPhone web host and Playwright with an installed
Chrome channel. `marker-channels` runs its layer/visibility and custom-color
checks in any session and logs that the multiplayer-only checks (second channel,
active-channel radio, inactive dimming) were skipped when Arma reports
singleplayer. See [`test/README.md`](test/README.md) for prerequisites and
scenarios.

## Limitations

- Polyline markers are display-only for editing in the web UI; they can be
  created, measured and shared, but not edited or deleted from the phone. The
  mission can still edit or delete them.
- Markers created by the mission or other apps are read-only; only player-created
  `_USER_DEFINED` markers can be moved or deleted.
- Terrain detail is limited by the data the game can generate and send; very
  large maps benefit from the lower detail presets.

## Related documentation

- [`AGENTS/map.md`](../AGENTS/map.md) — internals, rendering, channels, tests.
- [`AGENTS/apps.md`](../AGENTS/apps.md) — app contract and packaging.
- [`test/README.md`](test/README.md) — runtime test details.
- [`packages/tacphone-api/README.md`](../packages/tacphone-api/README.md) — shared API types.
