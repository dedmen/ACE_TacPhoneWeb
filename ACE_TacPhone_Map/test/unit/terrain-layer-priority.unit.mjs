/**
 * Unit tests for terrain layer ordering and LOD planning
 * (`planTerrainLayers` in `layers/TerrainLayerPriority.ts`).
 *
 * The game sends one standalone SVG per terrain layer and the Map decodes them
 * in this order, so the ranks here are the contract: terrain first, then roads,
 * town names, airports, forests, rocks and mountains, then unknown layers, and
 * the element-heavy `objects`/`countlines` last. The same plan decides the view
 * resolution at which a layer stops being drawn, which is the only tuning point
 * for zoom-out cost.
 *
 * The module is pure (no OpenLayers, no DOM), so the whole table is pinned here
 * instead of being inferred from a live map. Every case names the rule it pins.
 */

import { equal, ok, fail } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    COUNTLINES_LOD_MAX_RESOLUTION,
    HEAVY_LAYER_SVG_CHARS,
    HEAVY_UNKNOWN_LOD_MAX_RESOLUTION,
    MOUNTAINS_LOD_MAX_RESOLUTION,
    OBJECTS_LOD_MAX_RESOLUTION,
    planTerrainLayers,
} from '../../src/layers/TerrainLayerPriority.ts';

export const name = 'terrain-layer-priority';
export const description = 'terrain layer rank/LOD planning';

const ALWAYS_VISIBLE = Number.POSITIVE_INFINITY;

/** A `TerrainLayer` with a small SVG unless the case needs a huge one. */
function layer(name, svg = '<svg></svg>') {
    return { name, svg };
}

/** Plans the given names in the given input order (a tiny SVG each). */
function planNames(...names) {
    return planTerrainLayers(names.map((layerName) => layer(layerName)));
}

/** Returns the planned layer with this exact name, or fails loudly. */
function findPlan(plans, layerName) {
    const plan = plans.find((candidate) => candidate.name === layerName);

    if (!plan) {
        fail(
            `expected a plan for layer "${layerName}", got ${JSON.stringify(plans.map((p) => p.name))}`,
        );
    }

    return plan;
}

