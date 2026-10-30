# ACE TacPhone Map

The map app for ACE TacPhone. It is also the reference implementation for a
TacPhone app: it registers panels, draws the map, and exchanges marker data with
the game through the TacPhone request protocol.

| Item | Path |
| --- | --- |
| App registration | `addons/tacphone/apps/map/ace_tacphone_apps.hpp` |
| SQF request processor | `addons/tacphone/apps/map/functions/fnc_processBrowserRequest.sqf` |
| App entry point | `src/main.tsx` |
| App service types | `src/api.ts` |
| Generated declarations | `dist/ace_tacphone_map.d.ts` |
| Production bundle | `dist/ace_tacphone_map.js` |
| File loaded in game | `addons/tacphone/apps/map/data/ace_tacphone_map.js` |

## Requirements

- Node.js 20.19+ or 22.12+.
- Arma 3 2.24+ (or the 2.23 dev branch). See the
  [host README](../ACE_TacPhone_Main/README.md#requirements) for why the phone
  UI needs this version.
- Chromium 126+ for the in-game or external browser.

## Development

The app is loaded by the host dev server, not by its own `index.html`:

1. Keep this folder next to `ACE_TacPhone_Main`. The host discovers it as a
   development app because `package.json` declares:
   ```json
   "tacphone": { "app": "ACE_TacPhone_Map" }
   ```
2. Install dependencies once at the workspace root (`websource/`):
   ```powershell
   npm install
   ```
3. Start the host dev server from the workspace root or from either app folder:
   ```powershell
   npm run dev
   ```
   In this folder, `npm run dev` forwards to `../ACE_TacPhone_Main`, so the app
   still gets `window.TacPhone`, the host import map, and the WebSocket
   connection.
4. Open the URL Vite prints (normally `http://localhost:5173`). Keep TacPhone
   open in Arma so the page can connect to `wss://localhost:8001/ws`.
5. Select the Map panel in the TacPhone app chooser.

The host exposes the whole folder as
`/devapps/ACE_TacPhone_Map/` and imports the entry named by
`ace_tacphone_devFile` in
[`ace_tacphone_apps.hpp`](../../apps/map/ace_tacphone_apps.hpp), which is
`src/main.tsx`. Changes hot-reload through the host server.

The `"tacphone.app"` value must match the `ace_tacphone_apps` config class. It is
the routing key used by the game and the host. The folder itself can have any
name; if this folder is not next to `ACE_TacPhone_Main`, list it in the host's
`dev-apps.local.json` or `TACPHONE_DEV_APPS` environment variable.

## Build

Build the app from this folder (or `npm run build -w ace-tacphone-map` at the
workspace root):

```powershell
npm run build
```

`npm run build` runs `tsc -b && vite build --mode release`, then
`tacphone-build check-shared-imports` and `tacphone-build bundle-api-types`,
which emit:

```text
dist/ace_tacphone_map.js
dist/ace_tacphone_map.d.ts
```

`ace_tacphone_map.d.ts` is the public type surface for other apps (see
[Map service](#map-service-other-tacphone-apps)); it is bundled from
`src/api.ts` by `tacphone-build bundle-api-types` and is self-contained (no
imports). `package.json` points `types` at it.

`npm run build` is a release build: the JavaScript is minified, no source map is
embedded, and `console.log` / `console.debug` / `console.info` calls are removed.
Use `npm run build:debug` for an unminified build with an inline source map;
`console.warn` and `console.error` calls are kept in both builds.

For local in-game testing, copy it to the path registered by
`ace_tacphone_file`:

```powershell
Copy-Item dist\ace_tacphone_map.js ..\..\apps\map\data\ace_tacphone_map.js
```

Then open TacPhone in Arma. Release/build tooling must do the same copy; the
generated files are git-ignored.

## App contract

`src/main.tsx` exports:

```ts
import type {
    AppPanelInfo,
    AppProps,
} from '@ace-tacphone/api';

export const apiVersion: number; // TACPHONE_API_VERSION
export function GetTacPhoneApps(): AppPanelInfo[]
export function OnMessageFromGame(message: object): void | Promise<void>
```

The current panels are:

- `ACE_TacPhone_Map` — the OpenLayers map (`src/Map.tsx`).
- `ACE_TacPhone_Map_Placeholder` — a small placeholder panel.

A panel has a globally unique `id`, an `appComponent` typed as
`React.ComponentType<AppProps>`, `GetDefaultTitle()`, and `GetTacPhoneIcon()`.
Panels receive `AppProps` (the live `PanelInstance` and the app/panel ids), so
the Map reads its panel from `this.props.panel` and the host from the global
`window.TacPhone`. See the [host app contract](../ACE_TacPhone_Main/README.md#app-contract)
and [`@ace-tacphone/api`](../packages/tacphone-api/src/index.ts) for the full
definitions.

Game requests use:

```ts
await window.TacPhone.networking.Request({
    a: 'ACE_TacPhone_Map',
    c: 'GetAllMarkers',
});
```

The map's SQF processor handles `GetAllMarkers`, `CreateMarker` (creates a new
marker, or updates an existing one when `marker.name` is supplied),
`DeleteMarker`, `GetMarkerTypes`, and `getTerrainHeight`. Messages from the game
are routed through `mapCommandRegistry` (`src/CommandRegistry.ts`), which is an
instance of the host's `window.TacPhone.utils.CommandRegistry`.

`getTerrainHeight` takes a list of 2D world/map positions and returns one height
above sea level in meters per position, in the same order:

```ts
await window.TacPhone.networking.Request({
    a: 'ACE_TacPhone_Map',
    c: 'getTerrainHeight',
    positions: [[x, y], ...],
});
```

The SQF side calls the engine's `getTerrainHeight` command per position, so a
whole list travels in one request and callers batch instead of issuing a round
trip per point. The web helper is `getTerrainHeights(positions)` in
`src/MapMarkers/TerrainHeightApi.ts`, which validates both the input and the
reply and rejects on invalid data.

### Marker interaction

Only markers whose name starts with `_USER_DEFINED` (player-created markers) can
be moved or deleted; all other markers are read-only.

- **Desktop**: hover a marker and press `Delete` to delete it. Double-click a
  marker to edit its label, type, and color. Press and hold the left mouse
  button on a marker (100 ms without moving), then drag to move it.
- **Touch/pen**: press and hold a marker for 100 ms to lift it (drop-shadow
  highlight), then drag to move it; releasing drops it at the pointer. Holding
  still until the 600 ms long-press timeout, or releasing without dragging,
  opens a context menu with edit and delete actions.
- A long-press or double-click on top of an existing marker never opens the
  marker creation dialog, so markers cannot be stacked on the same spot.
- While a marker is being dragged, the local pointer position wins: incoming
  `Marker.Upsert` messages cannot move it, but other property changes (type,
  color, label, ...) still apply. Movement is sent to the game as a position-only
  `CreateMarker` request (`{ name, position }`), throttled to one request per
  100 ms plus a final update on release. Editing sends only the changed
  `label`/`type`/`color` fields through the same `CreateMarker` update path.
  Deleting sends `DeleteMarker` with the marker name.

### Polyline drawing

A second floating button with a pencil icon sits directly below the layers
button. Pressing it enables polyline drawing mode. The mode behaves the same for
mouse, touch, and pen, and the default input mode is freehand:

- Press and drag to draw. The left button draws while the mode is active, and
  the default `DragPan` is disabled so the gesture draws a line instead of
  moving the map. Holding the right mouse button and dragging still pans the
  map: the Map app adds a second, right-button-only `DragPan` for drawing mode.
- Vertices are sampled during the drag, but only once the pointer has moved at
  least 5 m (map units) from the previous sample.
- On touch/pen, freehand mode sets `touch-action: none` on the OpenLayers
  viewport for as long as it is active. Without it the browser claims the drag
  for native panning, sends `pointercancel` after a few pixels, and the stroke
  ends after a handful of samples. Click-per-point keeps the native gestures
  (`touch-action: pan-x pan-y` from `ol.css`) so drag-to-pan still works. While
  freehand is armed a non-passive `touchmove` listener on the viewport also calls
  `preventDefault()`, so an ancestor that re-enables panning cannot take the
  gesture back. The app root clips with `overflow: hidden` so canvas rounding
  cannot make the flexlayout tab scrollable.
- Releasing ends the stroke. Starting another drag appends to the same line, and
  a quick tap still places a single vertex.
- The drawn points are simplified with Ramer–Douglas–Peucker (2 m tolerance)
  before the polyline is sent to the game. The preview keeps showing the raw
  drawn points until `Done` is pressed.
- Marker long-press, double-click, and drag gestures are suppressed while the
  mode is active, so a marker never captures a vertex tap.

While the mode is active a small persistent panel below the button shows the
`CfgMarkerColors` swatches (the line color), the current point count, a
`Click per point` checkbox, a `Right-drag to pan` hint, and the `Undo` /
`Cancel` / `Done` actions. The checkbox switches to click-per-point input: a
click/tap places a single vertex and dragging pans the map. Its state is kept in
a module-scope variable in the Map app, so it survives closing and reopening the
Map panel but is forgotten when the page reloads. In freehand mode the line
follows the pointer while dragging; in click-per-point mode there is no rubber
band and dragging still pans. `Undo` removes the last vertex, `Cancel` (or
`Escape`) clears the preview and leaves the mode, and `Done` requires at least
two vertices.

Click-per-point input also draws a measurement overlay on the preview; freehand
strokes show no labels. Every segment between consecutive vertices gets a
distance label at its midpoint, offset just above the line (meters, switching to
`km` with two decimals from 1000 m), and a `Total <distance>` label sits below
the last vertex, leaving room for that vertex's height label above it. Every
interior vertex (not the first or last) gets two integer-degree labels on
opposite sides, showing the angles the incoming and outgoing segments form; each
of the two angles is also outlined by its own thin semicircular arc around the
vertex, drawn on that angle's side with a fixed 24 px radius and a small gap
where the two semicircles meet, and its degree text sits at the middle of its
arc, just outside it along the angle bisector. The pair always sums to 360°, so
a straight line reads 180° on both sides. As soon as the second vertex exists, a
bearing label is drawn behind the first vertex, offset away from the line,
showing the compass direction to the second vertex as e.g. `042° / 0747 mil`
(degrees zero-padded and normalized to 0-359 clockwise from map north, mils
zero-padded on the 6400 mil circle); it follows the first segment as more
vertices are added, and moves further up when it would land on that vertex's
height label (first segment pointing down the screen).

Each vertex also gets a height-above-sea-level label just above the point: a
small two-peaks mountain symbol (drawn as pixel-sized geometry, like the angle
arcs) followed by the height in whole meters, e.g. `123 m`. The symbol marks a
terrain height and is never used for the height differences. Where both
endpoints of a segment have a height, the segment's distance label gains the
height difference, e.g. `342 m (Δh +12 m)`: the sign is always explicit and a
value rounded to zero reads `±0 m`. Heights come from the game's
`getTerrainHeight` through `src/MapMarkers/TerrainHeightApi.ts`, requested in
click-per-point mode only, so freehand strokes are not annotated and request no
heights. Switching to click-per-point backfills the heights of vertices that
already exist, and a coordinate cache avoids repeat requests for the same point.

The labels and arcs are preview-only, drawn in the preview layer: they are never
part of the marker and never sent to the game, which still receives only the
geometry and color.

`Done` creates a `_USER_DEFINED` `POLYLINE` marker through the existing
`CreateMarker` request:

```ts
{
    shape: 'POLYLINE',
    position: [x1, y1],
    polyline: [x1, y1, x2, y2, ...], // flat array
    color: '<CfgMarkerColors class>',
}
```

The game generates the `_USER_DEFINED` marker name, as for icon markers.

The mode then stays active with an empty canvas, so several lines can be drawn in
a row. The preview is drawn in its own OpenLayers layer above the marker layer and
is not listed in the layer switcher.

Only color is configurable today: polyline markers have no label, type (beyond
`POLYLINE`), shape, brush, size, or alpha in the UI, and the chat channel is not
implemented yet so it stays at the request default `0`. No SQF change is needed:
`fnc_createMarker.sqf` already handles `shape`/`polyline`, and
`fnc_assembleMarkerInfo.sqf` reports polylines back through `Marker.Upsert`.
Player-created polyline markers are currently display-only in the Web UI: unlike
point markers they cannot yet be edited or deleted from the map.

### Map service (other TacPhone apps)

Each mounted Map panel exposes the inter-app service `map` (version `1`). It is
built in `src/Map.tsx` after the OpenLayers map exists and registered with
`window.TacPhone.interApp.register(this.props.panel, { service: 'map', version: 1,
api })`; the registration is removed before the map is torn down. The API is
`flyTo({ x, y, resolution?, animate? })`, `getView()` (returns
`{ x, y, resolution }` or `undefined`), and `isReady()`. Coordinates are
map/world units, not latitude/longitude.
`resolution` keeps the current zoom when omitted and `animate: false` jumps
instead of animating. A `flyTo()` that arrives before the terrain SVG has loaded
is queued and applied after the initial fit, so routing into a freshly opened Map
popup still lands on the requested position.

Other apps resolve it through
`window.TacPhone.interApp.resolveAsync({ service: 'map', ... })` (see the host's
[Inter-app API](../ACE_TacPhone_Main/README.md#inter-app-api)).
The build also emits `dist/ace_tacphone_map.d.ts`, a self-contained declaration
file bundled from `src/api.ts` that exports `MapApi`, `MapViewState`,
`MapFlyToOptions`, `MAP_SERVICE`, and `MAP_SERVICE_VERSION`, so consumers can
type the resolved API without depending on OpenLayers. It is generated by
`tacphone-build bundle-api-types` during every build; `tacphone-build
sync-api-types` only copies an already-generated declaration to consumers. The
app does not keep its own copy of the declarations.
This is browser-side only; the game talks to the Map through the request
processor and command registry described above, never through this API.

## Marker notifications

The Map app generates toast-style `window.TacPhone.notifications` for marker updates:

- **New markers**: The game sends `{ a: "ACE_TacPhone_Map", c: "Marker.Upsert",
  marker: [...] }`. An open Map's `MarkerLayerManager` handles it through the
  `Marker.Upsert` command and raises a "New map marker" notification. A closed Map
  (no mounted instance) falls back to a module-scope handler that only raises the
  notification.
- **Duplicate names ignored**: The first `Marker.Upsert` for a marker name raises
  the notification and records the name. Subsequent position updates for that name
  do not notify again.
- **Tap behavior**: Tapping a marker notification uses
  `window.TacPhone.interApp.resolveAsync()`
  with `policy: "ask"` to select between multiple Map panels that provide the `map`
  service, then calls `MapApi.flyTo({ x, y })` on the chosen panel. The target chooser
  presents all candidates (floating popups and docked tabs). Default host lifetime is
  15 seconds; use `duration: 0` in your code for permanent notifications until dismissed.

No notification-specific SQF code is needed; the game-side markers are handled by
the request processor and command registry, while the host UI generates banners.

## Data interest

The Map app tells the game when it needs marker data. The interest name is
`ACE_TacPhone_Map.markers` (constant `MAP_MARKERS_INTEREST` in `src/Map.tsx`,
matching `INTEREST_MARKERS` in `addons/tacphone/apps/map/script_component.hpp`).

- A mounted Map panel acquires the interest in `componentDidMount`, before the
  marker manager requests its `GetAllMarkers` snapshot. Request order is
  preserved, so the game is already filtering and sending marker updates when the
  snapshot arrives.
- Unmounting the panel releases it. The release runs before the rest of the
  teardown, so it also happens when map creation failed part-way.
- While no client holds the interest, the game installs no marker event handlers
  and does no marker work; the Map panel still shows the snapshot it loaded.
- The interest is reference-counted by the host (`window.TacPhone.interests`):
  several Map panels in one page share one game interest, closing one panel keeps
  it active, and closing the last one withdraws it. After a websocket reconnect
  the registry re-announces the active interests automatically.

## Packaging constraints

The production loader reads the entry file from the game filesystem and imports
it from a blob URL. The Map build therefore stays a single ESM entry file:

- Format is `es`.
- React is external and resolves through the host import map.
- No bundle-relative dynamic imports, `React.lazy` imports, or relative imports.
- CSS is inlined by `@ace-tacphone/build/singlefile` (the shared plugin used by
  every app); no sidecar CSS file is emitted.
- Only `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, and
  `react/compiler-runtime` may remain bare external imports. The host import map
  provides all five.

`vite.config.ts` takes the external list from the shared
[`shared-modules.js`](../packages/tacphone-build/shared-modules.js), which also
generates the host import map:

```ts
import { SHARED_MODULE_SPECIFIERS } from '@ace-tacphone/build/shared-modules';

external: [...SHARED_MODULE_SPECIFIERS],
output: {
    codeSplitting: false,
}
```

The build runs `tacphone-build check-shared-imports` afterwards and fails if the
bundle contains a bare import that the host does not provide.

This is a packaging choice for the Map app, not a hard limitation of the host.
Extra JavaScript or CSS files can be shipped separately and loaded on demand
with `window.TacPhone.networking.LoadGameFileText`; see
[Loading additional files manually](../ACE_TacPhone_Main/README.md#loading-additional-files-manually).
The trade-off is an extra game-filesystem read before the module or stylesheet
can be used, so cache the loaded file. A relative `.js` import from the entry
bundle still cannot resolve next to the blob URL.
