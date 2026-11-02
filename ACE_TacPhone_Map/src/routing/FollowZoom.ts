/**
 * Follow zoom: the map shows roughly the distance the player covers in one
 * minute, and never less than a small local radius while standing still.
 *
 * These helpers are pure so the zoom rule is testable without a map.
 */

/** Distance the player covers in the visible radius, seconds. */
export const FOLLOW_LOOKAHEAD_SECONDS = 60;

/** Visible radius while standing still, metres. */
export const FOLLOW_STATIONARY_RADIUS_M = 200;

/**
 * Visible radius around the player, metres. The map always shows at least
 * {@link FOLLOW_STATIONARY_RADIUS_M}, even when the fix reports no speed.
 */
export function followRadius(speed: number): number {
    const moving = Number.isFinite(speed) && speed > 0 ? speed : 0;
    return Math.max(FOLLOW_STATIONARY_RADIUS_M, moving * FOLLOW_LOOKAHEAD_SECONDS);
}

/**
 * Resolution that makes {@link followRadius} reach the edge of the shorter
 * viewport side, clamped to the view's own resolution limits.
 *
 * Returns null when the viewport or resolution limits are unusable.
 */
export function followResolution(
    speed: number,
    viewportPixels: number,
    minResolution: number,
    maxResolution: number,
    radius = followRadius(speed),
): number | null {
    if (!(viewportPixels > 0) || !(minResolution > 0) || !(maxResolution > minResolution)) {
        return null;
    }

    // Half of the shorter side is the visible radius; the full side spans the
    // diameter.
    const target = (radius * 2) / viewportPixels;
    return Math.min(maxResolution, Math.max(minResolution, target));
}
