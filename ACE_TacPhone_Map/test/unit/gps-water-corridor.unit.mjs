/**
 * Unit tests for the foot water-corridor helpers (`routing/WaterCorridor.ts`).
 *
 * These cover the pure part of the avoidable-swim fix: finding water runs,
 * extending them to dry endpoints, bounding the fine corridor, and rejecting
 * detours that are worse than a short swim.
 */

import { equal, ok } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    corridorBounds,
    extendRunToLand,
    findWaterRuns,
    mergeNearbyWaterRuns,
    pathLength,
    pointAt,
    splitPathAtWater,
    waterReplacementAcceptable,
} from '../../src/routing/WaterCorridor.ts';

export const name = 'gps-water-corridor';
export const description = 'water runs, dry endpoints, corridor bounds and detour guard';

const water = (x) => (x >= 120 && x <= 280 ? 'water' : 'land');

export function run() {
    // 1. A path crossing a water strip produces one run spanning the strip.
    const path = [0, 0, 100, 0, 200, 0, 300, 0, 400, 0];
    const runs = findWaterRuns(path, (x) => water(x), 10);
    equal(runs.length, 1, 'one water strip produces one run');
    equal(runs[0].startIndex, 1, 'the run starts at the vertex before the water');
    equal(runs[0].endIndex, 3, 'the run ends at the vertex after the water');
    ok(runs[0].waterDistance > 100, 'the run counts the water length, not the whole path');
    ok(runs[0].waterDistance < 200, 'the land parts of the run are not counted as water');

    // 2. Two water patches separated by a short land gap merge into one run.
    const gapPath = [0, 0, 100, 0, 150, 0, 170, 0, 250, 0, 300, 0];
    const gapWater = (x) => {
        if (x >= 100 && x <= 140) return 'water';
        if (x >= 170 && x <= 240) return 'water';
        return 'land';
    };
    const split = findWaterRuns(gapPath, gapWater, 1);
    equal(split.length, 2, 'a 20 m land gap initially keeps two runs');
    const merged = mergeNearbyWaterRuns(gapPath, split, 40);
    equal(merged.length, 1, 'a small land gap is merged');
    equal(merged[0].startIndex, 1, 'the merged run keeps the first start');

    // 3. Endpoints move outward out of water so the replacement can start dry.
    const wetEnds = [0, 0, 100, 0, 200, 0, 300, 0, 400, 0];
    const wetRun = { startIndex: 1, endIndex: 2, waterDistance: 100 };
    const dryWater = (x) => (x >= 100 && x <= 200 ? 'water' : 'land');
    const extended = extendRunToLand(wetEnds, wetRun, dryWater);
    ok(extended !== null, 'a run with dry land on both sides is repairable');
    equal(extended.startIndex, 0, 'the start moves to the last dry vertex');
    equal(extended.endIndex, 3, 'the end moves to the first dry vertex');

    // An island endpoint cannot be repaired; it must stay a swim.
    const island = [0, 0, 100, 0];
    const allWater = () => 'water';
    equal(
        extendRunToLand(island, { startIndex: 0, endIndex: 0, waterDistance: 100 }, allWater),
        null,
        'a water start/end is not repairable',
    );

    // 4. The corridor box covers the run and the requested margin.
    const bounds = corridorBounds(path, { startIndex: 1, endIndex: 3, waterDistance: 160 }, 250);
    equal(bounds[0], -150, 'west bound includes the margin');
    equal(bounds[1], -250, 'south bound includes the margin');
    equal(bounds[2], 550, 'east bound includes the margin');
    equal(bounds[3], 250, 'north bound includes the margin');

    // 5. Short land detours win; an absurd detour keeps the swim.
    ok(
        waterReplacementAcceptable(150, 60, 200, 300, 120),
        'a 300 m walk replacing a 120 m swim is accepted',
    );
    ok(
        waterReplacementAcceptable(550, 390, 1500, 1450, 80),
        'a land path no longer than the original span is accepted',
    );
    ok(
        waterReplacementAcceptable(540, 360, 300, 900, 200),
        'a faster walk replacing a long swim is accepted',
    );
    ok(
        !waterReplacementAcceptable(285, 512, 300, 900, 200),
        'a much slower walk must not replace a fast swim',
    );
    ok(
        !waterReplacementAcceptable(150, 60, 200, 4000, 120),
        'a 4 km detour around a 120 m swim is rejected',
    );
    ok(
        !waterReplacementAcceptable(150, 2000, 200, 300, 120),
        'a replacement much slower than the swim is rejected',
    );

    // 6. Path helpers use vertex indices, not metres.
    equal(pathLength([0, 0, 30, 40, 30, 60], 0, 2), 70, 'path length sums the vertex segments');
    equal(pointAt([10, 20, 30, 40], 1)[0], 30, 'pointAt reads the selected vertex');

    // 7. A long simplified segment is split at the coast before repair.
    const longSegment = [0, 0, 400, 0];
    const splitPath = splitPathAtWater(longSegment, (x) => water(x), 10);
    const splitRuns = findWaterRuns(splitPath, (x) => water(x), 10);
    equal(splitRuns.length, 1, 'the split path still has one water run');
    const startX = pointAt(splitPath, splitRuns[0].startIndex)[0];
    const endX = pointAt(splitPath, splitRuns[0].endIndex)[0];
    ok(startX >= 110 && startX <= 120, 'the run starts at the coast, not at x=0');
    ok(endX >= 280 && endX <= 290, 'the run ends at the far coast, not at x=400');
}
