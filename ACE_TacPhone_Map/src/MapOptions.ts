// Options the Map app exposes in the host Options panel.
//
// The defaults are the balanced profile; the tile size follows the device class
// (256 mobile, 512 otherwise). Presets are stateless shortcuts that write several
// individual values at once.

import type { AppOptionDefinition, AppOptionPreset } from "@ace-tacphone/api";
import { t } from './i18n';

/** App name used as the options registration key. */
export const MAP_APP = "ACE_TacPhone_Map";

export const MAP_OPTION_KEYS = {
    terrainQuality: "terrainQuality",
    tileSize: "tileSize",
    tileCacheSize: "tileCacheSize",
    pixelRatio: "pixelRatio",
    tilePreload: "tilePreload",
    smoothScaling: "smoothScaling",
    gpsRotateWithPlayer: "gpsRotateWithPlayer",
    gpsAutoRepath: "gpsAutoRepath",
    gpsUpdateRate: "gpsUpdateRate",
} as const;

/** GPS push rates (Hz) the game accepts; the web select offers exactly these. */
export const GPS_UPDATE_RATES = [10, 30] as const;

export type GpsUpdateRate = (typeof GPS_UPDATE_RATES)[number];

/** GPS settings read from the shared Map option schema. */
export interface GpsSettings {
    rotateWithPlayer: boolean;
    autoRepath: boolean;
    /** GPS.Update push rate in Hz sent to the game (10 or 30). */
    updateRate: GpsUpdateRate;
}

export function readGpsSettings(): GpsSettings {
    const rotate = window.TacPhone.options.get<unknown>(MAP_APP, MAP_OPTION_KEYS.gpsRotateWithPlayer);
    const auto = window.TacPhone.options.get<unknown>(MAP_APP, MAP_OPTION_KEYS.gpsAutoRepath);
    const rate = window.TacPhone.options.get<unknown>(MAP_APP, MAP_OPTION_KEYS.gpsUpdateRate);

    return {
        rotateWithPlayer: typeof rotate === "boolean" ? rotate : true,
        autoRepath: typeof auto === "boolean" ? auto : false,
        updateRate: typeof rate === "number" && (GPS_UPDATE_RATES as readonly number[]).includes(rate)
            ? rate as GpsUpdateRate
            : 10,
    };
}

export function onGpsSettingsChanged(listener: (settings: GpsSettings) => void): () => void {
    return window.TacPhone.options.onDidChange(change => {
        if (change.app === MAP_APP)
            listener(readGpsSettings());
    });
}

/**
 * Terrain tile edge in CSS pixels.
 *
 * Measured with `test/benchmark/tile-size.mjs` (24k-path, 2.9 MiB synthetic
 * layer, headless Chrome): filling a 1280x900 viewport took ~98 ms at 128 px,
 * ~35 ms at 256 px and ~16 ms at 512 px; a phone viewport took ~30/11/6 ms.
 * The first tile crop stayed within 1.3-2.2 ms for all sizes.
 *
 * 256 is the mobile default; 512 is the desktop default. 1024 is available as a
 * manual choice but is never selected automatically: there is no reliable
 * "performant computer" signal in the browser. These are only defaults for the
 * `tileSize` option; a stored option always wins.
 */
const DEFAULT_TERRAIN_TILE_SIZE_MOBILE = 256;
const DEFAULT_TERRAIN_TILE_SIZE_DESKTOP = 512;

/** Tile sizes the option accepts. */
export const TERRAIN_TILE_SIZE_CHOICES = [256, 512, 1024] as const;

/**
 * True for a phone/tablet-style pointer or a small touch screen. A touch-screen
 * laptop keeps its fine pointer and therefore stays on the desktop default.
 */
export function isMobileDevice(): boolean {
    const coarsePointer = typeof window.matchMedia === "function"
        && window.matchMedia("(pointer: coarse)").matches;
    const touch = typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 0;
    const smallScreen = Math.min(window.screen?.width ?? 0, window.screen?.height ?? 0) < 768;

    return coarsePointer || (touch && smallScreen);
}

