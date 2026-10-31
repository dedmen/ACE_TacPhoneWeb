/**
 * Measurement overlay styles for polylines.
 *
 * Extracted from the in-progress drawing preview so completed marker polylines
 * can render exactly the same distance, height, bearing and angle labels.
 * Pure style building: no map, no game requests, no timers.
 */

import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import { Fill, Stroke, Style, Text } from 'ol/style';

/** Data-only marker text for polylines that should show measurements. */
export const POLYLINE_MEASUREMENTS_TAG = 'ace_tacphone:polyline-measurements:1';

export function isPolylineMeasurementsText(text: unknown): boolean {
    return typeof text === 'string'
        && text.startsWith('ace_tacphone:polyline-measurements:');
}

// Pixel offsets are resolution independent, so the labels keep the same
// distance to the line at every zoom level.
const SEGMENT_LABEL_OFFSET = 12;
// Below the last vertex, clear of the endpoint's height label above it.
const END_LABEL_OFFSET = 18;
const BEARING_LABEL_OFFSET = 16;
// Sits between the 4 px vertex dot and the 24 px angle arcs, above the vertex.
const HEIGHT_LABEL_OFFSET_PX = 16;
// A bearing that would land above the first vertex (first segment pointing
// down) is pushed past that vertex's height label instead.
const BEARING_ABOVE_HEIGHT_OFFSET_PX = -(HEIGHT_LABEL_OFFSET_PX + 18);
// Little two-peaks mountain in front of every height label (never the Δh text).
const MOUNTAIN_ICON_SIZE_PX = 12;
const MOUNTAIN_ICON_GAP_PX = 3;
const MOUNTAIN_ICON_POINTS: ReadonlyArray<readonly [number, number]> = [
    [-6, 3.6],
    [-3.1, -1.8],
    [-0.9, 2.2],
    [2.6, -3.6],
    [6, 3.6],
];
const MOUNTAIN_HALO_WIDTH = 5;
const MOUNTAIN_STROKE_WIDTH = 1;
const DEGREES_PER_CIRCLE = 360;
const MILS_PER_CIRCLE = 6400;
const DEGREE_DIGITS = 3;
const MIL_DIGITS = 4;
const ANGLE_ARC_RADIUS_PX = 24;
const ANGLE_ARC_TEXT_GAP_PX = 10;
// Half of a half circle, minus a small gap at each end.
const ANGLE_ARC_HALF_SPAN = Math.PI / 2 - 0.02;
const ANGLE_ARC_SEGMENTS = 32;
const ANGLE_ARC_COLOR = 'rgba(15, 23, 42, 0.55)';
const ANGLE_ARC_WIDTH = 1.5;
const ANGLE_ARC_HALO_COLOR = 'rgba(255, 255, 255, 0.8)';
const ANGLE_ARC_HALO_WIDTH = 3.5;
const MEASUREMENT_FONT = 'bold 12px sans-serif';
const MEASUREMENT_TEXT_COLOR = '#0f172a';
const MEASUREMENT_HALO_COLOR = 'rgba(255, 255, 255, 0.9)';
const MEASUREMENT_HALO_WIDTH = 3;
const METERS_PER_KILOMETER = 1000;
const DEGREES_PER_HALF_TURN = 360;
const STRAIGHT_ANGLE_EPSILON = 1e-6;
const KILOMETER_DECIMALS = 2;

export interface PolylineMeasurementStyleOptions {
    /** Multiplier for every overlay color, e.g. 0.45 on an inactive channel. */
    opacity?: number;
}

/** Short, human readable length: meters below 1 km, kilometers above. */
function formatDistance(meters: number): string {
    if (meters < METERS_PER_KILOMETER) {
        return `${Math.round(meters)} m`;
    }

    return `${(meters / METERS_PER_KILOMETER).toFixed(KILOMETER_DECIMALS)} km`;
}

/**
 * Signed height change with its unit: `+12 m`, `-8 m`, and `±0 m` when it
 * rounds to zero.
 */
function formatHeightDifference(meters: number): string {
    const rounded = Math.round(meters);

    if (rounded > 0) {
        return `+${rounded} m`;
    }

    if (rounded < 0) {
        return `-${Math.abs(rounded)} m`;
    }

    return '±0 m';
}

/**
 * Compass bearing as `042° / 0747 mil`: degrees for the map and the 6400 mil
 * circle for mortar sights.
 */
