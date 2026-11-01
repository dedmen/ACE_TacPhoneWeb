// Pure marker color/label helpers.
//
// They live outside `MarkerLayer.tsx` so the dialog, the layer and the
// debug-only test hook all resolve colors the same way, and so the resolution
// can be asserted without reading canvas pixels.

/** Color used when neither the CfgMarkerColors class nor the type resolves. */
export const DEFAULT_MARKER_COLOR = '#ffffff';

/**
 * Smallest alpha the UI lets a user pick. Markers must never become invisible,
 * so a transparent custom color is clamped instead of stored with alpha 0.
 */
export const MIN_MARKER_COLOR_ALPHA = 0.2;

/** Maximum length of the user-visible marker text/label. */
export const MAX_MARKER_TEXT_LENGTH = 256;

/** Parsed Arma custom marker color (`#(r,g,b,a)`), components in 0..1. */
export interface MarkerRgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

const CUSTOM_MARKER_COLOR = /^#\(\s*([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)(?:\s*,\s*([0-9]*\.?[0-9]+))?\s*\)$/;

function clampUnit(value: number): number {
    return Math.max(0, Math.min(1, value));
}

/**
 * Parses the Arma 2.20+ custom marker color format returned by `markerColor`
 * and accepted by `setMarkerColorLocal`: `#(r,g,b)` or `#(r,g,b,a)` with
 * components in 0..1.
 */
export function parseMarkerColor(value: string | undefined | null): MarkerRgba | undefined {
    if (typeof value !== 'string')
        return undefined;

    const match = CUSTOM_MARKER_COLOR.exec(value.trim());
    if (!match)
        return undefined;

    return {
        r: clampUnit(Number(match[1])),
        g: clampUnit(Number(match[2])),
        b: clampUnit(Number(match[3])),
        a: match[4] === undefined ? 1 : clampUnit(Number(match[4])),
    };
}

/** CSS color for a custom marker color, or undefined for a non-custom value. */
export function markerColorToCss(value: string | undefined | null): string | undefined {
    const rgba = parseMarkerColor(value);
    if (!rgba)
        return undefined;

    const channel = (component: number): number => Math.round(component * 255);
    return `rgba(${channel(rgba.r)}, ${channel(rgba.g)}, ${channel(rgba.b)}, ${rgba.a})`;
}

/**
 * CSS color with the same RGB channels but alpha 1.
 *
 * OpenLayers tints an icon by multiplying with the color, so a translucent tint
 * washes the icon toward white instead of making it transparent. The color
 * alpha is applied through `Icon.setOpacity` instead; this strips it from the
 * tint color.
 */
export function markerColorToOpaqueCss(value: string | undefined | null): string {
    if (typeof value !== 'string' || value === '')
        return DEFAULT_MARKER_COLOR;

    const trimmed = value.trim();
    const rgba = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*[0-9.]+)?\s*\)$/i.exec(trimmed);
    if (rgba) {
        return `rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})`;
    }

    const hex8 = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(trimmed);
    if (hex8) {
        return `#${hex8[1]}`;
    }

    const custom = parseMarkerColor(trimmed);
    if (custom) {
        return `rgb(${Math.round(custom.r * 255)}, ${Math.round(custom.g * 255)}, ${Math.round(custom.b * 255)})`;
    }

    return trimmed;
}

/** `#rrggbb` for an `<input type="color">`, preserving the custom color's RGB. */
export function markerColorToHex(value: string | undefined | null): string | undefined {
    const rgba = parseMarkerColor(value);
    if (!rgba)
        return undefined;

    const channel = (component: number): string => Math.round(component * 255).toString(16).padStart(2, '0');
    return `#${channel(rgba.r)}${channel(rgba.g)}${channel(rgba.b)}`;
}

/** Clamps an alpha to the range the UI may store: never fully transparent. */
export function clampMarkerAlpha(alpha: number): number {
    const value = Number.isFinite(alpha) ? alpha : 1;
    return Math.max(MIN_MARKER_COLOR_ALPHA, clampUnit(value));
}

/**
 * True for a CSS color whose RGB channels are all zero. Marker types commonly
 * use black as their `color[]`, and `CfgMarkerColors` also offers a black
 * class, so the dialog hides the virtual default instead of showing two black
 * swatches next to each other.
 */
export function isBlackMarkerColor(value: string | undefined | null): boolean {
    if (typeof value !== 'string')
        return false;

    const trimmed = value.trim();
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i.exec(trimmed);
    if (hex) {
        return Number.parseInt(hex[1], 16) === 0
            && Number.parseInt(hex[2], 16) === 0
            && Number.parseInt(hex[3], 16) === 0;
    }

    const rgb = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*[0-9.]+)?\s*\)$/i.exec(trimmed);
    if (rgb) {
        return Number(rgb[1]) === 0 && Number(rgb[2]) === 0 && Number(rgb[3]) === 0;
    }

    return trimmed === 'black';
}

/** Converts 0..255 RGB channels and a 0..1 alpha into the Arma custom format. */
export function rgbToMarkerColor(red: number, green: number, blue: number, alpha = 1): string {
    const channel = (component: number): string => {
        const value = Math.max(0, Math.min(255, Math.round(component))) / 255;
        return String(Math.round(value * 1000) / 1000);
    };

    return `#(${channel(red)},${channel(green)},${channel(blue)},${clampMarkerAlpha(alpha)})`;
}

/** Converts an `<input type="color">` value plus alpha into the Arma custom format. */
export function hexToMarkerColor(hex: string, alpha = 1): string | undefined {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!match)
        return undefined;

    return rgbToMarkerColor(
        Number.parseInt(match[1], 16),
        Number.parseInt(match[2], 16),
        Number.parseInt(match[3], 16),
        alpha,
    );
}

/**
 * True for the "use the marker type's own color" value. The game's
 * `CfgMarkerColors` also has a class named `Default`, but it is black; the web
 * UI always means "type default" by it.
 */
export function isDefaultMarkerColor(colorClassName: string | undefined | null): boolean {
    return colorClassName === undefined || colorClassName === null || colorClassName === '' || colorClassName === 'Default';
}

/**
 * Resolves the color a marker is drawn with.
 *
 * @param colorClassName CfgMarkerColors class name sent with the marker.
 * @param colorColor     Resolved color of that class, when the class is known.
 * @param typeColor      `color[]` of the marker type, as a CSS color.
 */
export function resolveMarkerColor(
    colorClassName: string | undefined | null,
    colorColor: string | undefined,
    typeColor: string | undefined,
): string {
    if (isDefaultMarkerColor(colorClassName)) {
        return typeColor || DEFAULT_MARKER_COLOR;
    }

    // Arma 2.20+ markers can carry a full custom color instead of a class name.
    const custom = markerColorToCss(colorClassName);
    if (custom) {
        return custom;
    }

    return colorColor || typeColor || DEFAULT_MARKER_COLOR;
}

/** Color of the marker label text: the marker color, or white as a fallback. */
export function markerLabelColor(resolvedColor: string | undefined): string {
    return resolvedColor && resolvedColor !== '' ? resolvedColor : DEFAULT_MARKER_COLOR;
}

/** Clamps marker text to {@link MAX_MARKER_TEXT_LENGTH} characters. */
export function clampMarkerText(text: string): string {
    return text.length > MAX_MARKER_TEXT_LENGTH ? text.slice(0, MAX_MARKER_TEXT_LENGTH) : text;
}
