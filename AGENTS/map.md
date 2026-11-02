# Map app (`ACE_TacPhone_Map`)

Read this only for the Map app. The shared app contract/packaging is in
[`apps.md`](apps.md); the request protocol and interests in [`sqf.md`](sqf.md).
UI text uses `window.TacPhone.localization.t()` with the `Map` container of the
add-on stringtable; see [`localization.md`](localization.md).
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
| Shared color swatch picker | `src/MapMarkers/ColorSwatchPicker.tsx` |
| Pure marker color/text helpers (also the debug test hook) | `src/MapMarkers/MarkerColorUtils.ts`, `src/MapMarkers/MapTestHooks.ts` |
| Polyline drawing and measurement styles | `src/MapMarkers/PolylineDrawing.ts`, `src/MapMarkers/PolylineMeasurements.ts`, `src/MapMarkers/PolylineDrawControls.tsx` |
| Persisted polyline measurement overlay | `src/MapMarkers/PolylineMeasurementLayer.ts` |
| Terrain heights | `src/MapMarkers/TerrainHeightApi.ts` |
| GPS module (layers, tracking, navigation, shared-route flow) | `src/MapGps/GpsModule.ts` |
| GPS React boundary, HUD and floating route editor | `src/MapGps/GpsOverlay.tsx`, `src/MapGps/GpsHud.tsx`, `src/MapGps/GpsStyles.module.scss` |
| GPS types and debug overlay painters | `src/MapGps/GpsTypes.ts`, `src/MapGps/GpsDebugOverlay.ts` |
| GPS route orchestration and geometry | `src/MapGps/RoutePlanner.ts`, `src/MapGps/RouteSplice.ts`, `src/MapGps/SharedRoute.ts` |
| GPS pure routing modules | `src/routing/*.ts` |
| GPS terrain masks and road graph | `src/terrain/TerrainMasks.ts`, `src/roads/RoadSvgParser.ts`, `src/roads/RoadNetwork.ts` |
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

- A small, **headerless** semi-transparent panel (`rgba(255,255,255,0.72)` with
  `backdrop-filter`) placed **bottom-right** of the marker, with a fallback order
  of bottom-left → top-right → top-left → clamped centre. The gap clears the
  icon at its current scale; placement depends on the anchor, the container, the
  scale and layout-affecting field counts, never on the label text, so typing
  does not move it and the label stays visible above the dialog.
- It shows a live preview on its own layer at the target position; label, type,
  color, direction and scale update it immediately. Preview is create-only.
- Marker type (searchable) and channel use the host `SelectMenu`
  (`window.TacPhone.components.SelectMenu`); its menu is portaled to
  `document.body` with `position: fixed`, so opening it does not resize the
  dialog or add a scrollbar. Type rows keep the lazy marker-icon preview.
- Color is a compact `ColorSwatchPicker` (shared with the polyline controls). The
  first swatch is the virtual `Default` = the selected marker type's own
  `color[]` (white for `flag_NATO`); the real `CfgMarkerColors.Default` class is
  black and is hidden. When the selected type's own color is black, the virtual
  default is hidden too, so it cannot duplicate the real black swatch.
  Submitting sends `color: "Default"`. `fnc_createMarker.sqf` always applies the
  supplied color with `setMarkerColorLocal`; the Web UI resolves `Default` to the
  selected type's color for the swatch, type previews and label text.
- The color picker also has a **Custom** swatch. It opens a portaled popover
  containing the native color input and the alpha slider, and stores the Arma
  2.20+ RGBA format `#(r,g,b)` / `#(r,g,b,a)`. Alpha is clamped to at least
  `MIN_MARKER_COLOR_ALPHA` (20%) by `rgbToMarkerColor`, so the UI can never create
  an invisible marker. Custom colors received from `markerColor` are parsed by
  `MarkerColorUtils` for rendering.
- The live preview defers a new marker style until its tinted icon finished
  decoding, so dragging the custom color picker keeps the previous icon visible
  instead of blinking. The shared OpenLayers icon cache is capped at 256 entries
  in `MarkerLayer.tsx`.
- Marker text is optional. It is capped at 256 characters in the input
  (`maxLength`), in `MarkerApi.createMarker`/`updateMarker` and again in
  `fnc_createMarker.sqf` (`_text select [0, 256]`); an empty name stores an
  icon-only marker.
- The label text color comes from the resolved marker color stored on the
  feature (`resolvedColor`), not from `Icon.getColor()` (which may return an OL
  `Color` object and used to force white). A custom color's alpha is stored as
  `colorAlpha` and applied through `Icon.setOpacity` (`alpha * colorAlpha * dim`);
  the icon tint itself is opaque, so lowering alpha makes the icon and its
  cloned shadow transparent instead of washing them out toward white.