/** The default tile size for this device (256 mobile, 512 otherwise). */
export function defaultTerrainTileSize(): number {
    return isMobileDevice()
        ? DEFAULT_TERRAIN_TILE_SIZE_MOBILE
        : DEFAULT_TERRAIN_TILE_SIZE_DESKTOP;
}

/** Tile edge the `tileCacheSize` option was designed for. */
const TILE_CACHE_REFERENCE_SIZE = 128;

/**
 * Keeps the cache option's memory footprint roughly flat when the tile size
 * changes: a 256 px tile is four times as large as a 128 px tile.
 */
export function effectiveTileCacheSize(
    requestedTiles: number,
    tileSize: number,
): number {
    const scale = (TILE_CACHE_REFERENCE_SIZE / tileSize) ** 2;
    return Math.min(512, Math.max(8, Math.round(requestedTiles * scale)));
}

export type TerrainQuality = "low" | "balanced" | "high";
export type PixelRatioChoice = "device" | "1.5" | "1";

interface QualityProfile {
    /** Number of tile-grid zoom levels above the finest resolution. */
    maxZoom: number;
    /** Most zoomed-in resolution, in map units per pixel. */
    minResolution: number;
}

const QUALITY_PROFILES: Record<TerrainQuality, QualityProfile> = {
    low: { maxZoom: 4, minResolution: 0.5 },
    balanced: { maxZoom: 5, minResolution: 0.2 },
    high: { maxZoom: 6, minResolution: 0.1 },
};

/** Resolved settings the Map applies to its OpenLayers view and tile layers. */
export interface MapRenderSettings {
    terrainQuality: TerrainQuality;
    maxZoom: number;
    minResolution: number;
    tileSize: number;
    tileCacheSize: number;
    /** Effective device pixel ratio cap, already resolved from the choice. */
    pixelRatio: number;
    tilePreload: number;
    smoothScaling: boolean;
}

