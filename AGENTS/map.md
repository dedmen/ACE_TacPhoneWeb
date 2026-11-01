# Map app (`ACE_TacPhone_Map`)

Read this only for the Map app. The shared app contract/packaging is in
[`apps.md`](apps.md); the request protocol and interests in [`sqf.md`](sqf.md).
The full reference is [`ACE_TacPhone_Map/README.md`](../ACE_TacPhone_Map/README.md).

## File map

| Area | Files |
| --- | --- |
| Entry and panels | `src/main.tsx` (`ACE_TacPhone_Map`, `ACE_TacPhone_Map_Placeholder`) |
| Map view/OpenLayers, panel lifecycle, `map` service | `src/Map.tsx` |
| Map options schema and render settings | `src/MapOptions.ts` |
| Marker map module (layers, interactions, polyline drawing) | `src/MapMarkers/MarkerModule.ts` |
| Marker UI (dialog, context menu, polyline controls) | `src/MapMarkers/MarkerOverlay.tsx` |
| Marker channel store shared with the layer switcher | `src/MapMarkers/MarkerChannelStore.ts` |
| Generic layer-switcher section registry | `src/MapMarkers/LayerSwitcherRegistry.ts` |
| Marker layer-switcher section | `src/MapMarkers/MarkerLayerSwitcherSection.tsx` |
| Marker requests | `src/MapMarkers/MarkerApi.ts` |
| Marker rendering, state, queue, icons, channel layers | `src/MapMarkers/MarkerLayer.tsx` |
| Marker channels and direction helpers | `src/MapMarkers/Channels.ts` |
| Create/edit dialog and context menu | `src/MapMarkers/MarkerCreateDialog.tsx`, `src/MapMarkers/MarkerContextMenu.tsx` |
| Polyline drawing and measurement styles | `src/MapMarkers/PolylineDrawing.ts`, `src/MapMarkers/PolylineMeasurements.ts`, `src/MapMarkers/PolylineDrawControls.tsx` |
| Persisted polyline measurement overlay | `src/MapMarkers/PolylineMeasurementLayer.ts` |
| Terrain heights | `src/MapMarkers/TerrainHeightApi.ts` |
| Marker notifications | `src/MapMarkers/MarkerNotifications.ts` |
| Layer switcher | `src/LayerSwitcher.tsx` |
| Game → app command routing | `src/CommandRegistry.ts` |
| Messenger sharing and `map.marker` renderer | `src/MessagingBridge.ts` |
| Inter-app service types | `src/api.ts` (source of `dist/ace_tacphone_map.d.ts`) |
| Generated/copied output | `dist/ace_tacphone_map.js`, `dist/ace_tacphone_ol.js` (facade core), `dist/ace_tacphone_map.d.ts`, `../../apps/map/data/ace_tacphone_map.js`, `../../apps/map/data/ace_tacphone_ol.js` |

The map panel reads its live handle from `this.props.panel` and the host from
`window.TacPhone`. It creates the OpenLayers map, registers the `map` service,
and acquires the marker interest in its lifecycle; release the interest and
unregister the service on unmount, including when map creation failed part-way.

Terrain is loaded with `window.TacPhone.networking.LoadGameTerrain(...)`, which
resolves to a `TerrainData` (`{ width, height, layers: [{ name, svg }] }`).
`applyTerrainLayers()` uses `width`/`height` for the extent and tile resolutions
and turns each layer's `svg` into a Blob URL/`Image`; the Map never parses or
splits the raw terrain SVG itself (the host producer does that before sending).

`MarkerOverlay` is mounted by `Map.tsx` and creates the `MarkerModule`; the
module owns the marker layers, polyline drawing preview, measurement overlay and
all marker / polyline map pointer and keyboard interactions. The overlay owns
the React marker UI (create/edit dialog, context menu, polyline controls) and
publishes the active channel through `MarkerChannelStore`. `Map.tsx` keeps no
marker state.