- In multiplayer the channel dropdown defaults to the active channel and changing
  it makes that channel active. It is available in both create and edit mode;
  singleplayer has no channel control.
- Direction (`-180..180`, default `0`) and scale (`0.5..2`, default `1`) sliders
  are sent as `dir` and `size: [scale, scale]`.
- Create mode remembers the last selected type/color in module scope (per page
  session). Edit mode uses the marker's values and does not overwrite them.
- Test hooks: `data-testid="marker-create-dialog"`, `marker-type-select`,
  `marker-channel-select`, `marker-color-picker`, `marker-color-swatch`,
  `marker-color-custom`, `marker-color-custom-popover`,
  `marker-color-custom-input`, `marker-color-custom-alpha`, `marker-submit`,
  `marker-cancel`. The pure color/text helpers and the live
  marker/channel/polyline/preview state (`getMapState()`) are exposed as
  `window.__TACPHONE_MAP_TEST__` in dev/debug builds only.

## GPS routing architecture

| Path | Purpose |
| --- | --- |
| `src/routing/RouteTypes.ts` | Pure travel-mode, vehicle-performance, route-leg, plan-request and debug-grid types. |
| `src/routing/AStar.ts` | Dependency-free weighted A* and binary min-heap shared by the road graph and grid search. |
| `src/routing/SpeedModel.ts` | Every speed/ETA formula: maxSpeed cap, force-balance climb, slope, surface, forest width/turning, boat water coefficients. |
| `src/routing/TerrainGrid.ts` | 8-neighbor grid A*, line-of-sight simplification and the debug planning grid. |
| `src/routing/RouteMetrics.ts` | Projection, remaining distance/ETA, bearing and the correct leg index for a flattened segment. |
| `src/routing/TurnInstructions.ts` | Turn classification, next maneuver, point-at-distance, next waypoint. |
| `src/routing/DeviationTracker.ts` | Off-route timer, deviation zoom target, waypoint progress, arrival and auto-repath trigger. |
| `src/routing/VehicleChange.ts` | `GPS.VehicleChanged` parsing and the 350 ms debouncer. |
| `src/terrain/TerrainMasks.ts` | Lazy SVG parsing, raster masks, passability, water queries and planning bbox. |
| `src/roads/RoadSvgParser.ts` | Parses the `roads` SVG layer into stroked polylines, skips `*Fill` paths and computes `width = strokeWidth - 2`. |
| `src/roads/RoadNetwork.ts` | Width-aware graph: 0.5 m node merge, endpoint/endpoint and endpoint/segment snapping (capped at 30 m), crossing splits, nearby-node bridges, nearest-node queries and A*. |
| `src/MapGps/RoutePlanner.ts` | Orchestration only: air/boat/foot/ground strategy, road route + off-road connectors, grid fallback, leg splitting and cancellation. |

Ground routing first tries the road graph (snapped within 500 m, off-road
connectors to/from the road) and falls back to the terrain grid. Forest and
water masks are rasterized from the terrain layers; the roads mask uses the
`lines` variant, not the filled surface. Road edges still use the vehicle
force-balance model; they only skip `terrainCoef` and the forest penalty.
`TerrainHeights` builds a bounded 32x32 coarse height grid per plan (10 m
minimum spacing, chunked requests, LRU + long-lived peak/ring cache) and both
the road graph and the grid A* price the slope. Foot paths are validated at
1 m after the path exists and re-planned with a 25 m penalty around a failed
section; fine samples are not cached. The debug overlay is only shown when
`window.TacPhone.gameInfo.isDebug()`; it uses OpenLayers image layers at about
35% alpha and can scan the current viewport even without a route. It is not
part of the normal HUD.

## Map tests

`test/` has game-free unit modules (`test/unit/`) and live scenarios. The unit
runner needs no game: `gps-speed` pins the `legSpeed` speed model (maxSpeed caps,
climb, slope/crawl, water and surface costs), `gps-splice` the route
geometry/splice helpers and the shared-route codec, `gps-advisor` the
transport-mode advisor state machine (injected clock, no timers), `gps-routing`
the route metrics, turn instructions, deviation tracker, vehicle-change parsing
and the road graph's 0.5 m node merge, and `gps-payload` the `map.gps_route`
contract plus the "do not import browser-only modules" guard. Run them with
`npm run test:unit -- --verbose`.

