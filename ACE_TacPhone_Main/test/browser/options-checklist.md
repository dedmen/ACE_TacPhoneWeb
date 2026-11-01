# Options panel browser checklist

These checks need the TacPhone host page open in a browser (in-game or an
external browser) and a running mission. They complement the Node suite in
`../run-tests.mjs`, which covers the game-facing persistence protocol only.

Run the Node suite first, then this checklist. Keep DevTools open for warnings.

## 0. Prerequisites

- [ ] Arma is running with the current TacPhone PBO.
- [ ] The TacPhone page is open; the app chooser is visible.
- [ ] The browser console shows no uncaught errors on boot or StrictMode
      double-mount.
- [ ] There is **no gear/Options button** in the tab toolbar. The only entry
      point is the app chooser tile.

## 1. Discovery and layout

- [ ] Open the app chooser and find the **Options** tile.
- [ ] Open it.
      Expected: a two-column panel with an app sidebar on the left and the
      selected app's options on the right. No toolbar button opens it.
- [ ] Select **Map** in the sidebar.
      Expected: five options (Terrain detail, Tile cache, Pixel ratio,
      Tile preload, Smooth scaling) and three preset buttons (Weak phone,
      Balanced, Desktop).
- [ ] Squeeze the panel narrow.
      Expected: option rows stack vertically, controls stay inside the panel, and
      the panel scrolls internally instead of making the document scroll.

## 2. Defaults and presets

- [ ] On a fresh layout with no stored options, confirm the values match the
      old hard-coded Map behaviour and **Balanced** is highlighted.
- [ ] Select **Weak phone**.
      Expected: Terrain detail Low, Tile cache 16, Pixel ratio 1x, Tile preload
      0, Smooth scaling off. Weak phone is highlighted.
- [ ] Select **Desktop**.
      Expected: High detail, 128 cache, Device pixel ratio, preload 2, smoothing
      on. Desktop is highlighted.
- [ ] Change one individual option.
      Expected: no preset stays highlighted; the other values keep their
      selected preset values.
- [ ] Press **Reset**.
      Expected: every option returns to its default and Balanced is highlighted.

## 3. Live Map behaviour

- [ ] Put a Map panel and the Options panel side by side in one layout.
- [ ] Change Terrain detail from Balanced to Low, then High.
      Expected: the Map rebuilds its terrain tiles without requesting the terrain
      from the game again; panning and zooming still work.
- [ ] Change Terrain detail Low → Balanced → High.
      Expected: the map stays usable and the view is preserved when the current
      zoom is valid; otherwise it fits the terrain.
- [ ] Change Pixel ratio to 1x, then Device.
      Expected: the canvas gets visibly sharper/softer with no reload and no
      marker loss.
- [ ] Toggle Smooth scaling off and on.
      Expected: terrain scaling becomes nearest-neighbour/blocky, then smooth
      again.
- [ ] Change Tile preload and Tile cache.
      Expected: no console errors; map interaction remains responsive.
- [ ] While a Map panel is closed, change a Map option, then open the Map.
      Expected: the new value is applied on mount.

## 4. Persistence

### External browser (localStorage)

- [ ] Change a Map option and wait a moment.
- [ ] In DevTools, inspect `localStorage["tacphone.layout"]`.
      Expected: the JSON is a flexlayout envelope with a top-level `options`
      object containing `ACE_TacPhone_Map`.
- [ ] Reload the page.
      Expected: the same option values are shown and applied to the Map.
- [ ] Remove the `options` key from the stored JSON and reload.
      Expected: the old layout still loads, options fall back to defaults, and
      the next save adds `options` back.
- [ ] Open DevTools and register a temporary app's options:
      ```js
      window.TacPhone.options.register({
          app: 'ACE_TacPhone_Test',
          title: 'Test App',
          options: [{ key: 'flag', label: 'Test flag', type: 'boolean', default: true }],
      });
      ```
      Expected: **Test App** appears in the sidebar immediately; toggling it
      persists and survives a reload (the registration itself does not, which is
      expected — it is only supplied by a real app's `init()`).

### In-game browser (SaveLayout)

- [ ] Change a Map option, close the phone, reopen it.
      Expected: the values are restored.
- [ ] Restart the mission (or reload the phone page from the game).
      Expected: the values are restored from `profileNamespace`.
- [ ] With an external browser open on the same layout, verify both pages show
      the same stored values (the page-local registry is not synchronized live
      between separate pages, but the saved envelope is shared).

## 5. Regression checks

- [ ] Open two Options panels.
      Expected: both render the same values; changing one updates the other;
      there is one Map entry per panel, not duplicated registrations.
- [ ] Leave Options open while opening/closing a Map panel several times.
      Expected: no duplicate sidebar entries, no duplicate Map option schemas,
      and no console errors from StrictMode remounts.
- [ ] Restore marker updates and normal Map interaction after changing settings.
      Expected: markers, polylines, the layer switcher and the `map` service still
      work.
- [ ] Check the release build (no debug setting) has no test-only UI and still
      exposes the Options panel.