function formatBearing(degrees: number): string {
    const normalized = ((degrees % DEGREES_PER_CIRCLE) + DEGREES_PER_CIRCLE) % DEGREES_PER_CIRCLE;
    const roundedDegrees = Math.round(normalized) % DEGREES_PER_CIRCLE;
    // Derived from the rounded degrees so a bearing near 360 does not read
    // e.g. `000° / 6399 mil`.
    const mils = Math.round((roundedDegrees * MILS_PER_CIRCLE) / DEGREES_PER_CIRCLE) % MILS_PER_CIRCLE;

    return `${String(roundedDegrees).padStart(DEGREE_DIGITS, '0')}° / ${String(mils).padStart(MIL_DIGITS, '0')} mil`;
}

/** Text measurement for the height labels, so the mountain symbol fits. */
let labelMeasureContext: CanvasRenderingContext2D | null | undefined;

function measureLabelWidth(text: string): number {
    if (labelMeasureContext === undefined) {
        labelMeasureContext =
            typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    }

    if (!labelMeasureContext) {
        // Without a canvas, assume a wide label so the symbol never overlaps.
        return text.length * 8;
    }

    labelMeasureContext.font = MEASUREMENT_FONT;
    return labelMeasureContext.measureText(text).width;
}

function clampOpacity(opacity: number): number {
    if (!Number.isFinite(opacity)) {
        return 1;
    }

    return Math.max(0, Math.min(1, opacity));
}

/**
 * Multiplies the alpha channel of a CSS color. Supports the color shapes used
 * by this module: #rrggbb, #rrggbbaa, rgb() and rgba().
 */