`LayerSwitcher` is generic. Map add-ons inject sections through
`LayerSwitcherRegistry`; a section can claim map layers and render its own rows.
The marker overlay registers `MarkerLayerSwitcherSection`, which renders the
channel checkboxes/radio and hides itself when no marker module is attached. A
Map panel can omit the overlay to host a plain map with no marker layers,
interactions, UI, or layer-switcher channel section.

## Requests and game pushes

Web → game (all through `window.TacPhone.networking.Request`, `a:
"ACE_TacPhone_Map"`):

| `c` | Purpose |
| --- | --- |
| `GetAllMarkers` | Initial snapshot; also seeds known names for notifications. |
| `GetMarkerTypes` | Marker types, colors, brushes, icons. |
| `GetMarkerChannels` | Standard plus in-use custom channels, labels and marker-placement flags. |
| `getTerrainHeight` | Heights ASL for a batch of 2D positions, same order. |
| `CreateMarker` | Create a marker, or update one when `marker.name` exists. |
| `DeleteMarker` | Delete a marker by name. |

The local player id and multiplayer flag come from the host's one-time
`window.TacPhone.gameInfo` snapshot, not from a Map request. The Map awaits
`gameInfo.whenReady()` before applying the marker snapshot.

Game → web: `Marker.Upsert` (new or changed marker) and `Marker.Delete`. Both are
routed through `mapCommandRegistry` in `src/CommandRegistry.ts`.

`getTerrainHeights(positions)` in `TerrainHeightApi.ts` validates input/reply,
batches, and shares a whole-meter coordinate cache with the persisted
measurement overlay. Only click-per-point drawing requests heights immediately;
freehand strokes request none.

## Marker interaction