/** Asserts the planned names are exactly `expected`, in order. */
function expectNames(plans, expected, message) {
    const actual = plans.map((plan) => plan.name);

    ok(
        actual.length === expected.length
            && actual.every((planned, index) => planned === expected[index]),
        `${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
}

/** Asserts one planned layer's rank/LOD/heavy triple. */
function expectPlan(plan, { rank, maxResolution, heavy }, message) {
    equal(plan.rank, rank, `${message}: rank`);
    equal(plan.maxResolution, maxResolution, `${message}: maxResolution`);
    equal(plan.heavy, heavy, `${message}: heavy`);
}

export async function run() {
    // 1. Exact priority order. The input is in reverse document order, so a
    //    correct plan has to reorder everything and keep every index.
    const reversed = [
        'countlines',
        'objects',
        'mountains',
        'rocks',
        'forests',
        'airports',
        'townNames',
        'roads',
        'terrain',
    ];
    const ordered = planNames(...reversed);
    const expectedOrder = [
        'terrain',
        'roads',
        'townNames',
        'airports',
        'forests',
        'rocks',
        'mountains',
        'objects',
        'countlines',
    ];
    expectNames(ordered, expectedOrder, 'layers must be ordered by their documented rank');

    const documentedRanks = [0, 10, 20, 30, 40, 50, 60, 900, 1000];
    for (const [index, plan] of ordered.entries()) {
        equal(plan.rank, documentedRanks[index], `"${plan.name}" must have rank ${documentedRanks[index]}`);

        const previous = ordered[index - 1];
        ok(
            !previous || plan.rank > previous.rank,
            `ranks must be strictly ascending: "${plan.name}" (${plan.rank}) after ${
                previous ? `"${previous.name}" (${previous.rank})` : 'nothing'
            }`,
        );
        equal(
            plan.documentIndex,
            reversed.indexOf(plan.name),
            `"${plan.name}" must keep its original input index`,
        );
    }

    // The original indices are also descending here, which pins that the sort
    // uses the recorded index and not the position in the output array.
    equal(ordered[0].documentIndex, 8, 'terrain was the last input layer');
    equal(ordered[ordered.length - 1].documentIndex, 0, 'countlines was the first input layer');

    // 2. LOD constants: only the heavy layers get a finite cut-off.
    const lod = planNames('objects', 'countlines', 'terrain', 'roads', 'mountains', 'grid');
    expectPlan(
        findPlan(lod, 'objects'),
        { rank: 900, maxResolution: OBJECTS_LOD_MAX_RESOLUTION, heavy: true },
        'objects is heavy at the objects LOD',
    );
    expectPlan(
        findPlan(lod, 'countlines'),
        { rank: 1000, maxResolution: COUNTLINES_LOD_MAX_RESOLUTION, heavy: true },
        'countlines is heavy at the countlines LOD',
    );
    expectPlan(
        findPlan(lod, 'mountains'),
        { rank: 60, maxResolution: MOUNTAINS_LOD_MAX_RESOLUTION, heavy: false },
        'mountains is light but LOD-hidden at coarse zoom',
    );

    for (const lightName of ['terrain', 'roads', 'grid']) {
        const plan = findPlan(lod, lightName);
        equal(plan.maxResolution, ALWAYS_VISIBLE, `"${lightName}" must be visible at every resolution`);
        equal(plan.heavy, false, `"${lightName}" must not be decoded in the heavy phase`);
    }

    // 3. Aliases and normalization (lowercase + strip non-alphanumerics).
    const aliases = planNames(
        'Town Names',
        'town_labels',
        'Air',
        'contour-lines',
        'OBJECTS',
        'forest_01',
    );
    expectNames(
        aliases,
        ['Town Names', 'town_labels', 'Air', 'forest_01', 'OBJECTS', 'contour-lines'],
        'aliases must normalize into their documented ranks',
    );
    equal(findPlan(aliases, 'Town Names').rank, 20, '"Town Names" normalizes to "townnames"');
    equal(findPlan(aliases, 'town_labels').rank, 20, '"town_labels" normalizes to the "townlabels" exact alias');
    equal(findPlan(aliases, 'Air').rank, 30, '"Air" is an exact airport alias');
    equal(findPlan(aliases, 'contour-lines').rank, 1000, '"contour-lines" normalizes to "contourlines"');
    equal(findPlan(aliases, 'OBJECTS').rank, 900, '"OBJECTS" matches the "objects" exact alias case-insensitively');
    equal(findPlan(aliases, 'forest_01').rank, 40, '"forest_01" matches the "forest" substring token');

    // 4. Unknown layers sit after mountains and before the heavy layers.
    const unknowns = planNames('objects', 'Layer 3', 'mountains', 'grid');
    expectNames(
        unknowns,
        ['mountains', 'Layer 3', 'grid', 'objects'],
        'unknown layers sort after mountains, keep input order, and precede objects',
    );
    for (const unknownName of ['grid', 'Layer 3']) {
        expectPlan(
            findPlan(unknowns, unknownName),
            { rank: 100, maxResolution: ALWAYS_VISIBLE, heavy: false },
            `unknown layer "${unknownName}" is light and always visible`,
        );
    }

    // 5. An unknown layer above HEAVY_LAYER_SVG_CHARS becomes heavy.
    const lightSvg = '<svg></svg>';
    const hugeSvg = 'x'.repeat(HEAVY_LAYER_SVG_CHARS + 1);
    const sized = planTerrainLayers([
        layer('terrain', hugeSvg),
        layer('grid', lightSvg),
        layer('Layer 3', hugeSvg),
        layer('objects', lightSvg),
    ]);
    expectNames(
        sized,
        ['terrain', 'grid', 'Layer 3', 'objects'],
        'a size-heavy unknown layer sorts after the light ones and before objects',
    );
    expectPlan(
        findPlan(sized, 'Layer 3'),
        {
            rank: 100,
            maxResolution: HEAVY_UNKNOWN_LOD_MAX_RESOLUTION,
            heavy: true,
        },
        'a big unknown layer is treated as heavy',
    );
    expectPlan(
        findPlan(sized, 'grid'),
        { rank: 100, maxResolution: ALWAYS_VISIBLE, heavy: false },
        'a small unknown layer stays light',
    );
    expectPlan(
        findPlan(sized, 'terrain'),
        { rank: 0, maxResolution: ALWAYS_VISIBLE, heavy: false },
        'a known light layer is never reclassified by SVG size',
    );

    // 6. Stability and no mutation of the input array.
    const input = [layer('Layer 3'), layer('grid')];
    const stable = planTerrainLayers(input);
    expectNames(stable, ['Layer 3', 'grid'], 'equal ranks keep the input order');
    equal(stable[0].documentIndex, 0, 'the first unknown layer keeps index 0');
    equal(stable[1].documentIndex, 1, 'the second unknown layer keeps index 1');
    ok(stable !== input, 'the plan is a new array, not the input');
    equal(input.length, 2, 'the input array must not gain or lose entries');
    equal(input[0].name, 'Layer 3', 'the input array must not be reordered');
    equal(input[1].name, 'grid', 'the input array must not be reordered');

    // 7. No layers is an empty plan, not an error.
    const empty = planTerrainLayers([]);
    ok(Array.isArray(empty), 'an empty input must return an array');
    equal(empty.length, 0, 'an empty input must return an empty plan');
}
