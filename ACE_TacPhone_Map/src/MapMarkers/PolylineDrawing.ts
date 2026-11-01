// Preview layer for a polyline marker the user is currently drawing. Map.tsx
// owns the instance: it adds `layer` to the map, feeds tapped coordinates in
// with addPoint(), and removes the layer again on unmount. Purely visual: no
// game requests, no timers, and no map reference of its own.

import Feature from 'ol/Feature';
import type { FeatureLike } from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import MultiPoint from 'ol/geom/MultiPoint';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Circle, Fill, Stroke, Style } from 'ol/style';
import { createPolylineMeasurementStyles } from './PolylineMeasurements';

const DEFAULT_COLOR = '#ffffff';
const HALO_WIDTH = 6;
const LINE_WIDTH = 3;
const VERTEX_RADIUS = 4;
const VERTEX_BORDER_WIDTH = 1.5;

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
 * always kept, so a line never drops below two points.
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

/** Alpha component of a CSS color, used to keep the halo in step with the line. */
function colorAlpha(cssColor: string): number {
    const rgba = /^rgba?\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*([0-9.]+)\s*\)$/i.exec(cssColor);
    if (rgba) {
        const value = Number(rgba[1]);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    }

    if (/^#[0-9a-f]{8}$/i.test(cssColor)) {
        return Number.parseInt(cssColor.slice(7, 9), 16) / 255;
    }

    return 1;
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
    private haloColor: string;
    private baseStyles: Style[] = [];
    private measurementsEnabled = false;
    /** Bumped whenever the points change, to invalidate the label cache. */
    private pointsRevision = 0;
    private measurementStyles: Style[] = [];
    private measurementStylesKey = '';

    constructor(color?: string) {
        this.color = normalizeColor(color);
        this.haloColor = `rgba(255, 255, 255, ${colorAlpha(this.color)})`;
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

    /** Turns the distance/angle overlay on or off while drawing. */
    public setMeasurementsEnabled(enabled: boolean): void {
        this.measurementsEnabled = enabled;
        this.layer.changed();
    }

    public isMeasurementsEnabled(): boolean {
        return this.measurementsEnabled;
    }

    public setColor(cssColor: string): void {
        this.color = normalizeColor(cssColor);
        // The halo is white like Arma's marker outline, but it must fade with
        // the line: a fully opaque halo under a translucent line reads as a
        // white line that ignores the alpha setting.
        this.haloColor = `rgba(255, 255, 255, ${colorAlpha(this.color)})`;
        // The render style function reads the cached base styles, so rebuilding
        // them plus changed() repaints without touching the geometry.
        this.baseStyles = this.createStyles();
        this.layer.changed();
    }

    /** Debug-only: the line and halo colors currently used by the preview. */
    public getDebugColors(): { line: string; halo: string } {
        return { line: this.color, halo: this.haloColor };
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
     * Pass null to clear it.
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
     * Distance, height, bearing and angle labels for the in-progress line.
     * Display only: nothing here feeds back into the points or the geometry
     * sent to the game.
     */
    private createMeasurementStyles(resolution: number): Style[] {
        if (this.points.length === 0 || !Number.isFinite(resolution) || resolution <= 0) {
            return [];
        }

        // Label positions only depend on the points and the resolution, so the
        // styles survive pans and are rebuilt only when one of them changes.
        const cacheKey = `${this.pointsRevision}:${resolution}`;
        if (cacheKey === this.measurementStylesKey) {
            return this.measurementStyles;
        }

        const styles = createPolylineMeasurementStyles(this.points, this.heights, resolution);
        this.measurementStyles = styles;
        this.measurementStylesKey = cacheKey;
        return styles;
    }

    private createStyles(): Style[] {
        const color = this.color;
        const haloColor = this.haloColor;

        return [
            new Style({
                stroke: new Stroke({ color: haloColor, width: HALO_WIDTH }),
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
                    stroke: new Stroke({ color: haloColor, width: VERTEX_BORDER_WIDTH }),
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
