// Layer ordering and level-of-detail planning for the terrain SVG layers.
//
// The Map receives one standalone SVG per terrain layer from the game. Some of
// those layers (terrain, roads) are cheap and useful at every zoom, while others
// (objects, contour lines) are element-heavy and invisible at a whole-map view,
// and `mountains` has small labels that are unreadable when zoomed out. This
// module only decides the order in which layers are decoded/added and the view
// resolution at which a layer is no longer drawn. It intentionally does not
// import OpenLayers or touch the DOM, so the unit tier can run it in plain Node.
//
// The LOD values below are the single tuning point. They are physical view
// resolutions (map units per pixel), not tile zoom levels, so they stay
// meaningful when the `low`/`balanced`/`high` quality profiles change the
// coarsest resolution.

import type { TerrainLayer } from '@ace-tacphone/api';

/**
 * The `objects` layer is hidden when the view resolution is at or above this
 * value (map units per pixel).
 *
 * - lower  -> objects disappear earlier when zooming out (faster);
 * - higher -> objects stay visible longer (more SVG work).
 */
export const OBJECTS_LOD_MAX_RESOLUTION = 8;

/** Same for `countlines` (contour/height lines). */
export const COUNTLINES_LOD_MAX_RESOLUTION = 8;

/**
 * The `mountains` layer carries a lot of small labels. They are unreadable at a
 * whole-map view, so the layer is hidden at coarse zoom even though it is cheap
 * to decode.
 */
export const MOUNTAINS_LOD_MAX_RESOLUTION = 6;

/**
 * An unknown-named layer whose SVG is at least this many characters is treated
 * as heavy: decoded last and hidden at coarse zoom. Known light layers are
 * never reclassified by size, so a large terrain SVG still renders first.
 */
export const HEAVY_LAYER_SVG_CHARS = 4 * 1024 * 1024;

/** LOD cap applied to an unknown layer above `HEAVY_LAYER_SVG_CHARS`. */
export const HEAVY_UNKNOWN_LOD_MAX_RESOLUTION = 6;

/** Rank used for layers that match no rule. */
const UNKNOWN_RANK = 100;

/** Ranks at or above this are heavy (decoded in phase B, LOD-gated). */
const HEAVY_RANK = 900;

/** A layer is always visible; `Layer.inView()` hides it at `resolution >= maxResolution`. */
const ALWAYS_VISIBLE = Number.POSITIVE_INFINITY;

/** One terrain layer after ordering and LOD classification. */
export interface TerrainLayerPlan {
    /** Layer name as it came from the host (used for the title and the debug state). */
    name: string;
    /** Original index in `terrain.layers`; drives the fractional zIndex. */
    documentIndex: number;
    /** Lower is decoded and added first. */
    rank: number;
    /** LOD: hidden when the view resolution is at or above this value. */
    maxResolution: number;
    /** Decoded and added in phase B instead of phase A. */
    heavy: boolean;
}

interface LayerRule {
    rank: number;
    maxResolution: number;
    /** Exact normalized names; short/ambiguous strings are only matched exactly. */
    exact: readonly string[];
    /** Substring tokens that are unambiguous enough to match longer names. */
    contains: readonly string[];
}

const LAYER_RULES: readonly LayerRule[] = [
    {
        rank: 0,
        maxResolution: ALWAYS_VISIBLE,
        exact: ['terrain', 'land'],
        contains: ['terrain'],
    },
    {
        rank: 10,
        maxResolution: ALWAYS_VISIBLE,
        exact: ['roads', 'road'],
        contains: ['roads'],
    },
    {
        rank: 20,
        maxResolution: ALWAYS_VISIBLE,
        exact: ['townnames', 'townname', 'town', 'townlabels', 'townlabelslayer'],
        contains: ['townname', 'townlabel'],
    },
    {
        rank: 30,
        maxResolution: ALWAYS_VISIBLE,
        exact: ['airports', 'airport', 'airfield', 'airfields', 'air'],
        contains: ['airport', 'airfield'],
    },
    {
        rank: 40,
        maxResolution: ALWAYS_VISIBLE,
        exact: ['forests', 'forest'],
        contains: ['forest'],
    },
    {
        rank: 50,
        maxResolution: ALWAYS_VISIBLE,
        exact: ['rocks', 'rock'],
        contains: ['rocks'],
    },
    {
        rank: 60,
        maxResolution: MOUNTAINS_LOD_MAX_RESOLUTION,
        exact: ['mountains', 'mountain'],
        contains: ['mountain'],
    },
    {
        rank: UNKNOWN_RANK,
        maxResolution: ALWAYS_VISIBLE,
        exact: [],
        contains: [],
    },
    {
        rank: 900,
        maxResolution: OBJECTS_LOD_MAX_RESOLUTION,
        exact: ['objects', 'object'],
        contains: ['objects'],
    },
    {
        rank: 1000,
        maxResolution: COUNTLINES_LOD_MAX_RESOLUTION,
        exact: ['countlines', 'countline', 'contours', 'contour', 'contourlines'],
        contains: ['countline', 'contour'],
    },
];

const UNKNOWN_RULE = LAYER_RULES.find((rule) => rule.rank === UNKNOWN_RANK) as LayerRule;

/** Lowercases and removes separators so `Town Names` matches `townnames`. */
function normalizeLayerName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Finds the rule for a layer name; exact matches are checked before substrings. */
function matchRule(name: string): LayerRule {
    const normalized = normalizeLayerName(name);

    for (const rule of LAYER_RULES) {
        if (rule.exact.includes(normalized)) {
            return rule;
        }
    }

    for (const rule of LAYER_RULES) {
        if (rule.contains.some((token) => normalized.includes(token))) {
            return rule;
        }
    }

    return UNKNOWN_RULE;
}

/**
 * Plans one terrain layer. `documentIndex` is its position in the terrain
 * document and also drives its zIndex.
 */
export function planTerrainLayer(
    layer: TerrainLayer,
    documentIndex: number,
): TerrainLayerPlan {
    const rule = matchRule(layer.name);
    const heavyBySize = rule.rank === UNKNOWN_RANK
        && layer.svg.length >= HEAVY_LAYER_SVG_CHARS;

    return {
        name: layer.name,
        documentIndex,
        rank: rule.rank,
        maxResolution: heavyBySize
            ? HEAVY_UNKNOWN_LOD_MAX_RESOLUTION
            : rule.maxResolution,
        heavy: rule.rank >= HEAVY_RANK || heavyBySize,
    };
}

/**
 * Orders terrain layers by loading priority and assigns their LOD cut-off.
 *
 * Terrain first, then roads, town names, airports, forests, rocks and mountains.
 * `objects` and `countlines` come last because their SVGs re-rasterize the
 * slowest. Unknown layers sort after mountains and before the heavy ones; an
 * unknown layer above `HEAVY_LAYER_SVG_CHARS` is treated as heavy.
 *
 * The input array is never mutated; the returned array is a new one.
 */
export function planTerrainLayers(
    layers: readonly TerrainLayer[],
): TerrainLayerPlan[] {
    return layers
        .map((layer, documentIndex) => planTerrainLayer(layer, documentIndex))
        .sort((left, right) => left.rank - right.rank || left.documentIndex - right.documentIndex);
}