The live Node scenario is `marker-protocol` plus the GPS parts of `gps-protocol`;
Playwright runs `marker-channels`, `marker-ui`, `polyline-draw`, `polyline-edit`,
`map-view`, `gps-panel`, `gps-route`, `gps-shared` and `gps-shared-messenger`.
Browser scenarios create a new flexlayout tab, open the Map or GPS through the app
chooser and wait for a quiet terrain-tile period before asserting. `marker-channels`
checks the singleplayer Group layer and custom colors in any session, and logs
that the multiplayer-only checks (second channel, active-channel radio and
inactive-channel dimming) were skipped when Arma reports singleplayer. In
multiplayer it also covers layer visibility, active-channel dimming and custom
RGBA colors. `polyline-draw` covers mouse clicks, touch taps and freehand
strokes. `polyline-edit` opens the context menu on a created polyline, drags one
vertex, saves, checks `GetAllMarkers`, then drags again and cancels; it uses
`getMarkerPixels(name)` and `polyline.points` from the debug hook and compares
menu/button text through `t('STR_...')` values, not English literals. All are
deterministic and headless-capable and use DOM, attribute,
geometry and `getComputedStyle()` assertions; canvas state is checked through
`window.__TACPHONE_MAP_TEST__` (`getMapState()` plus the pure color helpers),
not pixels. Local OCR/image analysis is allowed on the machine without a cloud
service; AI image analysis only through `@LocalAgentHigh` on the maintainer's
machine after asking the user.
See [`../ACE_TacPhone_Map/test/README.md`](../ACE_TacPhone_Map/test/README.md).

### GPS debug hooks and scenarios

`window.__TACPHONE_MAP_TEST__` (dev builds or `gameInfo.debug`) exposes the GPS
module as well:

- `getGpsDebugState()` returns a plain snapshot of the module fields (not the
  throttled `state`): fix/heading/position/speed, mode and `detectedMode`,
  `waterCapable`, planning/navigating/calculating/rotating/mapRotation,
  offRoute/stale/arrived, the waypoint list, the active route (source, distance,
  ETA, remaining, per-leg mode/kind/distance/ETA/pointCount/source), the shared
  preview, the advisor prompt, the status, the debug counters (`fixCount`,
  `vehicleChangesApplied`, `repathCount`) and per-layer feature/dash/colour
  state plus the player icon. `repathCount` only counts auto-repairs that
  actually replaced the route.
- `getRouteDebugSnapshot()` returns the full planner result for live
  inspection: every leg point, the flattened geometry and leg starts, turn and
  deviation state, and the debug-grid metadata. Use it through the host's
  debug-only `window.__TACPHONE_DEBUG_EVAL__` when a route looks wrong.
- The debug dialog's cost/height overlays have an alpha slider and a hover
  readout. The readout samples the same grid (`Height`, `Cost`, `Surface`,
  `Passable`, `Slope`) under the pointer.
- `gps.*` forwards `setWaypoints`, `addWaypoint`, `clearWaypoints`,
  `calculateRoute()` (resolves after planning), `startNavigation`,
  `stopNavigation`, `setMode`, `setPlanning`, `openSharedRoute`,
  `startSharedRoute`, `discardSharedRoute`, `acceptAdvisor`, `dismissAdvisor`,
  `setLiveUpdates`, `applyFix`, `applyVehicle`, `getTerrainBounds`, `getPixel`
  and `queryWater`. Every forwarder no-ops while no GPS panel is mounted.

The browser helpers live in `test/lib/gps-page.mjs` (`openGpsPage`,
`getGpsDebug`, `waitForGpsDebug`, `gpsCall`, `gpsT`, `gpsPixel`, `pointAt`,
`distance`). `gps-panel` covers the HUD, the travel-mode reply, the options and
the interest; `gps-route` covers waypoint clicks, per-mode planning, start/stop
and follow; `gps-shared` drives the shared-route preview/discard/bad
payload/start-join/replace-confirmation path through the `map` service;
`gps-shared-messenger` walks the real `Share route` → Messenger card → preview →
Start path (needs a `__A3_DEBUG__` game and skips otherwise). `gps-protocol`
(Node) checks `GetPlayerTravelMode`, `Interest.Set` starting and stopping the
10 Hz `GPS.Update` push, and a pre-encoded `map.gps_route` envelope stored
byte-identically by the Messenger server.

