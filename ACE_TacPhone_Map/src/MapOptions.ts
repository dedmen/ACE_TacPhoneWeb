// Options the Map app exposes in the host Options panel.
//
// The defaults reproduce the previous hard-coded tiling/rendering values, so an
// existing installation looks the same until a value is changed. Presets are
// stateless shortcuts that write several individual values at once.

import type { AppOptionDefinition, AppOptionPreset } from "@ace-tacphone/api";
import { t } from './i18n';

/** App name used as the options registration key. */
export const MAP_APP = "ACE_TacPhone_Map";

export const MAP_OPTION_KEYS = {
    terrainQuality: "terrainQuality",
    tileCacheSize: "tileCacheSize",
    pixelRatio: "pixelRatio",
    tilePreload: "tilePreload",
    smoothScaling: "smoothScaling",
} as const;

/** Fixed tile size: smaller tiles display the first terrain tile much faster. */
const TERRAIN_TILE_SIZE = 128;

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
];

const MAP_PRESETS = (): readonly AppOptionPreset[] => [
    {
        id: "weak",
        label: t('STR_ACE_Tacphone_Map_Preset_Weak_Label'),
        description: t('STR_ACE_Tacphone_Map_Preset_Weak_Desc'),
        values: {
            [MAP_OPTION_KEYS.terrainQuality]: "low",
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

    // Remove the old tile-size override; the tile size is now fixed.
    window.TacPhone.options.reset(MAP_APP, "tileSize");
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
        tileSize: TERRAIN_TILE_SIZE,
        tileCacheSize: Math.min(512, Math.max(1, Math.round(tileCacheSize))),
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
