// Preview layer for a polyline marker the user is currently drawing. Map.tsx
// owns the instance: it adds `layer` to the map, feeds tapped coordinates in
// with addPoint(), and removes the layer again on unmount. Purely visual: no
// game requests, no timers, and no map reference of its own.

import Feature from 'ol/Feature';
import type { FeatureLike } from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import MultiPoint from 'ol/geom/MultiPoint';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style';

const DEFAULT_COLOR = '#ffffff';
const HALO_COLOR = '#ffffff';
const HALO_WIDTH = 6;
const LINE_WIDTH = 3;
const VERTEX_RADIUS = 4;
const VERTEX_BORDER_WIDTH = 1.5;

// Measurement overlay: pixel offsets are resolution independent, so the labels
// keep the same distance to the line at every zoom level.
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
// Screen-space pixels relative to the icon center, Y down, drawn as geometry so
// it stays pixel sized at every zoom level and keeps a white halo.
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
// Direction of the first segment, useful as a firing azimuth: compass degrees
// plus the 6400 mil circle used by the Arma mortar sights.
const DEGREES_PER_CIRCLE = 360;
const MILS_PER_CIRCLE = 6400;
const DEGREE_DIGITS = 3;
const MIL_DIGITS = 4;
// Semicircles around an angle vertex: fixed screen radius, with a small gap at
// the ends so the two halves stay visually separate.
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

/**
 * Text measurement for the height labels, so the mountain symbol can sit just
 * left of the number however many digits it has. Uses the label font, so the
 * measured width matches what the map draws.
 */
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

/**
 * Squared distance from a point to a line segment. Used by the simplifier, so
 * it avoids the square root.
 */
function squaredSegmentDistance(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number {
    let x = ax;
    let y = ay;
    let dx = bx - ax;
    let dy = by - ay;

    if (dx !== 0 || dy !== 0) {
        const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
        if (t > 1) {
            x = bx;
            y = by;
        } else if (t > 0) {
            x += dx * t;
            y += dy * t;
        }
    }

    dx = px - x;
    dy = py - y;
    return dx * dx + dy * dy;
}

/**
 * Ramer-Douglas-Peucker simplification in map units (meters). Endpoints are
 * always kept, so a line never drops below two points. Freehand drawing samples
 * every 5 m but a pointer path is still redundant at small map scales; this
 * removes the points that do not change the shape before it goes to the game.
 */
export function simplifyPolyline(
    points: Array<[number, number]>,
    tolerance: number,
): Array<[number, number]> {
    const copied = points.map(([x, y]): [number, number] => [x, y]);

    if (copied.length <= 2 || !Number.isFinite(tolerance) || tolerance <= 0) {
        return copied;
    }

    const squaredTolerance = tolerance * tolerance;
    const keep = new Array<boolean>(copied.length).fill(false);
    keep[0] = true;
    keep[copied.length - 1] = true;

    // Iterative stack instead of recursion: a digitized freehand line can have
    // hundreds of points and must not risk the call stack.
    const segments: Array<[number, number]> = [[0, copied.length - 1]];

    while (segments.length > 0) {
        const segment = segments.pop();
        if (!segment) {
            break;
        }

        const [first, last] = segment;
        const [ax, ay] = copied[first];
        const [bx, by] = copied[last];
        let farthestSquared = 0;
        let farthestIndex = -1;

        for (let index = first + 1; index < last; index++) {
            const squared = squaredSegmentDistance(
                copied[index][0],
                copied[index][1],
                ax,
                ay,
                bx,
                by,
            );
            if (squared > farthestSquared) {
                farthestSquared = squared;
                farthestIndex = index;
            }
        }

        if (farthestIndex !== -1 && farthestSquared > squaredTolerance) {
            keep[farthestIndex] = true;
            segments.push([first, farthestIndex], [farthestIndex, last]);
        }
    }

    const simplified: Array<[number, number]> = [];
    for (let index = 0; index < copied.length; index++) {
        if (keep[index]) {
            simplified.push(copied[index]);
        }
    }

    return simplified;
}

/**
 * Falls back to the default color for empty or non-CSS input, so a bad value
 * from a color picker never leaves the preview invisible.
 */
function normalizeColor(cssColor: string | undefined): string {
    const trimmed = cssColor?.trim() ?? '';
    if (trimmed === '') {
        return DEFAULT_COLOR;
    }

    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
        return CSS.supports('color', trimmed) ? trimmed : DEFAULT_COLOR;
    }

    return trimmed;
}