**Testing rule for GPS:** assert terrain-relative invariants, never a specific
terrain feature. Coordinates come from `pointAt(state.position, …)` and are
clamped by `getTerrainBounds()`, so a route assertion must not depend on where
the map designer put roads or water. Pause live pushes
(`setLiveUpdates(false)`) and feed synthetic fixes when the test needs a
deterministic position/speed. Every scenario clears waypoints, stops
navigation and restores option values in `finally`.

The route summary's ETA always shows the route's own expected estimate
(`remainingEta`), so it stays meaningful while the player is standing still; it
only falls back to `--` when there is no route or no remaining ETA.

`npm run test:gps-interactive` is the opt-in interactive tier (a human in a
vehicle). It is not in `test:map`, `test:all` or any default listing, and refuses
to run without `$env:TACPHONE_GPS_INTERACTIVE = '1'` or `--opt-in`.
`gps-water-interactive` uses the debug-only `Debug.PrepareBoat` and
`Debug.PrepareWaterVehicle` helpers to spawn the boat/vehicle and teleport the
player beside it, then plans the Web UI's road/water/road waypoints.


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
- The color grid is the shared `ColorSwatchPicker`. It hides the real
  `CfgMarkerColors.Default` class (identical to `Black`) and falls back to the
  first real color (Black) when the remembered color is `Default`/empty. The
  marker dialog uses the same picker with a virtual `Default` first instead
  (hidden when the type color is black). The Custom popover owns both the color
  input and the alpha slider; the drawn preview halo is white at the line's
  alpha, so lowering alpha fades the whole line instead of leaving a white line.
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
- Polyline markers are editable in the web UI: the context menu offers
  **Edit polyline** (`STR_ACE_Tacphone_Map_ContextMenu_EditPolyline`) for
  `_USER_DEFINED` polylines, which calls `MarkerModule.beginPolylineEdit(name)`.
  The panel then shows `Editing polyline` / `Drag a point to move it` with `Save`
  and `Cancel` only; the color picker and click-per-point toggle are hidden.
  Only existing vertices can be moved (no adding/removing), a press within
  12 px of a vertex (capture-phase listener) drags that one point and keeps the
  map drag-pan from starting, and `Escape` cancels. `Save` sends
  `CreateMarker` with `{ name, polyline }` and keeps the marker's measurement tag;
  `Cancel` clears the preview. `MarkerLayerManager.editingPolylineName` bars
  incoming `Marker.Upsert` geometry from overwriting the local points until the
  save or cancel, and a failed save restores the original points and notifies
  with `STR_ACE_Tacphone_Map_PolylineEdit_SaveFailed`.
- They can be **shared**; the context menu also offers Share to Messenger and
  `focusMarker` fits their whole geometry bounding box.
- A read-only presentation (`MarkerOverlay interactive={false}`, used by the GPS
  view) draws markers but renders no polyline controls, dialog or menu and runs
  no marker interaction.

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
| `flyTo({ x, y, bbox?, resolution?, animate?, highlight? })` | Move the view. `bbox` is `[minX, minY, maxX, maxY]`; it overrides the center and fits the box to the viewport. Omit `resolution` to keep/fit the zoom; `animate: false` jumps. `highlight: true` draws the temporary glowing box/circle. Calls before the terrain layers are ready are queued. |
| `getView()` | `{ x, y, resolution }` or `undefined` while the view is not ready. |
| `isReady()` | True when the map and terrain view exist. |
| `hasMarker(name)` | True while a marker with that internal name is on the marker layer. |
| `focusMarker(name, options?)` | Flies to the marker and fits a default 800 m box for icon markers (or `options.bbox`); `options.highlight` shows a 48 px glow around an icon, or the geometry box for a polyline. If the marker is gone and `options.fallbackPosition` is set, it opens that position, shows the same highlight and a "Marker no longer exists" notification. Resolves `false` when there is neither a marker nor a fallback; it waits for the initial marker snapshot before deciding. |

A **GPS panel** additionally registers service `gps`, version `1`. Its API
inherits every `MapApi` method and adds:

| Method | Meaning |
| --- | --- |
| `openSharedRoute(route)` | Opens a validated `map.gps_route` payload as a preview in that GPS panel. |
| `startRouteTo(position, options?)` | Plans a route to `[x, y]` for the player's current detected mode and, by default, starts following it. `options.replace` defaults true; `options.start` defaults true. This is the "Show me how to get there" entry point for other apps. |

A regular Map panel **never** registers `gps`, so a GPS command can never be
routed to a plain Map panel. `gps` is the GPS-as-a-superset-of-Map relation:
resolve `gps` for route commands (and map commands on the same panel), or
`map` for map-only commands.

