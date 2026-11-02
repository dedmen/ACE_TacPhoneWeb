/**
 * Formatting helpers for GPS route text.
 *
 * Units are intentionally not translated and are not stringtable keys: `m`,
 * `km` and the `·` separator are symbols, not words. The mode name and
 * waypoint-count word are passed in already localized.
 */

import { t } from '../i18n';

/** Distance with an untranslated unit: `850 m`, `12.4 km`. */
export function formatDistance(metres: number): string {
    if (!Number.isFinite(metres) || metres <= 0) {
        return '0 m';
    }
    if (metres >= 1000) {
        return `${(metres / 1000).toFixed(1)} km`;
    }
    return `${Math.round(metres)} m`;
}

/** Shared-route summary: mode · distance · waypoint count, no translatable text. */
export function formatSharedSummary(
    mode: string,
    metres: number,
    waypointCount: string,
): string {
    return `${mode} · ${formatDistance(metres)} · ${waypointCount}`;
}

/**
 * Travel time: `M:SS` under one hour, whole hours plus minutes above it
 * (`3h 54m`). `--` when no estimate is available.
 */
export function formatDuration(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
        return t('STR_WI_ARTI_TIME_NA');
    }

    const total = Math.max(1, Math.round(seconds));
    if (total >= 3600) {
        return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
    }
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