/**
 * Holds the in-progress polyline as a single line feature plus a vertex style,
 * so the user sees a colored line with a white halo and dots on every point.
 */
export class PolylineDrawing {
    public readonly layer: VectorLayer<VectorSource>;

    private readonly source: VectorSource;
    private readonly points: [number, number][] = [];
    /** Height above sea level per vertex, 1:1 with `points`; null = unknown. */
    private readonly heights: Array<number | null> = [];
    private feature: Feature<LineString> | null = null;
    private color: string;
    private baseStyles: Style[] = [];
    private measurementsEnabled = false;
    /** Bumped whenever the points change, to invalidate the label cache. */
    private pointsRevision = 0;
    private measurementStyles: Style[] = [];
    private measurementStylesKey = '';

    constructor(color?: string) {
        this.color = normalizeColor(color);
        this.baseStyles = this.createStyles();
        this.source = new VectorSource();
        this.layer = new VectorLayer<VectorSource>({
            source: this.source,
            // The layer is a transient preview, so it stays out of LayerSwitcher
            // by not carrying a `title` property.
            style: this.renderStyle,
            updateWhileAnimating: true,
            updateWhileInteracting: true,
        });
    }

    /**
     * Turns the distance/angle overlay on or off. Display only: the points and
     * the color stay untouched, so this can toggle at any time while drawing.
     */
    public setMeasurementsEnabled(enabled: boolean): void {
        this.measurementsEnabled = enabled;
        this.layer.changed();
    }

    public setColor(cssColor: string): void {
        this.color = normalizeColor(cssColor);
        // The render style function reads the cached base styles, so rebuilding
        // them plus changed() repaints without touching the geometry.
        this.baseStyles = this.createStyles();
        this.layer.changed();
    }

    public addPoint(coordinate: [number, number]): void {
        const [x, y] = coordinate;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }

        const last = this.points[this.points.length - 1];
        if (last && last[0] === x && last[1] === y) {
            return;
        }

