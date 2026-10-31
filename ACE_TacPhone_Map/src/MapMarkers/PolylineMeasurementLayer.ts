/**
 * Measurement overlays for completed, tagged polyline markers.
 *
 * The overlay is independent of the drawing preview: it renders the same
 * distance/height/bearing/angle labels for every measured polyline the game
 * reports, but only when the polyline is large enough on screen. Terrain
 * heights are fetched lazily and shared with the drawing preview cache.
 */

import type OlMap from 'ol/Map';
import Feature, { type FeatureLike } from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import type { Style } from 'ol/style';
import { createPolylineMeasurementStyles } from './PolylineMeasurements';
import { getCachedTerrainHeight, resolveTerrainHeights } from './TerrainHeightApi';

/** Show measurements once the polyline's screen bbox covers this area. */
export const MEASUREMENT_MIN_SCREEN_AREA_PX2 = 60_000;
/** Fallback for long, almost straight lines whose bbox area is near zero. */
export const MEASUREMENT_MIN_SCREEN_SPAN_PX = 320;

const HEIGHT_REQUEST_DEBOUNCE_MS = 200;

export interface PolylineMeasurementLayerOptions {
    isChannelVisible(channel: number): boolean;
    getActiveChannel(): number;
    getChannelDim(channel: number): number;
}

interface MeasurementRequestEntry {
    feature: Feature<LineString>;
    points: Array<[number, number]>;
    indices: number[];
    revision: number;
}

function coordinateKey(x: number, y: number): string {
    return `${Math.round(x)},${Math.round(y)}`;
}

function samePoints(
    left: ReadonlyArray<readonly [number, number]> | undefined,
    right: ReadonlyArray<readonly [number, number]>,
): boolean {
    if (!left || left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index++) {
        if (left[index][0] !== right[index][0] || left[index][1] !== right[index][1]) {
            return false;
        }
    }

    return true;
}

export class PolylineMeasurementLayer {
    private readonly map: OlMap;
    private readonly options: PolylineMeasurementLayerOptions;
    public readonly layer: VectorLayer<VectorSource>;

    private readonly source: VectorSource;
    private readonly features = new Map<string, Feature<LineString>>();
    private heightTimer: number | null = null;
    private destroyed = false;

    constructor(map: OlMap, options: PolylineMeasurementLayerOptions) {
        this.map = map;
        this.options = options;
        this.source = new VectorSource();
        this.layer = new VectorLayer<VectorSource>({
            source: this.source,
            style: this.styleFunction,
            // Rebuild measurement styles after a zoom/pan instead of every
            // animation frame; the text labels stay anchored by pixel offsets.
            updateWhileInteracting: false,
        });
        this.layer.setZIndex(2);
        this.map.on('moveend', this.handleMoveEnd);
    }

    public upsert(name: string, channel: number, points: Array<[number, number]>): void {
        if (this.destroyed || !Number.isInteger(channel) || points.length < 2) {
            return;
        }

        const copied = points.map(([x, y]): [number, number] => [x, y]);
        const existing = this.features.get(name);

        if (existing) {
            const geometry = existing.getGeometry();
            if (geometry instanceof LineString) {
                geometry.setCoordinates(copied);
            }

            const oldPoints = existing.get('points') as Array<[number, number]> | undefined;
            const geometryChanged = !samePoints(oldPoints, copied);
            existing.set('channel', channel);
            existing.set('points', copied);
            if (geometryChanged) {
                existing.set(
                    'heights',
                    copied.map(([x, y]) => getCachedTerrainHeight(x, y) ?? null),
                );
            }
            existing.set('revision', ((existing.get('revision') as number | undefined) ?? 0) + 1);
            existing.set('measurementStylesKey', '');
            existing.set('measurementStyles', []);
        } else {
            const feature = new Feature<LineString>({
                geometry: new LineString(copied),
            });
            feature.set('measurement', true);
            feature.set('name', name);
            feature.set('channel', channel);
            feature.set('points', copied);
            feature.set(
                'heights',
                copied.map(([x, y]) => getCachedTerrainHeight(x, y) ?? null),
            );
            feature.set('revision', 1);
            feature.set('measurementStyles', []);
            feature.set('measurementStylesKey', '');
            this.source.addFeature(feature);
            this.features.set(name, feature);
        }

        this.source.changed();
        this.scheduleHeightRefresh();
    }

    public remove(name: string): void {
        const feature = this.features.get(name);
        if (!feature) {
            return;
        }

        this.features.delete(name);
        this.source.removeFeature(feature);
    }

    public clear(): void {
        this.features.clear();
        this.source.clear();
    }

    /** Invalidates cached styles after the active channel changes. */
    public setActiveChannel(): void {
        if (this.destroyed) {
            return;
        }

        this.layer.changed();
    }

    /** Re-evaluates channel visibility and requests missing heights. */
    public refresh(): void {
        if (this.destroyed) {
            return;
        }

        this.layer.changed();
        this.scheduleHeightRefresh();
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.map.un('moveend', this.handleMoveEnd);

        if (this.heightTimer !== null) {
            window.clearTimeout(this.heightTimer);
            this.heightTimer = null;
        }

        this.clear();
        this.layer.changed();
    }

