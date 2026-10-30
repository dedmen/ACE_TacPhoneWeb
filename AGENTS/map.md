# Map app (`ACE_TacPhone_Map`)

Read this only for the Map app. The shared app contract/packaging is in
[`apps.md`](apps.md); the request protocol and interests in [`sqf.md`](sqf.md).
The full reference is [`ACE_TacPhone_Map/README.md`](../ACE_TacPhone_Map/README.md).

## File map

| Area | Files |
| --- | --- |
| Entry and panels | `src/main.tsx` (`ACE_TacPhone_Map`, `ACE_TacPhone_Map_Placeholder`) |
| Map view/OpenLayers, panel lifecycle, `map` service | `src/Map.tsx` |
| Marker requests | `src/MapMarkers/MarkerApi.ts` |
| Marker rendering, state, queue, icons | `src/MapMarkers/MarkerLayer.tsx` |
| Create/edit dialog and context menu | `src/MapMarkers/MarkerCreateDialog.tsx`, `src/MapMarkers/MarkerContextMenu.tsx` |
| Polyline drawing and measurement | `src/MapMarkers/PolylineDrawing.ts`, `src/MapMarkers/PolylineDrawControls.tsx` |
| Terrain heights | `src/MapMarkers/TerrainHeightApi.ts` |
| Marker notifications | `src/MapMarkers/MarkerNotifications.ts` |
| Layer switcher | `src/LayerSwitcher.tsx` |
| Game → app command routing | `src/CommandRegistry.ts` |
| Inter-app service types | `src/api.ts` (source of `dist/ace_tacphone_map.d.ts`) |
| Generated/copied output | `dist/ace_tacphone_map.js`, `dist/ace_tacphone_map.d.ts`, `../../apps/map/data/ace_tacphone_map.js` |

The map panel reads its live handle from `this.props.panel` and the host from
`window.TacPhone`. It creates the OpenLayers map, registers the `map` service,
and acquires the marker interest in its lifecycle; release the interest and
unregister the service on unmount, including when map creation failed part-way.

## Requests and game pushes

Web → game (all through `window.TacPhone.networking.Request`, `a:
"ACE_TacPhone_Map"`):

| `c` | Purpose |
| --- | --- |
| `GetAllMarkers` | Initial snapshot; also seeds known names for notifications. |
| `GetPlayerID` | Local player id, used to suppress own-marker notifications. |
| `GetMarkerTypes` | Marker types, colors, brushes, icons. |
| `getTerrainHeight` | Heights ASL for a batch of 2D positions, same order. |
| `CreateMarker` | Create a marker, or update one when `marker.name` exists. |
| `DeleteMarker` | Delete a marker by name. |

Game → web: `Marker.Upsert` (new or changed marker) and `Marker.Delete`. Both are
routed through `mapCommandRegistry` in `src/CommandRegistry.ts`.

`getTerrainHeights(positions)` in `TerrainHeightApi.ts` validates input/reply,
batches, and caches coordinates. Only click-per-point drawing requests heights;
freehand strokes request none.

## Marker interaction

Only `_USER_DEFINED` markers are editable; everything else is read-only.

- Desktop: hover + `Delete` deletes; double-click edits label/type/color;
  hold left mouse 100 ms then drag to move.
- Touch/pen: hold 100 ms to lift and drag; holding until the 600 ms long-press
  timeout (or releasing without dragging) opens edit/delete actions.
- A long-press/double-click on an existing marker never opens the create dialog.
- Dragging sends a position-only `CreateMarker` request, throttled to one per
  100 ms plus a final update on release. During a drag the local pointer wins;
  other incoming property changes still apply. Edits send only changed
  `label`/`type`/`color`.
- New markers send `CreateMarker` with `shape`, `position`, `color`, and marker
  properties. The game generates the `_USER_DEFINED` name.

## Polyline drawing

A pencil button below the layers button enables drawing mode. Default input is
freehand; `Click per point` switches to click/tap vertices. The mode is shared
for mouse, touch, and pen.

- Freehand samples only after 5 m of movement, previews raw points, and
  simplifies with Ramer–Douglas–Peucker (2 m) before sending.
- Right-drag pans while drawing; a second right-button-only `DragPan` is added
  for the mode. Marker long-press/double-click/drag gestures are suppressed.
- Measurement overlay is preview-only and click-per-point only: per-segment
  distances, total, per-vertex terrain-height labels, segment `Δh`, interior
  angles (degree text plus fixed 24 px arcs), and a first-segment bearing
  (`° / mil`). Nothing is sent to the game.
- `Done` (at least two vertices) sends `CreateMarker` with
  `{ shape: 'POLYLINE', position: [x1, y1], polyline: [x1, y1, x2, y2, ...],
  color }`. The game generates the name; `Done` leaves the mode active with an
  empty canvas so several lines can be drawn.
- The preview layer sits above markers and is not in the layer switcher.
- Polyline markers are display-only in the web UI: the context menu, `Delete`,
  and drag/edit paths handle point markers only. Color is the only configurable
  property; channel stays at the request default `0`.

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
| `flyTo({ x, y, resolution?, animate? })` | Move the view; omit `resolution` to keep zoom, `animate: false` jumps. Calls before the terrain SVG is ready are queued. |
| `getView()` | `{ x, y, resolution }` or `undefined` while the view is not ready. |
| `isReady()` | True when the map and terrain view exist. |

Coordinates are world/map units, not latitude/longitude. Consumers should
`resolveAsync({ service: 'map', ... })` because a background Map has no live
registration. The generated `dist/ace_tacphone_map.d.ts` exports `MapApi`,
`MapViewState`, `MapFlyToOptions`, `MAP_SERVICE`, and `MAP_SERVICE_VERSION`.

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
| `fnc_processBrowserRequest.sqf` | Handles the `GetAllMarkers`, `GetPlayerID`, `getTerrainHeight`, `CreateMarker`, `DeleteMarker`, and `GetMarkerTypes` requests. |
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
```

The build runs `tsc -b`, Vite, `tacphone-build check-shared-imports`, and
`bundle-api-types`, producing `dist/ace_tacphone_map.js` and
`dist/ace_tacphone_map.d.ts`. The `.d.ts` is generated from `src/api.ts`; never
hand-edit it or a synced copy. The copied JS is git-ignored.

## Traps

- The placeholder panel `ACE_TacPhone_Map_Placeholder` still ships; panel ids are
  persisted in layouts, so remove it deliberately (see `TODO.md`).
- Do not add bundle-relative imports or CSS side files; the production bundle is
  loaded from a blob URL.
- StrictMode double-mounts panels. Marker layers, interests, services, and
  request queues must tolerate mount → unmount → mount.
- A background Map panel is not mounted, so its marker state is not live; routing
  must activate it through `interApp.resolveAsync()`.