Coordinates are world/map units, not latitude/longitude. Consumers should
`resolveAsync({ service: 'map', ... })` or `resolveAsync({ service: 'gps', ... })`
because a background panel has no live registration. The generated
`dist/ace_tacphone_map.d.ts` exports `MapApi`, `GpsApi`, `MapViewState`,
`MapFlyToOptions`, `MapBoundingBox`, `MapFocusMarkerOptions`,
`GpsStartRouteOptions`, `MAP_SERVICE`, `MAP_SERVICE_VERSION`, `GPS_SERVICE`, and
`GPS_SERVICE_VERSION`.

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
  args: [name, { highlight: true, fallbackPosition: position }] } }` and calls
  `resolveAsync({ service: 'messenger', panelId: 'Messaging', openIfMissing: true })`
  then `MessengerApi.shareObject()`. Messenger owns its target selector and its
  dialogs; the Map only shows a notification when sharing really fails (not on a
  user cancel).
- **Renderer**: while any Map panel is mounted, a `map.marker` renderer is
  registered with a mounted Messenger panel. `describe` reuses the stored
  preview for icon/color. Its `activate()` owns the click: it resolves the `map`
  service and calls `focusMarker(name, { highlight: true, fallbackPosition })`,
  so a deleted marker still opens its last known position and notifies the user.
  The registration follows `interApp.onDidChange`, so it attaches when Messenger
  mounts later, and is released on unmount; several Map panels share one
  registration.
- **Serialized action / fallback**: the chat object also carries the
  `focusMarker` action with `{highlight: true, fallbackPosition}`. Messenger uses
  it only when no renderer is registered (for example the Map app is closed),
  opening the Map through `resolveAsync()`. Messenger has no map-specific code.


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
tile delays the first visible terrain and does not pay for itself. GPS mode
forces `preload >= 2` even when the user option is 0, because rotating in place
otherwise exposes unloaded corner tiles as black squares. Changing a
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

The GPS panel uses a second interest, `ACE_TacPhone_Map.gps`
(`INTEREST_GPS` in `../../apps/map/script_component.hpp`). While it is held, the
game runs a `GPS_UPDATE_INTERVAL` (0.1 s) per-frame handler that pushes
`GPS.Update` with the player position, camera view direction, heading, speed and
velocity, and installs `GetInMan`/`GetOutMan` on the player to push
`GPS.VehicleChanged`. Per-frame data is never pushed without the interest. The
per-frame handler and the vehicle handlers have separate idempotency guards, so
a `player` that is still null at activation does not stop the handlers from
being installed later. Starting a shared-route preview joins the nearest point
and confirms in the card before it replaces a running route; the in-game browser
does not reliably show a native `confirm()` dialog, so the Map never uses one.

## Game-side handlers (`../../apps/map/functions`)

| File | Role |
| --- | --- |
| `fnc_processBrowserRequest.sqf` | Handles the `GetAllMarkers`, `GetMarkerChannels`, `getTerrainHeight`, `GetPlayerTravelMode`, `CreateMarker`, `DeleteMarker`, and `GetMarkerTypes` requests. |
| `fnc_createMarker.sqf` | Creates or updates a marker from request data. |
| `fnc_assembleMarkerInfo.sqf` | Builds the marker array sent as `Marker.Upsert` / snapshot entries. |
| `fnc_onMarkerCreated.sqf`, `fnc_onMarkerPosChanged.sqf`, `fnc_onMarkerDeleted.sqf` | Mission/CBA marker event handlers; push to interested clients. |
| `fnc_onMarkerPlaced.sqf` | ACE marker-placed handler; forwards new markers to `onMarkerCreated`. |
| `fnc_onInterestChanged.sqf` | Single interest transition handler (`[interest, active]`), one branch per interest: installs/removes exactly the marker event handlers or the GPS per-frame updater (idempotent). |
| `fnc_onGpsUpdate.sqf` | Per-frame `GPS.Update` push (position, view, direction, speed, velocity) while a client holds `INTEREST_GPS`. |
| `fnc_onGpsVehicleChanged.sqf` | Player `GetInMan`/`GetOutMan` handler; pushes `GPS.VehicleChanged` on the next frame. |
| `fnc_getPlayerTravelMode.sqf` | Detects the local player's travel mode (`foot`/`ground`/`boat`/`air`), vehicle class, water capability and performance; also returned by the `GetPlayerTravelMode` request. |
| `fnc_getVehiclePerformance.sqf` | Builds the vehicle config/PhysX snapshot (`maxSpeedKmh`, `enginePowerKw`, `massKg`, turning, water, bounding box) for the web speed model. |

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