const MAP_OPTIONS = (): readonly AppOptionDefinition[] => [
    {
        key: MAP_OPTION_KEYS.terrainQuality,
        label: t('STR_ACE_Tacphone_Map_Options_TerrainQuality_Label'),
        description: t('STR_ACE_Tacphone_Map_Options_TerrainQuality_Desc'),
        type: "select",
        default: "balanced",
        choices: [
            { label: t('STR_ACE_Tacphone_Map_Options_TerrainQuality_Low'), value: "low" },
            { label: t('STR_ACE_Tacphone_Map_Options_TerrainQuality_Balanced'), value: "balanced" },
            { label: t('STR_ACE_Tacphone_Map_Options_TerrainQuality_High'), value: "high" },
        ],
    },
    {
        key: MAP_OPTION_KEYS.tileSize,
        label: t('STR_ACE_Tacphone_Map_Options_TileSize_Label'),
        description: t('STR_ACE_Tacphone_Map_Options_TileSize_Desc'),
        type: "select",
        default: defaultTerrainTileSize(),
        choices: [
            { label: t('STR_ACE_Tacphone_Map_Options_TileSize_256'), value: 256 },
            { label: t('STR_ACE_Tacphone_Map_Options_TileSize_512'), value: 512 },
            { label: t('STR_ACE_Tacphone_Map_Options_TileSize_1024'), value: 1024 },
        ],
    },
    {
        key: MAP_OPTION_KEYS.tileCacheSize,
        label: t('STR_ACE_Tacphone_Map_Options_TileCache_Label'),
        description: t('STR_ACE_Tacphone_Map_Options_TileCache_Desc'),
        type: "select",
        default: 48,
        choices: [
            { label: t('STR_ACE_Tacphone_Map_Options_TileCache_16'), value: 16 },
            { label: t('STR_ACE_Tacphone_Map_Options_TileCache_48'), value: 48 },
            { label: t('STR_ACE_Tacphone_Map_Options_TileCache_128'), value: 128 },
        ],
    },
    {
        key: MAP_OPTION_KEYS.pixelRatio,
        label: t('STR_ACE_Tacphone_Map_Options_PixelRatio_Label'),
        description: t('STR_ACE_Tacphone_Map_Options_PixelRatio_Desc'),
        type: "select",
        default: "device",
        choices: [
            { label: t('STR_ACE_Tacphone_Map_Options_PixelRatio_Device'), value: "device" },
            { label: t('STR_ACE_Tacphone_Map_Options_PixelRatio_1_5'), value: "1.5" },
            { label: t('STR_ACE_Tacphone_Map_Options_PixelRatio_1'), value: "1" },
        ],
    },
    {
        key: MAP_OPTION_KEYS.tilePreload,
        label: t('STR_ACE_Tacphone_Map_Options_TilePreload_Label'),
        description: t('STR_ACE_Tacphone_Map_Options_TilePreload_Desc'),
        type: "select",
        default: 0,
        choices: [
            { label: t('STR_ACE_Tacphone_Map_Options_TilePreload_0'), value: 0 },
            { label: t('STR_ACE_Tacphone_Map_Options_TilePreload_1'), value: 1 },
            { label: t('STR_ACE_Tacphone_Map_Options_TilePreload_2'), value: 2 },
        ],
    },
    {
        key: MAP_OPTION_KEYS.smoothScaling,
        label: t('STR_ACE_Tacphone_Map_Options_SmoothScaling_Label'),
        description: t('STR_ACE_Tacphone_Map_Options_SmoothScaling_Desc'),
        type: "boolean",
        default: true,
    },
    {
        key: MAP_OPTION_KEYS.gpsRotateWithPlayer,
        label: t('STR_ACE_Tacphone_Map_Gps_Options_RotateWithPlayer_Label'),
        description: t('STR_ACE_Tacphone_Map_Gps_Options_RotateWithPlayer_Desc'),
        type: "boolean",
        default: true,
    },
    {
        key: MAP_OPTION_KEYS.gpsAutoRepath,
        label: t('STR_ACE_Tacphone_Map_Gps_Options_AutoRepath_Label'),
        description: t('STR_ACE_Tacphone_Map_Gps_Options_AutoRepath_Desc'),
        type: "boolean",
        default: false,
    },
    {
        key: MAP_OPTION_KEYS.gpsUpdateRate,
        label: t('STR_ACE_Tacphone_Map_Gps_Options_UpdateRate_Label'),
        description: t('STR_ACE_Tacphone_Map_Gps_Options_UpdateRate_Desc'),
        type: "select",
        default: 10,
        choices: [
            { label: t('STR_ACE_Tacphone_Map_Gps_Options_UpdateRate_10'), value: 10 },
            { label: t('STR_ACE_Tacphone_Map_Gps_Options_UpdateRate_30'), value: 30 },
        ],
    },
];