        this.points.push([x, y]);
        this.heights.push(null);
        this.pointsRevision++;
        this.syncFeature();
    }

    public undoLastPoint(): void {
        if (this.points.length === 0) {
            return;
        }

        this.points.pop();
        this.heights.pop();
        this.pointsRevision++;
        this.syncFeature();
    }

    public clear(): void {
        if (this.points.length === 0 && this.feature === null) {
            return;
        }

        this.points.length = 0;
        this.heights.length = 0;
        this.pointsRevision++;
        this.removeFeature();
        this.layer.changed();
    }

    public getPointCount(): number {
        return this.points.length;
    }

    /** Returns a copy of the point at `index`, or null when out of range. */
    public getPoint(index: number): [number, number] | null {
        if (!Number.isInteger(index) || index < 0 || index >= this.points.length) {
            return null;
        }

        const point = this.points[index];
        return [point[0], point[1]];
    }

    /**
     * Sets the height above sea level (meters) for the vertex at `index`.
     * Pass null to clear it. Ignored when the index is out of range or the value
     * is not a finite number.
     */
    public setPointHeight(index: number, height: number | null): void {
        if (!Number.isInteger(index) || index < 0 || index >= this.points.length) {
            return;
        }

        if (height !== null && !Number.isFinite(height)) {
            return;
        }

        this.heights[index] = height;
        this.pointsRevision++;
        this.layer.changed();
    }

    /** Returns `[x1, y1, x2, y2, ...]`, or `[]` while nothing was tapped. */
    public getFlatPolyline(): number[] {
        const flat: number[] = [];

        for (const point of this.points) {
            flat.push(point[0], point[1]);
        }

        return flat;
    }

    public destroy(): void {
        this.points.length = 0;
        this.heights.length = 0;
        this.pointsRevision++;
        this.measurementStyles = [];
        this.measurementStylesKey = '';
        this.feature = null;
        this.source.clear();
        this.layer.changed();
    }

    /**
     * Creates the feature on the first point, updates its geometry afterwards,
     * and drops it again when the last point was undone.
     */
    private syncFeature(): void {
        if (this.points.length === 0) {
            this.removeFeature();
            this.layer.changed();
            return;
        }

        // Geometry gets its own copy so later pushes/pops cannot bypass the
        // change notification of setCoordinates().
        const coordinates = this.points.map((point) => [point[0], point[1]]);

        if (this.feature) {
            this.feature.getGeometry()?.setCoordinates(coordinates);
        } else {
            this.feature = new Feature<LineString>({
                geometry: new LineString(coordinates),
            });
            this.source.addFeature(this.feature);
        }

        this.layer.changed();
    }

    private removeFeature(): void {
        if (this.feature === null) {
            return;
        }

        this.source.removeFeature(this.feature);
        this.feature = null;
    }

    /**
     * Render-time style function: the measurement labels are positioned in
     * pixels, so they can only be built once the current resolution is known.
     */
    private renderStyle = (_feature: FeatureLike, resolution: number): Style[] => {
        if (!this.measurementsEnabled) {
            return this.baseStyles;
        }

        return this.baseStyles.concat(this.createMeasurementStyles(resolution));
    };

    /**
     * Distance and angle labels for the in-progress line. Display only: nothing
     * here feeds back into the points or the geometry sent to the game.
     */
    private createMeasurementStyles(resolution: number): Style[] {
        if (this.points.length === 0 || !Number.isFinite(resolution) || resolution <= 0) {
            return [];
        }

        // A single vertex only has a height; distances, angles and the bearing
        // all need at least one segment.
        if (this.points.length === 1) {
            return this.createSinglePointHeightStyles(resolution);
        }

        // Label positions only depend on the points and the resolution, so the
        // styles survive pans and are rebuilt only when one of them changes.
        const cacheKey = `${this.pointsRevision}:${resolution}`;
        if (cacheKey === this.measurementStylesKey) {
            return this.measurementStyles;
        }

        const styles: Style[] = [];
        let total = 0;

        for (let index = 1; index < this.points.length; index++) {
            const from = this.points[index - 1];
            const to = this.points[index];
            const dx = to[0] - from[0];
            const dy = to[1] - from[1];
            const distance = Math.hypot(dx, dy);
            total += distance;

            if (distance === 0) {
                continue;
            }

            // Screen direction in pixels (screen Y points down, map Y up), then
            // the normal that puts the label above a line running to the right.
            const sx = dx / resolution;
            const sy = -dy / resolution;
            const screenLength = Math.hypot(sx, sy);
            if (screenLength === 0) {
                continue;
            }

            const normalX = sy / screenLength;
            const normalY = -sx / screenLength;

            const fromHeight = this.heights[index - 1];
            const toHeight = this.heights[index];
            let segmentText = formatDistance(distance);
            if (fromHeight !== null && toHeight !== null) {
                segmentText = `${segmentText} (Δh ${formatHeightDifference(toHeight - fromHeight)})`;
            }

            styles.push(
                this.createMeasurementStyle(
                    [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
                    segmentText,
                    normalX * SEGMENT_LABEL_OFFSET,
                    normalY * SEGMENT_LABEL_OFFSET,
                ),
            );
        }

        const last = this.points[this.points.length - 1];
        const previous = this.points[this.points.length - 2];
        const endX = last[0] - previous[0];
        const endY = last[1] - previous[1];
        const endLength = Math.hypot(endX, endY);

        // Direction of the first segment, placed behind the first vertex so it
        // reads as the heading of the line rather than a label on it. Map north
        // is +Y, so the bearing is the clockwise angle from +Y.
        const start = this.points[0];
        const second = this.points[1];
        const startX = second[0] - start[0];
        const startY = second[1] - start[1];
        const startLength = Math.hypot(startX, startY);

        if (startLength > 0) {
            const bearing = (Math.atan2(startX, startY) * 180) / Math.PI;
            const unitX = startX / startLength;
            // Screen Y points down, map Y up.
            const unitY = -startY / startLength;
            const bearingOffsetY = -unitY * BEARING_LABEL_OFFSET;

            styles.push(
                this.createMeasurementStyle(
                    start,
                    formatBearing(bearing),
                    -unitX * BEARING_LABEL_OFFSET,
                    // Behind the first vertex. When that lands above the point
                    // (first segment pointing down), the height label is in the
                    // way, so the bearing moves past it.
                    bearingOffsetY < 0 ? BEARING_ABOVE_HEIGHT_OFFSET_PX : bearingOffsetY,
                ),
            );
        }

        if (endLength > 0) {
            styles.push(
                this.createMeasurementStyle(
                    last,
                    `Total ${formatDistance(total)}`,
                    0,
                    // Below the point: the endpoint's height label sits above it
                    // and the two wide texts would otherwise overlap.
                    END_LABEL_OFFSET,
                ),
            );
        }

        for (let index = 1; index < this.points.length - 1; index++) {
            const vertex = this.points[index];
            const before = this.points[index - 1];
            const after = this.points[index + 1];

            // Screen-space vectors: offsets and arc angles below are all in
            // screen pixels, where Y points down.
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
            const second = DEGREES_PER_HALF_TURN - first;

            let bisectorX = unitPrevX + unitNextX;
            let bisectorY = unitPrevY + unitNextY;
            const bisectorLength = Math.hypot(bisectorX, bisectorY);

            if (bisectorLength < STRAIGHT_ANGLE_EPSILON) {
                // 180 degrees: no usable bisector, so use the incoming normal.
                bisectorX = -unitPrevY;
                bisectorY = unitPrevX;
            } else {
                bisectorX /= bisectorLength;
                bisectorY /= bisectorLength;
            }

            const textOffset = ANGLE_ARC_RADIUS_PX + ANGLE_ARC_TEXT_GAP_PX;

            // Both arcs first, then both texts, so the labels always paint on
            // top of the arc halos.
            styles.push(
                ...this.createAngleArcStyles(vertex, bisectorX, bisectorY, resolution),
                ...this.createAngleArcStyles(vertex, -bisectorX, -bisectorY, resolution),
                this.createMeasurementStyle(
                    vertex,
                    `${first}°`,
                    bisectorX * textOffset,
                    bisectorY * textOffset,
                ),
                this.createMeasurementStyle(
                    vertex,
                    `${second}°`,
                    -bisectorX * textOffset,
                    -bisectorY * textOffset,
                ),
            );
        }

        // Height labels come last so their halo is never covered by the arcs.
        for (let index = 0; index < this.points.length; index++) {
            const height = this.heights[index];
            if (height === null) {
                continue;
            }

            styles.push(...this.createHeightLabelStyles(this.points[index], height, resolution));
        }

        this.measurementStyles = styles;
        this.measurementStylesKey = cacheKey;
        return styles;
    }

    /**
     * Height label for the very first vertex, before there is a segment to
     * measure. Mirrors the height labels in createMeasurementStyles().
     */
    private createSinglePointHeightStyles(resolution: number): Style[] {
        const height = this.heights[0];
        if (height === null || !Number.isFinite(height)) {
            return [];
        }

        return this.createHeightLabelStyles(this.points[0], height, resolution);
    }

    /**
     * Height label for one vertex: a little two-peaks mountain symbol followed
     * by the height, laid out as one centered group just above the point. The
     * symbol marks a terrain height, so it stays off the Δh in the segment
     * distance labels.
     */
    private createHeightLabelStyles(
        coordinate: [number, number],
        height: number,
        resolution: number,
    ): Style[] {
        const text = `${Math.round(height)} m`;
        const groupWidth =
            MOUNTAIN_ICON_SIZE_PX + MOUNTAIN_ICON_GAP_PX + measureLabelWidth(text);
        const left = -groupWidth / 2;

        return [
            ...this.createMountainSymbolStyles(
                coordinate,
                left + MOUNTAIN_ICON_SIZE_PX / 2,
                -HEIGHT_LABEL_OFFSET_PX,
                resolution,
            ),
            this.createMeasurementStyle(
                coordinate,
                text,
                left + MOUNTAIN_ICON_SIZE_PX + MOUNTAIN_ICON_GAP_PX,
                -HEIGHT_LABEL_OFFSET_PX,
                'left',
            ),
        ];
    }

    /**
     * Two-peaks mountain silhouette at a pixel offset from `coordinate`, drawn
     * as geometry (like the angle arcs) so it keeps its pixel size and halo at
     * every zoom level.
     */
    private createMountainSymbolStyles(
        coordinate: [number, number],
        offsetX: number,
        offsetY: number,
        resolution: number,
    ): Style[] {
        const coordinates: Array<[number, number]> = MOUNTAIN_ICON_POINTS.map(
            ([x, y]) =>
                [
                    coordinate[0] + (offsetX + x) * resolution,
                    coordinate[1] - (offsetY + y) * resolution,
                ] as [number, number],
        );
        // Closed ring, so the fill does not depend on the renderer closing it.
        coordinates.push(coordinates[0]);
        const geometry = new Polygon([coordinates]);

        return [
            new Style({
                geometry,
                fill: new Fill({ color: MEASUREMENT_HALO_COLOR }),
                stroke: new Stroke({
                    color: MEASUREMENT_HALO_COLOR,
                    width: MOUNTAIN_HALO_WIDTH,
                }),
            }),
            new Style({
                geometry,
                fill: new Fill({ color: MEASUREMENT_TEXT_COLOR }),
                stroke: new Stroke({
                    color: MEASUREMENT_TEXT_COLOR,
                    width: MOUNTAIN_STROKE_WIDTH,
                }),
            }),
        ];
    }

    /**
     * Semicircle around the angle vertex, centered on the angle's side, so the
     * degree text has an unambiguous side even for very sharp angles. The
     * direction is a screen-space unit vector (Y points down); the geometry is
     * converted back to map coordinates, where Y points up.
     */
    private createAngleArcStyles(
        vertex: [number, number],
        directionX: number,
        directionY: number,
        resolution: number,
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
                    color: ANGLE_ARC_HALO_COLOR,
                    width: ANGLE_ARC_HALO_WIDTH,
                }),
            }),
            new Style({
                geometry,
                stroke: new Stroke({
                    color: ANGLE_ARC_COLOR,
                    width: ANGLE_ARC_WIDTH,
                }),
            }),
        ];
    }

    private createMeasurementStyle(
        coordinate: [number, number],
        text: string,
        offsetX: number,
        offsetY: number,
        textAlign: 'center' | 'left' = 'center',
    ): Style {
        return new Style({
            geometry: new Point([coordinate[0], coordinate[1]]),
            text: new Text({
                text,
                font: MEASUREMENT_FONT,
                fill: new Fill({ color: MEASUREMENT_TEXT_COLOR }),
                stroke: new Stroke({
                    color: MEASUREMENT_HALO_COLOR,
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

    private createStyles(): Style[] {
        const color = this.color;

        return [
            new Style({
                stroke: new Stroke({ color: HALO_COLOR, width: HALO_WIDTH }),
            }),
            new Style({
                stroke: new Stroke({ color, width: LINE_WIDTH }),
            }),
            new Style({
                // One MultiPoint for all vertices; no per-vertex Point objects
                // and no second feature.
                geometry: this.getVertexGeometry,
                image: new Circle({
                    radius: VERTEX_RADIUS,
                    fill: new Fill({ color }),
                    stroke: new Stroke({ color: HALO_COLOR, width: VERTEX_BORDER_WIDTH }),
                }),
            }),
        ];
    }

    private getVertexGeometry = (feature: FeatureLike): MultiPoint | undefined => {
        const geometry = feature.getGeometry();

        if (!(geometry instanceof LineString)) {
            return undefined;
        }

        return new MultiPoint(geometry.getCoordinates());
    };
}