Only `_USER_DEFINED` markers are editable; everything else is read-only. The
touch context menu additionally offers “Share to Messenger” for icon markers
when the Messenger app is installed (see [Messenger integration](#messenger-integration)).

The map is always north-up: the view sets `enableRotation: false` and the
`DragRotate`/`PinchRotate` interactions are removed at map creation, so
two-finger touch cannot rotate it.

- Desktop: hover + `Delete` deletes; double-click edits
  label/type/color/channel/direction/scale; hold left mouse 100 ms then drag to
  move.
- Touch/pen: hold 100 ms to lift and drag; holding until the 600 ms long-press
  timeout (or releasing without dragging) opens edit/delete actions.
- A long-press/double-click on an existing marker never opens the create dialog.
- Dragging sends a position-only `CreateMarker` request, throttled to one per
  100 ms plus a final update on release. During a drag the local pointer wins;
  other incoming property changes still apply. Edits send only changed
  `label`/`type`/`color`.
- New markers send `CreateMarker` with `shape`, `position`, `color`, `channel`,
  and marker properties. The game generates the `_USER_DEFINED` name.
- The create/edit dialog shows direction and scale sliders (`-180..180`, `0..360`
  when sent; `0.5..2`). Edits send the changed `label`/`type`/`color`/`dir`/`size`.

## Marker creation dialog

- A small semi-transparent panel is positioned beside the marker (left/right,
  with an above/below fallback) so the icon and its label stay visible.
- It shows a live preview on its own layer at the target position; label, type,
  color, direction and scale update it immediately. Preview is create-only.
- In multiplayer the channel dropdown defaults to the active channel and changing
  it makes that channel active. It is available in both create and edit mode;
  singleplayer has no channel control.
- Direction (`-180..180`, default `0`) and scale (`0.5..2`, default `1`) sliders
  are sent as `dir` and `size: [scale, scale]`.
- Create mode remembers the last selected type/color in module scope (per page
  session). Edit mode uses the marker's values and does not overwrite them.

## Marker channels

- In multiplayer the marker layer is split into one OpenLayers layer per
  channel. Channels 0, 1, 3 and 5 (Global, Side, Group, Direct) always get a
  layer; 2, 4 and custom channels appear only while they contain markers.
- Custom channel IDs/names come from `GetMarkerChannels`: IDs `6..15` and
  `26..65`, only when `radioChannelInfo` reports them as in use.
- The layer switcher itself is generic. The marker overlay registers a section
  through `LayerSwitcherRegistry`; that section renders the channel checkboxes,
  active-channel radio and active label. With no marker module attached, no
  section exists and the switcher has no channel UI.
- One channel is active. Markers on other channels use
  `INACTIVE_CHANNEL_ALPHA` (0.45); measurement labels dim with them.
- New markers, the create-dialog default and polyline drawing use the active
  channel. Changing the channel in the create dialog makes it active. The edit
  dialog can move a marker to another channel: the Web UI creates a new marker
  on the target channel and deletes the old one. The new marker gets a fresh
  local-player `_USER_DEFINED` name (never another player's id).
- In singleplayer only channel 3 (Group) exists, all markers are bucketed into
  it, and there is no channel selector or radio. The Web UI resolves the
  outgoing channel to 3 before sending; SQF does not re-check `isMultiplayer` or
  the channel type.

## Polyline drawing

A pencil button below the layers button enables drawing mode. Default input is
freehand; `Click per point` switches to click/tap vertices. The mode is shared
for mouse, touch, and pen.

- Freehand samples only after 5 m of movement, previews raw points, and
  simplifies with Ramer–Douglas–Peucker (2 m) before sending.
- Right-drag pans while drawing; a second right-button-only `DragPan` is added
  for the mode. Marker long-press/double-click/drag gestures are suppressed.
- Freehand sets `touch-action: none` on the OL viewport (`setFreehandTouchCapture`)
  so the browser cannot claim a touch drag and fire `pointercancel` mid-stroke;
  click-per-point restores it for drag-to-pan. Toggle it wherever the mode changes
  (`togglePolylineDrawing`, `handlePolylineClickPerPointChange`,
  `stopPolylineDrawing`). A non-passive `touchmove` listener on the viewport calls
  `preventDefault()` while freehand is armed as a fallback for ancestors that
  re-enable panning. The app root also clips with `overflow: hidden` so canvas
  rounding cannot make the tab scroll container scrollable.
- The measurement overlay is click-per-point only: per-segment distances, total,
  per-vertex terrain-height labels, segment `Δh`, interior angles (degree text
  plus fixed 24 px arcs), and a first-segment bearing (`° / mil`).
- `Done` (at least two vertices) sends `CreateMarker` with
  `{ shape: 'POLYLINE', position: [x1, y1], polyline: [x1, y1, x2, y2, ...],
  color, channel }`. The game generates the name; `Done` leaves the mode active
  with an empty canvas so several lines can be drawn.
- In click-per-point mode the marker text is set to
  `POLYLINE_MEASUREMENTS_TAG` (`ace_tacphone:polyline-measurements:1`). Polyline
  text is data-only: Arma does not display it, and the Map never renders it.
- Every client, including the creator, rebuilds the measurement overlay for a
  tagged polyline from its geometry and terrain heights. Heights are fetched
  lazily once the polyline is visible.
- `PolylineMeasurementLayer` only draws when the polyline's screen-space
  bounding box is large enough (`60_000 px²` area or a `320 px` span fallback).
  Height requests are skipped while zoomed out.
- The preview layer sits above markers and is not in the layer switcher; the
  persisted measurement overlay is also untitled and excluded from hit-testing.
- Polyline markers are display-only in the web UI: the context menu, `Delete`,
  and drag/edit paths handle point markers only.

## Notifications

`Marker.Upsert` raises a "New map marker" toast, once per marker name. A mounted
`MarkerLayerManager` owns the marker state and local-player filtering; when no
Map panel is mounted, a module-scope backup handler raises the notification
without creating features. Tapping uses `interApp.resolveAsync({ service: 'map',
policy: 'ask' })` and calls `MapApi.flyTo({ x, y })`. The backup handler cannot
identify the local player before the first snapshot, so it may notify for the
local player's own marker (known limitation).

## Map service (inter-app)

Each mounted Map panel registers service `map`, version `1`, from `src/Map.tsx`:

| Method | Meaning |
| --- | --- |
| `flyTo({ x, y, resolution?, animate? })` | Move the view; omit `resolution` to keep zoom, `animate: false` jumps. Calls before the terrain layers are ready are queued. |
| `getView()` | `{ x, y, resolution }` or `undefined` while the view is not ready. |
| `isReady()` | True when the map and terrain view exist. |
| `hasMarker(name)` | True while a marker with that internal name is on the marker layer. |
| `focusMarker(name)` | Flies to the marker at the current resolution. Resolves `false` when the marker does not exist or the layer is not ready; it waits for the initial marker snapshot before deciding. |

Coordinates are world/map units, not latitude/longitude. Consumers should
`resolveAsync({ service: 'map', ... })` because a background Map has no live
registration. The generated `dist/ace_tacphone_map.d.ts` exports `MapApi`,
`MapViewState`, `MapFlyToOptions`, `MAP_SERVICE`, and `MAP_SERVICE_VERSION`.

`MarkerLayerManager` backs those methods: `hasMarker()`, `whenMarkersLoaded()`
(resolves after the initial snapshot, also on failure or destroy),
`getMarkerChatData()` (icon markers only; null for polylines) and
`focusMarker(name, flyTo)`.

## Messenger integration

`src/MessagingBridge.ts` keeps the Messenger contract local as structural
types (`MessengerApi`, `ChatObject`, `MessengerObjectRenderer`); it never imports
`MessagingApp` source. The service is `messenger`, the app and panel id are
`Messaging`.

- **Share**: the marker context menu shows “Share to Messenger” only for an
  icon marker (`shape === "ICON"`, i.e. a `Point` feature) while
  `window.TacPhone.apps.knownApps` contains `Messaging`. The handler builds
  `{ kind: 'map.marker', version: 1, data: { name, type, color, text, label,
  position }, preview: { title, subtitle: 'Map marker', icon, color },
  action: { service: 'map', panelId: 'ACE_TacPhone_Map', method: 'focusMarker',
  args: [name] } }` and calls
  `resolveAsync({ service: 'messenger', panelId: 'Messaging', openIfMissing: true })`
  then `MessengerApi.shareObject()`. Messenger owns its target selector and its
  dialogs; the Map only shows a notification when sharing really fails (not on a
  user cancel).
- **Renderer**: while any Map panel is mounted, a `map.marker` renderer is
  registered with a mounted Messenger panel (`describe` reuses the stored
  preview for icon/color). The registration follows `interApp.onDidChange`, so
  it attaches when Messenger mounts later, and is released on unmount; several
  Map panels share one registration.
- **Click**: the serialized `action` routes to the Map service with
  `policy: 'ask'` and calls `focusMarker(name)`. When it returns false, Messenger
  keeps the card, reports the marker as deleted, and offers a button that flies
  to `data.position`.


## Options (`src/MapOptions.ts`)

The Map registers its schema from `init()` and reads it through
`src/MapOptions.ts`. Defaults reproduce the old hard-coded values.

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `terrainQuality` | select `low`/`balanced`/`high` | `balanced` | maxZoom/minResolution: 4/0.5, 5/0.2, 6/0.1 |
| `tileCacheSize` | select 16/48/128 | 48 | per-layer tile cache |
| `pixelRatio` | select `device`/`1.5`/`1` | `device` | `Map.setPixelRatio()` cap |
| `tilePreload` | select 0/1/2 | 0 | `TileLayer.preload` |
| `smoothScaling` | boolean | true | canvas smoothing + `ImageTileSource.interpolate` |

Presets `weak`, `balanced` and `desktop` are stateless shortcuts rendered as
buttons; they call `options.apply()` and write the individual values.

`Map.tsx` keeps the decoded terrain layers in `terrainSource` and builds tile
layers in `rebuildTerrainLayers()`. Terrain tiles are fixed at 128 px; a larger
tile delays the first visible terrain and does not pay for itself. Changing a
tiling option disposes and rebuilds only the tile sources; the terrain SVG is not
requested from the game again. `pixelRatio` is applied live with
`Map.setPixelRatio()`. The view's zoom-out limit uses a fixed 256 px reference,
so it stays independent of the fixed tile size.

## Data interest

The interest is `ACE_TacPhone_Map.markers` (`MAP_MARKERS_INTEREST` in
`src/Map.tsx`, `INTEREST_MARKERS` in `../../apps/map/script_component.hpp`).

- The panel acquires it before requesting `GetAllMarkers`, and releases it on
  unmount (including partial map-creation failure). Request order guarantees the
  game is already pushing updates when the snapshot arrives.
- While nobody holds it, the game installs no marker event handlers and does no
  marker work. The Map still shows its last snapshot.
- The host reference-counts it per page; several Map panels share one interest,
  and reconnect re-announces it.

## Game-side handlers (`../../apps/map/functions`)

| File | Role |
| --- | --- |
| `fnc_processBrowserRequest.sqf` | Handles the `GetAllMarkers`, `GetMarkerChannels`, `getTerrainHeight`, `CreateMarker`, `DeleteMarker`, and `GetMarkerTypes` requests. |
| `fnc_createMarker.sqf` | Creates or updates a marker from request data. |
| `fnc_assembleMarkerInfo.sqf` | Builds the marker array sent as `Marker.Upsert` / snapshot entries. |
| `fnc_onMarkerCreated.sqf`, `fnc_onMarkerPosChanged.sqf`, `fnc_onMarkerDeleted.sqf` | Mission/CBA marker event handlers; push to interested clients. |
| `fnc_onMarkerPlaced.sqf` | ACE marker-placed handler; forwards new markers to `onMarkerCreated`. |
| `fnc_onInterestActivated.sqf`, `fnc_onInterestDeactivated.sqf` | Install/remove exactly the marker event handlers on interest transitions (idempotent). |

`XEH_postInit.sqf` registers the two CBA interest events. The app is registered
in `../../apps/map/ace_tacphone_apps.hpp`; see [`sqf.md`](sqf.md#app-registration)
for the config fields.

## Build

```powershell
npm run build          # from this folder, or npm run build -w ace-tacphone-map
Copy-Item dist\ace_tacphone_map.js ..\..\apps\map\data\ace_tacphone_map.js
Copy-Item dist\ace_tacphone_ol.js ..\..\apps\map\data\ace_tacphone_ol.js
```

The build runs `tsc -b`, Vite, `tacphone-build facade build`, `tacphone-build
check-shared-imports`, and `bundle-api-types`, producing
`dist/ace_tacphone_map.js`, `dist/ace_tacphone_ol.js`, and
`dist/ace_tacphone_map.d.ts`. The `.d.ts` is generated from `src/api.ts`; never
hand-edit it or a synced copy. The copied JS files are git-ignored.

The Map app externalizes OpenLayers behind the `tacphone-ol` facade
(`tacphoneFacade({ packageName: 'ol', prefix: 'tacphone-ol' })` in
`ACE_TacPhone_Map/vite.config.ts`), so `src` keeps ordinary `ol/...` imports and
the plugin rewrites them to `tacphone-ol/...` at build time. The built
`ace_tacphone_ol.js` ships as the `tacphone-ol-core` dependency declared in
`../../apps/map/ace_tacphone_apps.hpp`; `ol/ol.css` stays a normal CSS import
that the single-file plugin inlines. See
[`apps.md`](apps.md#runtime-dependencies).

## Traps

- The placeholder panel `ACE_TacPhone_Map_Placeholder` still ships; panel ids are
  persisted in layouts, so remove it deliberately (see `TODO.md`).
- Do not add bundle-relative imports or CSS side files; the production bundle is
  loaded from a blob URL.
- StrictMode double-mounts panels. Marker layers, interests, services, and
  request queues must tolerate mount → unmount → mount.
- A background Map panel is not mounted, so its marker state is not live; routing
  must activate it through `interApp.resolveAsync()`.
- Never `layer.dispose()` a layer that was just removed from a live map. It nulls
  the layer in the shared layer state, but `Map.frameState_` still references that
  state until the next render, so a pointer event crashes
  `forEachFeatureAtPixel()` on `null.hasRenderer()`. Clear the renderer and dispose
  the source instead (see `disposeTerrainLayers()`).