    private handleMoveEnd = (): void => {
        this.scheduleHeightRefresh();
    };

    private scheduleHeightRefresh(): void {
        if (this.destroyed) {
            return;
        }

        if (this.heightTimer !== null) {
            window.clearTimeout(this.heightTimer);
        }

        this.heightTimer = window.setTimeout(() => {
            this.heightTimer = null;
            this.refreshHeightRequests();
        }, HEIGHT_REQUEST_DEBOUNCE_MS);
    }

    private refreshHeightRequests(): void {
        const resolution = this.map.getView().getResolution();
        if (!resolution || !Number.isFinite(resolution) || resolution <= 0) {
            return;
        }

        const missing = new Map<string, [number, number]>();
        const entries: MeasurementRequestEntry[] = [];

        for (const feature of this.features.values()) {
            if (!this.isVisible(feature, resolution)) {
                continue;
            }

            const points = feature.get('points') as Array<[number, number]> | undefined;
            const heights = feature.get('heights') as Array<number | null> | undefined;
            if (!points || !heights) {
                continue;
            }

            const indices: number[] = [];
            for (let index = 0; index < points.length; index++) {
                if (heights[index] !== null && heights[index] !== undefined) {
                    continue;
                }

                const [x, y] = points[index];
                missing.set(coordinateKey(x, y), [x, y]);
                indices.push(index);
            }

            if (indices.length > 0) {
                entries.push({
                    feature,
                    points,
                    indices,
                    revision: (feature.get('revision') as number | undefined) ?? 0,
                });
            }
        }

        if (missing.size === 0 || entries.length === 0) {
            return;
        }

        const positions = [...missing.values()];
        void resolveTerrainHeights(positions).then((resolved) => {
            if (this.destroyed) {
                return;
            }

            const keyedHeights = new Map<string, number>();
            for (let index = 0; index < positions.length; index++) {
                const height = resolved[index];
                if (height !== null) {
                    keyedHeights.set(coordinateKey(positions[index][0], positions[index][1]), height);
                }
            }

            let changed = false;
            for (const entry of entries) {
                const active = this.features.get(entry.feature.get('name') as string);
                if (active !== entry.feature || ((entry.feature.get('revision') as number | undefined) ?? 0) !== entry.revision) {
                    continue;
                }

                const heights = entry.feature.get('heights') as Array<number | null> | undefined;
                if (!heights) {
                    continue;
                }

                let featureChanged = false;
                for (const index of entry.indices) {
                    if (heights[index] !== null && heights[index] !== undefined) {
                        continue;
                    }

                    const point = entry.points[index];
                    const height = keyedHeights.get(coordinateKey(point[0], point[1]));
                    if (height !== undefined) {
                        heights[index] = height;
                        featureChanged = true;
                    }
                }

                if (featureChanged) {
                    entry.feature.set('revision', entry.revision + 1);
                    entry.feature.set('measurementStylesKey', '');
                    entry.feature.set('measurementStyles', []);
                    changed = true;
                }
            }

            if (changed) {
                this.layer.changed();
            }
        }).catch((error: unknown) => {
            console.warn('Failed to fetch polyline measurement heights', error);
        });
    }

    private isVisible(feature: FeatureLike, resolution: number): boolean {
        if (feature.get('measurement') !== true) {
            return false;
        }

        const channel = feature.get('channel') as number | undefined;
        if (typeof channel !== 'number' || !this.options.isChannelVisible(channel)) {
            return false;
        }

        const geometry = feature.getGeometry();
        if (!(geometry instanceof LineString) || !Number.isFinite(resolution) || resolution <= 0) {
            return false;
        }

        const [minX, minY, maxX, maxY] = geometry.getExtent();
        const screenWidth = (maxX - minX) / resolution;
        const screenHeight = (maxY - minY) / resolution;
        const screenArea = screenWidth * screenHeight;
        const screenSpan = Math.max(screenWidth, screenHeight);

        return screenArea >= MEASUREMENT_MIN_SCREEN_AREA_PX2
            || screenSpan >= MEASUREMENT_MIN_SCREEN_SPAN_PX;
    }

    private styleFunction = (feature: FeatureLike, resolution: number): Style[] => {
        if (!(feature instanceof Feature)) {
            return [];
        }

        if (!this.isVisible(feature, resolution)) {
            return [];
        }

        const channel = feature.get('channel') as number;
        const opacity = this.options.getChannelDim(channel);
        const revision = (feature.get('revision') as number | undefined) ?? 0;
        const key = `${revision}:${resolution}:${opacity}`;

        if (feature.get('measurementStylesKey') !== key) {
            const points = feature.get('points') as Array<[number, number]> | undefined;
            const heights = feature.get('heights') as Array<number | null> | undefined;
            if (!points || !heights) {
                return [];
            }

            const styles = createPolylineMeasurementStyles(
                points,
                heights,
                resolution,
                { opacity },
            );
            feature.set('measurementStyles', styles);
            feature.set('measurementStylesKey', key);
        }

        return (feature.get('measurementStyles') as Style[] | undefined) ?? [];
    };
}