const MAP_PRESETS = (): readonly AppOptionPreset[] => [
    {
        id: "weak",
        label: t('STR_ACE_Tacphone_Map_Preset_Weak_Label'),
        description: t('STR_ACE_Tacphone_Map_Preset_Weak_Desc'),
        values: {
            [MAP_OPTION_KEYS.terrainQuality]: "low",
            [MAP_OPTION_KEYS.tileSize]: 256,
            [MAP_OPTION_KEYS.tileCacheSize]: 16,
            [MAP_OPTION_KEYS.pixelRatio]: "1",
            [MAP_OPTION_KEYS.tilePreload]: 0,
            [MAP_OPTION_KEYS.smoothScaling]: false,
        },
    },
    {
        id: "balanced",
        label: t('STR_ACE_Tacphone_Map_Preset_Balanced_Label'),
        description: t('STR_ACE_Tacphone_Map_Preset_Balanced_Desc'),
        values: {
            [MAP_OPTION_KEYS.terrainQuality]: "balanced",
            [MAP_OPTION_KEYS.tileSize]: defaultTerrainTileSize(),
            [MAP_OPTION_KEYS.tileCacheSize]: 48,
            [MAP_OPTION_KEYS.pixelRatio]: "device",
            [MAP_OPTION_KEYS.tilePreload]: 0,
            [MAP_OPTION_KEYS.smoothScaling]: true,
        },
    },
    {
        id: "desktop",
        label: t('STR_ACE_Tacphone_Map_Preset_Desktop_Label'),
        description: t('STR_ACE_Tacphone_Map_Preset_Desktop_Desc'),
        values: {
            [MAP_OPTION_KEYS.terrainQuality]: "high",
            [MAP_OPTION_KEYS.tileSize]: 512,
            [MAP_OPTION_KEYS.tileCacheSize]: 128,
            [MAP_OPTION_KEYS.pixelRatio]: "device",
            [MAP_OPTION_KEYS.tilePreload]: 2,
            [MAP_OPTION_KEYS.smoothScaling]: true,
        },
    },
];

/** Registers the Map option schema; called once from the app's init(). */
export function registerMapOptions(): void {
    window.TacPhone.options.register({
        app: MAP_APP,
        title: t('str_a3_map1'),
        options: MAP_OPTIONS(),
        presets: MAP_PRESETS(),
    });
}

function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const value = window.TacPhone.options.get<unknown>(MAP_APP, key);
    return typeof value === "string" && (allowed as readonly string[]).includes(value)
        ? value as T
        : fallback;
}

function readNumber(key: string, fallback: number): number {
    const value = window.TacPhone.options.get<unknown>(MAP_APP, key);
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Reads and validates the current Map settings. */
export function readMapRenderSettings(): MapRenderSettings {
    const terrainQuality = readChoice<TerrainQuality>(
        MAP_OPTION_KEYS.terrainQuality,
        ["low", "balanced", "high"],
        "balanced",
    );
    const profile = QUALITY_PROFILES[terrainQuality];

    const tileCacheSize = readNumber(MAP_OPTION_KEYS.tileCacheSize, 48);
    const requestedTileSize = readNumber(MAP_OPTION_KEYS.tileSize, defaultTerrainTileSize());
    const tileSize = (TERRAIN_TILE_SIZE_CHOICES as readonly number[]).includes(requestedTileSize)
        ? requestedTileSize
        : defaultTerrainTileSize();
    const tilePreload = readNumber(MAP_OPTION_KEYS.tilePreload, 0);
    const pixelRatioChoice = readChoice<PixelRatioChoice>(
        MAP_OPTION_KEYS.pixelRatio,
        ["device", "1.5", "1"],
        "device",
    );
    const smoothScaling = window.TacPhone.options.get<unknown>(MAP_APP, MAP_OPTION_KEYS.smoothScaling);

    const devicePixelRatio = typeof window.devicePixelRatio === "number" && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
    const pixelRatio = pixelRatioChoice === "1"
        ? 1
        : pixelRatioChoice === "1.5"
            ? Math.min(devicePixelRatio, 1.5)
            : devicePixelRatio;

    return {
        terrainQuality,
        maxZoom: profile.maxZoom,
        minResolution: profile.minResolution,
        tileSize,
        tileCacheSize: effectiveTileCacheSize(tileCacheSize, tileSize),
        pixelRatio: Math.max(1, pixelRatio),
        tilePreload: Math.min(2, Math.max(0, Math.round(tilePreload))),
        smoothScaling: typeof smoothScaling === "boolean" ? smoothScaling : true,
    };
}

/** Calls `listener` with fresh settings after any Map option changes. */
export function onMapRenderSettingsChanged(listener: (settings: MapRenderSettings) => void): () => void {
    return window.TacPhone.options.onDidChange(change => {
        if (change.app === MAP_APP)
            listener(readMapRenderSettings());
    });
}
