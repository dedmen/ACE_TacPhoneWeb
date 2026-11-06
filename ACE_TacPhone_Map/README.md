# ACE TacPhone Map

The Map app for ACE TacPhone: a north-up OpenLayers terrain map with markers,
multiplayer chat channels, polyline measurement drawing, and marker sharing with
Messenger.

## Features

- Terrain rendering from the game's map data, with configurable quality and tile
  caching for weak phones. Terrain and roads appear first; the heavy object and
  contour layers load last and are hidden while zoomed out.
- The first map load jumps straight to the fitted view instead of animating the
  whole zoom range.
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

Right-click a player-created polyline and choose **Edit polyline** to drag its
existing vertices. **Save** sends the new geometry to the game; **Cancel** or
Escape restores the original line. The context menu also keeps **Share to
Messenger**.

### GPS

Open **GPS** from the app chooser. The GPS panel is the same map widget in
navigation mode:

- the player is an OpenLayers feature, so it moves correctly with pan/zoom/
  rotation even while auto-follow is suspended. The top HUD shows `HDG`, the
  route arrow, one compass SVG and the distance/ETA;
- there is **no transport-mode selector**: the GPS always plans for the
  player's current detected mode and recalculates when the vehicle changes;
- open the bottom-right floating editor, tap the map to add ordered waypoints,
  then **Calculate** and **Start**. Waypoints are draggable; clicking an
  existing route line inserts a waypoint there and renumbers the rest; the
  preview and the distance/height labels update while placing them;
- the route prefers roads for ground vehicles, avoids water unless the vehicle
  floats, and uses the vehicle's `maxSpeed`/`enginePower`/mass and the terrain
  slope for the ETA. Roads still use the slope/engine model; they only skip
  `terrainCoef` and the forest penalty;
- the route behind the player fades; waypoint and arrival sounds play;
- **Share route** sends the route through Messenger. Receiving a shared route
  opens a preview; **Start route** joins the nearest point and follows it, and
  the card asks before replacing a route that is already running;
- if a shared leg expects a different transport mode, the advisor can offer a
  faster current-mode route after a short delay;
- the map follows the player only while moving. Pan/zoom or `flyTo` suspends
  following for a few seconds, then following resumes when the player moves or
  turns;
- debug builds show a `DBG` button in the bottom-left corner with cost/height
  route overlays, an "Ignore slope influence" toggle and a "Scan current view"
  action that colours the visible viewport without planning a route. It
  depends on `window.TacPhone.gameInfo.isDebug()`.
- route planning uses a bounded 32x32 coarse height grid (>= 10 m spacing) for
  slope cost; foot routes are re-checked at 1 m after the path exists and
  re-planned around steep sections. The debug dialog can scan the current
  viewport without planning a route.

## Options

Open the host **Options** panel (app chooser → Options → Map). Presets are
**Weak phone**, **Balanced** and **Desktop**.

| Option | Default | Effect |
| --- | --- | --- |
| Terrain detail | Balanced | Zoom depth/finest resolution: Low 4/0.5, Balanced 5/0.2, High 6/0.1 |
| Terrain tile size | 256 mobile, 512 desktop | 256/512/1024 px; larger renders faster but uses more memory |
| Tile cache | 48 tiles | Tiles kept per SVG layer; the main memory knob |
| Pixel ratio | Device | Caps the render pixel ratio; 1x is fastest |
| Tile preload | 0 | How many extra tile levels to preload |
| Smooth scaling | on | Canvas smoothing and tile interpolation |
| GPS: rotate map with view direction | on | Rotate the map instead of the player arrow |
| GPS: automatically recalculate route | off | Recalculate after deviating |
| GPS: position update rate | 10 Hz | How often the game pushes the position to the GPS panel (10 or 30 Hz); applies live |

Changing the tile size or another tiling option rebuilds the tile layers from
the already-decoded terrain, without asking the game again; layer visibility
choices survive the rebuild. 1024 px is a manual choice for high-end desktops.

Layers are loaded and scheduled in priority order: terrain, roads, town names,
airports, forests, rocks and mountains first, then the element-heavy objects and
contour lines once the base terrain tiles have finished loading. They are
prepared in the background and are normally ready by the time you zoom in.

Objects, contour lines and mountains use level-of-detail: they are not drawn at
coarse zoom levels where their detail would be sub-pixel or their labels
unreadable, and appear automatically when you zoom in. Their cut-off resolutions
are the exported `OBJECTS_LOD_MAX_RESOLUTION`,
`COUNTLINES_LOD_MAX_RESOLUTION` and `MOUNTAINS_LOD_MAX_RESOLUTION` constants in
`src/layers/TerrainLayerPriority.ts`. The layer switcher lists the layers in this
priority order, so terrain is the first row.

The tile cache is expressed in 128 px tiles; because the tile size is 256 px,
the cache is scaled by `(128 / 256)²` so the memory footprint stays roughly what
it was when tiles were smaller.

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

A GPS panel also registers the `gps` service (version `1`). It inherits the
`map` methods and adds:

| Method | Meaning |
| --- | --- |
| `openSharedRoute(route)` | Opens a validated `map.gps_route` payload as a preview. |
| `startRouteTo([x, y], options?)` | Plans a route and, by default, starts following it. `options.replace` defaults true; `options.start` defaults true. |

A regular Map panel never registers `gps`, so route commands cannot select it.
Use `resolveAsync({ service: 'map', ... })` for map commands and
`resolveAsync({ service: 'gps', ... })` for GPS commands. Types are exported by
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
- Object and contour-line detail is intentionally not drawn at very coarse zoom
  levels (level-of-detail). Toggling such a layer on while zoomed out shows
  nothing until you zoom in.

## Related documentation

- [`AGENTS/map.md`](../AGENTS/map.md) — internals, rendering, channels, tests.
- [`AGENTS/apps.md`](../AGENTS/apps.md) — app contract and packaging.
- [`test/README.md`](test/README.md) — runtime test details.
- [`packages/tacphone-api/README.md`](../packages/tacphone-api/README.md) — shared API types.