function withOpacity(color: string, opacity: number): string {
    const factor = clampOpacity(opacity);
    if (factor >= 1) {
        return color;
    }

    if (color.startsWith('#')) {
        if (color.length === 7) {
            const r = parseInt(color.slice(1, 3), 16);
            const g = parseInt(color.slice(3, 5), 16);
            const b = parseInt(color.slice(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, ${factor})`;
        }

        if (color.length === 9) {
            const r = parseInt(color.slice(1, 3), 16);
            const g = parseInt(color.slice(3, 5), 16);
            const b = parseInt(color.slice(5, 7), 16);
            const a = parseInt(color.slice(7, 9), 16) / 255;
            return `rgba(${r}, ${g}, ${b}, ${a * factor})`;
        }
    }

    const rgba = /^rgba\(([^,]+),([^,]+),([^,]+),([^)]+)\)$/.exec(color);
    if (rgba) {
        return `rgba(${rgba[1].trim()}, ${rgba[2].trim()}, ${rgba[3].trim()}, ${Number(rgba[4]) * factor})`;
    }

    const rgb = /^rgb\(([^,]+),([^,]+),([^,]+)\)$/.exec(color);
    if (rgb) {
        return `rgba(${rgb[1].trim()}, ${rgb[2].trim()}, ${rgb[3].trim()}, ${factor})`;
    }

    return color;
}

function createMeasurementStyle(
    coordinate: readonly [number, number],
    text: string,
    offsetX: number,
    offsetY: number,
    color: string,
    haloColor: string,
    textAlign: 'center' | 'left' = 'center',
): Style {
    return new Style({
        geometry: new Point([coordinate[0], coordinate[1]]),
        text: new Text({
            text,
            font: MEASUREMENT_FONT,
            fill: new Fill({ color }),
            stroke: new Stroke({
                color: haloColor,
                width: MEASUREMENT_HALO_WIDTH,
            }),
            textAlign,
            textBaseline: 'middle',
            offsetX,
            offsetY,
            declutterMode: 'none',
        }),
    });
}

/**
 * Height label for one vertex: a little two-peaks mountain symbol followed by
 * the height, laid out as one centered group just above the point.
 */
function createHeightLabelStyles(
    coordinate: readonly [number, number],
    height: number,
    resolution: number,
    color: string,
    haloColor: string,
): Style[] {
    const text = `${Math.round(height)} m`;
    const groupWidth =
        MOUNTAIN_ICON_SIZE_PX + MOUNTAIN_ICON_GAP_PX + measureLabelWidth(text);
    const left = -groupWidth / 2;

    return [
        ...createMountainSymbolStyles(
            coordinate,
            left + MOUNTAIN_ICON_SIZE_PX / 2,
            -HEIGHT_LABEL_OFFSET_PX,
            resolution,
            color,
            haloColor,
        ),
        createMeasurementStyle(
            coordinate,
            text,
            left + MOUNTAIN_ICON_SIZE_PX + MOUNTAIN_ICON_GAP_PX,
            -HEIGHT_LABEL_OFFSET_PX,
            color,
            haloColor,
            'left',
        ),
    ];
}

/** Two-peaks mountain silhouette at a pixel offset from `coordinate`. */
function createMountainSymbolStyles(
    coordinate: readonly [number, number],
    offsetX: number,
    offsetY: number,
    resolution: number,
    color: string,
    haloColor: string,
): Style[] {
    const coordinates: Array<[number, number]> = MOUNTAIN_ICON_POINTS.map(
        ([x, y]) =>
            [
                coordinate[0] + (offsetX + x) * resolution,
                coordinate[1] - (offsetY + y) * resolution,
            ] as [number, number],
    );
    coordinates.push(coordinates[0]);
    const geometry = new Polygon([coordinates]);

    return [
        new Style({
            geometry,
            fill: new Fill({ color: haloColor }),
            stroke: new Stroke({
                color: haloColor,
                width: MOUNTAIN_HALO_WIDTH,
            }),
        }),
        new Style({
            geometry,
            fill: new Fill({ color }),
            stroke: new Stroke({
                color,
                width: MOUNTAIN_STROKE_WIDTH,
            }),
        }),
    ];
}

/** Semicircle around the angle vertex, centered on the angle's side. */
function createAngleArcStyles(
    vertex: readonly [number, number],
    directionX: number,
    directionY: number,
    resolution: number,
    color: string,
    haloColor: string,
): Style[] {
    const centerAngle = Math.atan2(directionY, directionX);
    const radius = ANGLE_ARC_RADIUS_PX * resolution;
    const coordinates: Array<[number, number]> = [];

    for (let index = 0; index <= ANGLE_ARC_SEGMENTS; index++) {
        const angle =
            centerAngle -
            ANGLE_ARC_HALF_SPAN +
            (2 * ANGLE_ARC_HALF_SPAN * index) / ANGLE_ARC_SEGMENTS;
        coordinates.push([
            vertex[0] + Math.cos(angle) * radius,
            vertex[1] - Math.sin(angle) * radius,
        ]);
    }

    const geometry = new LineString(coordinates);
    return [
        new Style({
            geometry,
            stroke: new Stroke({
                color: haloColor,
                width: ANGLE_ARC_HALO_WIDTH,
            }),
        }),
        new Style({
            geometry,
            stroke: new Stroke({
                color,
                width: ANGLE_ARC_WIDTH,
            }),
        }),
    ];
}

/**
 * Builds the complete measurement overlay for a polyline.
 *
 * Distances, angles, bearing and total do not need heights. Height labels and
 * `Δh` appear only where `heights` has a finite value.
 */
export function createPolylineMeasurementStyles(
    points: ReadonlyArray<readonly [number, number]>,
    heights: ReadonlyArray<number | null>,
    resolution: number,
    options: PolylineMeasurementStyleOptions = {},
): Style[] {
    if (points.length === 0 || !Number.isFinite(resolution) || resolution <= 0) {
        return [];
    }

    const opacity = clampOpacity(options.opacity ?? 1);
    const textColor = withOpacity(MEASUREMENT_TEXT_COLOR, opacity);
    const haloColor = withOpacity(MEASUREMENT_HALO_COLOR, opacity);
    const arcColor = withOpacity(ANGLE_ARC_COLOR, opacity);
    const arcHaloColor = withOpacity(ANGLE_ARC_HALO_COLOR, opacity);
    const heightAt = (index: number): number | null => {
        const height = heights[index];
        return typeof height === 'number' && Number.isFinite(height) ? height : null;
    };

    // A single vertex only has a height; distances, angles and the bearing
    // all need at least one segment.
    if (points.length === 1) {
        const height = heightAt(0);
        return height === null
            ? []
            : createHeightLabelStyles(points[0], height, resolution, textColor, haloColor);
    }

    const styles: Style[] = [];
    let total = 0;

    for (let index = 1; index < points.length; index++) {
        const from = points[index - 1];
        const to = points[index];
        const dx = to[0] - from[0];
        const dy = to[1] - from[1];
        const distance = Math.hypot(dx, dy);
        total += distance;

        if (distance === 0) {
            continue;
        }

        const sx = dx / resolution;
        const sy = -dy / resolution;
        const screenLength = Math.hypot(sx, sy);
        if (screenLength === 0) {
            continue;
        }

        const normalX = sy / screenLength;
        const normalY = -sx / screenLength;

        const fromHeight = heightAt(index - 1);
        const toHeight = heightAt(index);
        let segmentText = formatDistance(distance);
        if (fromHeight !== null && toHeight !== null) {
            segmentText = `${segmentText} (Δh ${formatHeightDifference(toHeight - fromHeight)})`;
        }

        styles.push(
            createMeasurementStyle(
                [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
                segmentText,
                normalX * SEGMENT_LABEL_OFFSET,
                normalY * SEGMENT_LABEL_OFFSET,
                textColor,
                haloColor,
            ),
        );
    }

    const last = points[points.length - 1];
    const previous = points[points.length - 2];
    const endX = last[0] - previous[0];
    const endY = last[1] - previous[1];
    const endLength = Math.hypot(endX, endY);

    const start = points[0];
    const second = points[1];
    const startX = second[0] - start[0];
    const startY = second[1] - start[1];
    const startLength = Math.hypot(startX, startY);

    if (startLength > 0) {
        const bearing = (Math.atan2(startX, startY) * 180) / Math.PI;
        const unitX = startX / startLength;
        const unitY = -startY / startLength;
        const bearingOffsetY = -unitY * BEARING_LABEL_OFFSET;

        styles.push(
            createMeasurementStyle(
                start,
                formatBearing(bearing),
                -unitX * BEARING_LABEL_OFFSET,
                bearingOffsetY < 0 ? BEARING_ABOVE_HEIGHT_OFFSET_PX : bearingOffsetY,
                textColor,
                haloColor,
            ),
        );
    }

    if (endLength > 0) {
        styles.push(
            createMeasurementStyle(
                last,
                `Total ${formatDistance(total)}`,
                0,
                END_LABEL_OFFSET,
                textColor,
                haloColor,
            ),
        );
    }

    for (let index = 1; index < points.length - 1; index++) {
        const vertex = points[index];
        const before = points[index - 1];
        const after = points[index + 1];

        const prevX = (before[0] - vertex[0]) / resolution;
        const prevY = -(before[1] - vertex[1]) / resolution;
        const prevLength = Math.hypot(prevX, prevY);
        if (prevLength === 0) {
            continue;
        }

        const nextX = (after[0] - vertex[0]) / resolution;
        const nextY = -(after[1] - vertex[1]) / resolution;
        const nextLength = Math.hypot(nextX, nextY);
        if (nextLength === 0) {
            continue;
        }

        const unitPrevX = prevX / prevLength;
        const unitPrevY = prevY / prevLength;
        const unitNextX = nextX / nextLength;
        const unitNextY = nextY / nextLength;

        const dot = Math.min(
            1,
            Math.max(-1, unitPrevX * unitNextX + unitPrevY * unitNextY),
        );
        const first = Math.round((Math.acos(dot) * 180) / Math.PI);
        const secondAngle = DEGREES_PER_HALF_TURN - first;

        let bisectorX = unitPrevX + unitNextX;
        let bisectorY = unitPrevY + unitNextY;
        const bisectorLength = Math.hypot(bisectorX, bisectorY);

        if (bisectorLength < STRAIGHT_ANGLE_EPSILON) {
            bisectorX = -unitPrevY;
            bisectorY = unitPrevX;
        } else {
            bisectorX /= bisectorLength;
            bisectorY /= bisectorLength;
        }

        const textOffset = ANGLE_ARC_RADIUS_PX + ANGLE_ARC_TEXT_GAP_PX;

        styles.push(
            ...createAngleArcStyles(vertex, bisectorX, bisectorY, resolution, arcColor, arcHaloColor),
            ...createAngleArcStyles(vertex, -bisectorX, -bisectorY, resolution, arcColor, arcHaloColor),
            createMeasurementStyle(
                vertex,
                `${first}°`,
                bisectorX * textOffset,
                bisectorY * textOffset,
                textColor,
                haloColor,
            ),
            createMeasurementStyle(
                vertex,
                `${secondAngle}°`,
                -bisectorX * textOffset,
                -bisectorY * textOffset,
                textColor,
                haloColor,
            ),
        );
    }

    // Height labels come last so their halo is never covered by the arcs.
    for (let index = 0; index < points.length; index++) {
        const height = heightAt(index);
        if (height === null) {
            continue;
        }

        styles.push(
            ...createHeightLabelStyles(points[index], height, resolution, textColor, haloColor),
        );
    }

    return styles;
}
