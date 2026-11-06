/**
 * Waypoint management, distance measurements and route drawing/styling for the
 * GPS module.
 *
 * Split out of `GpsModule` (the orchestrator). The class holds a back-reference
 * to the module (`m`) and reads/writes the shared GPS state through it. The
 * module keeps the public entry points and calls these methods; other sibling
 * modules (camera pointer work, navigation, the debug probe) call the public
 * ones through the module as well.
 */

import type MapBrowserEvent from 'ol/MapBrowserEvent';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style';

import { legSpeed } from '../routing/SpeedModel';
import { getTerrainHeights } from '../MapMarkers/TerrainHeightApi';
import type {
    ActiveRoute,
    RouteLeg,
    RouteLegKind,
    RoutePlanResult,
    TravelMode,
} from './GpsTypes';
import {
    buildRouteGeometry,
    flattenToCoordinates,
    projectionAlong,
    sliceLegsFrom,
} from './RouteSplice';
import {
    distanceBetween,
    flatPointCount,
    projectPointToPolyline,
    sharedRouteLegs,
    sharedRouteWaypoints,
    type SharedRouteData,
} from './SharedRoute';
import type { GpsModule } from './GpsModule';

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Waypoints, measurements and route geometry/styling for one GPS module. */
export class GpsRoutes {
    private readonly m: GpsModule;

    constructor(m: GpsModule) {
        this.m = m;
    }

    handleSingleClick = (event: MapBrowserEvent): void => {
        if (!this.m.planning || this.m.destroyed) {
            return;
        }

        if (Date.now() - this.m.lastWaypointDragAt < 300) {
            return;
        }

        const coordinate = event.coordinate;
        const point = this.clampToTerrain([coordinate[0], coordinate[1]]);
        if (!point) {
            return;
        }

        // Clicking an existing route line inserts a waypoint there and keeps
        // the later waypoints after it.
        if (this.m.activeRoute && this.m.routeGeometry) {
            const projection = projectPointToPolyline(point[0], point[1], this.m.routeGeometry.points);
            if (projection && projection.distance <= 25) {
                let index = this.m.waypointAlong.findIndex((along) => along > projection.along);
                if (index < 0) {
                    index = this.m.waypoints.length;
                }
                this.m.waypoints.splice(index, 0, point);
                this.m.planning = true;
                this.rebuildWaypointLayer();
                this.schedulePreviewRoute();
                this.m.emitState(true);
                return;
            }
        }

        this.m.addWaypoint(point);
    };

    scheduleMeasurements(): void {
        if (this.m.measurementTimer !== null) {
            window.clearTimeout(this.m.measurementTimer);
        }
        this.m.measurementSource.clear();

        if (this.m.waypoints.length < 2) {
            return;
        }

        const token = ++this.m.measurementToken;
        this.m.measurementTimer = window.setTimeout(() => {
            this.m.measurementTimer = null;
            void getTerrainHeights(this.m.waypoints)
                .catch(() => null)
                .then((heights) => {
                    if (this.m.destroyed || token !== this.m.measurementToken) {
                        return;
                    }
                    this.drawMeasurements(heights);
                });
        }, 250);
    }

    private drawMeasurements(heights: number[] | null): void {
        this.m.measurementSource.clear();

        for (let index = 0; index + 1 < this.m.waypoints.length; index += 1) {
            const a = this.m.waypoints[index];
            const b = this.m.waypoints[index + 1];
            const distance = distanceBetween(a[0], a[1], b[0], b[1]);
            const heightA = heights?.[index];
            const heightB = heights?.[index + 1];
            const heightText = heightA !== undefined && heightB !== undefined
                ? `  Δh ${heightB - heightA >= 0 ? '+' : ''}${Math.round(heightB - heightA)} m`
                : '';
            const feature = new Feature(new Point([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
            feature.setStyle(new Style({
                text: new Text({
                    text: `${Math.round(distance)} m${heightText}`,
                    font: 'bold 11px sans-serif',
                    fill: new Fill({ color: '#0f172a' }),
                    stroke: new Stroke({ color: '#ffffff', width: 3 }),
                    backgroundFill: new Fill({ color: 'rgba(255,255,255,0.82)' }),
                    padding: [2, 5, 2, 5],
                }),
            }));
            this.m.measurementSource.addFeature(feature);
        }
    }

    schedulePreviewRoute(): void {
        if (this.m.previewTimer !== null) {
            window.clearTimeout(this.m.previewTimer);
        }

        if (this.m.waypoints.length === 0) {
            this.clearRoute();
            return;
        }

        this.m.previewTimer = window.setTimeout(() => {
            this.m.previewTimer = null;
            if (this.m.destroyed) {
                return;
            }

            if (this.m.navigating) {
                void this.m.recalculate();
            } else {
                void this.planRoute(this.m.position ?? this.m.waypoints[0], this.m.waypoints);
            }
        }, 250);
    }

    clampToTerrain(point: [number, number]): [number, number] | null {
        if (!isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
            return null;
        }

        const bounds = this.m.planner.getBounds();
        if (!bounds) {
            return [point[0], point[1]];
        }

        return [
            Math.max(0, Math.min(bounds.width, point[0])),
            Math.max(0, Math.min(bounds.height, point[1])),
        ];
    }

    rebuildWaypointLayer(): void {
        this.m.waypointSource.clear();

        for (let index = 0; index < this.m.waypoints.length; index += 1) {
            const feature = new Feature(new Point(this.m.waypoints[index]));
            feature.set('waypointIndex', index);
            feature.setStyle(this.waypointStyle(index));
            this.m.waypointSource.addFeature(feature);
        }
    }

    private waypointStyle(index: number): Style {
        const cached = this.m.waypointStyles[index];
        if (cached) {
            return cached;
        }

        const style = new Style({
            image: new CircleStyle({
                radius: 8,
                fill: new Fill({ color: '#0ea5e9' }),
                stroke: new Stroke({ color: '#ffffff', width: 2 }),
            }),
            text: new Text({
                text: String(index + 1),
                font: 'bold 11px sans-serif',
                fill: new Fill({ color: '#ffffff' }),
            }),
        });
        this.m.waypointStyles[index] = style;
        return style;
    }

    async planRoute(
        start: [number, number],
        waypoints: Array<[number, number]>,
        validate = false,
    ): Promise<void> {
        if (this.m.previewTimer !== null) {
            window.clearTimeout(this.m.previewTimer);
            this.m.previewTimer = null;
        }

        const generation = ++this.m.generation;
        const isCancelled = (): boolean => this.m.destroyed || generation !== this.m.generation;

        this.m.calculating = true;
        this.m.status = { kind: 'analyzing' };
        this.m.emitState(true);

        let result: RoutePlanResult;

        try {
            result = await this.m.planner.plan({
                start,
                waypoints,
                mode: this.m.mode,
                waterCapable: this.m.effectiveWaterCapable(),
                performance: this.m.effectivePerformance(),
                groundFastest: this.m.groundFastest,
                validate,
                cancelled: isCancelled,
            });
        } catch (error) {
            console.error('GPS: route plan failed', error);
            result = { ok: false, reason: 'error' };
        }

        if (isCancelled()) {
            return;
        }

        this.m.calculating = false;

        // Debug only: refresh the overlay grid from this plan (no-op otherwise).
        this.m.debugProbe.setDebugGrid(result.debug ?? null);

        if (result.ok && result.route) {
            this.m.status = null;
            this.m.stale = false;
            this.m.arrived = false;
            this.m.deviation.reset();
            this.m.advisor.reset();
            this.setActiveRoute(result.route);
        } else if (result.reason === 'cancelled') {
            return;
        } else {
            this.m.status = { kind: result.reason === 'no-terrain' ? 'no-terrain' : 'no-path' };
            this.setActiveRoute(null);
        }

        this.m.emitState(true);
    }

    async recalculateRemaining(
        start: [number, number],
        reason: 'manual' | 'auto' = 'manual',
    ): Promise<void> {
        if (!this.m.activeRoute || this.m.calculating) {
            return;
        }

        const generation = this.m.generation;

        if (this.m.activeRoute.source === 'shared' && this.m.routeGeometry) {
            const projection = projectPointToPolyline(start[0], start[1], this.m.routeGeometry.points);
            const segment = projection?.segment ?? 0;
            const aheadIndex = Math.min(
                flatPointCount(this.m.routeGeometry.points) - 1,
                segment + 1,
            );
            const ahead = this.m.routeGeometry.points.slice(aheadIndex * 2, aheadIndex * 2 + 2);
            const target: [number, number] = ahead.length >= 2
                ? [ahead[0], ahead[1]]
                : this.m.activeRoute.waypoints[this.m.activeRoute.waypoints.length - 1];

            const connector = await this.planConnector(start, target);
            if (this.m.destroyed || generation !== this.m.generation) {
                // A manual Recalculate (or a newer auto repath) owns the route.
                return;
            }
            if (!connector) {
                this.m.status = { kind: 'route-failed' };
                this.m.emitState(true);
                return;
            }

            const remaining = sliceLegsFrom(
                this.m.activeRoute.legs,
                this.m.routeGeometry,
                segment,
                target,
            );
            const legs = [...connector, ...remaining].filter((leg) => leg.points.length >= 4);
            const distance = legs.reduce((total, leg) => total + leg.distance, 0);
            const eta = legs.reduce((total, leg) => total + leg.eta, 0);

            this.setActiveRoute({
                ...this.m.activeRoute,
                legs,
                distance,
                eta: Number.isFinite(eta) ? eta : null,
            });
            this.m.stale = false;
            if (reason === 'auto') {
                this.m.repathCount += 1;
            }
            this.m.emitState(true);
            return;
        }

        const remaining = this.m.waypoints.filter((waypoint) => {
            if (!this.m.routeGeometry) {
                return true;
            }
            const along = projectionAlong(waypoint, this.m.routeGeometry.points);
            const current = projectPointToPolyline(start[0], start[1], this.m.routeGeometry.points);
            return along === null || !current || along > current.along + 5;
        });

        if (remaining.length === 0) {
            return;
        }

        const before = this.m.activeRoute;
        await this.planRoute(start, remaining, true);

        // `planRoute` keeps the previous route on failure, so only a new route
        // object counts as a replacement.
        if (reason === 'auto' && this.m.activeRoute !== null && this.m.activeRoute !== before) {
            this.m.repathCount += 1;
        }
    }

    async planConnector(
        start: [number, number],
        target: [number, number],
    ): Promise<RouteLeg[] | null> {
        if (distanceBetween(start[0], start[1], target[0], target[1]) < 5) {
            return [];
        }

        if (this.m.mode === 'air') {
            const distance = distanceBetween(start[0], start[1], target[0], target[1]);
            const speed = legSpeed('air', 'air', this.m.performance, false);
            return [{
                mode: 'air',
                kind: 'air',
                points: [start[0], start[1], target[0], target[1]],
                distance,
                eta: speed > 0 ? distance / speed : 0,
                source: 'connector',
            }];
        }

        const result = await this.m.planner.plan({
            start,
            waypoints: [target],
            mode: this.m.mode,
            waterCapable: this.m.effectiveWaterCapable(),
            performance: this.m.effectivePerformance(),
            cancelled: () => this.m.destroyed,
        });

        if (!result.ok || !result.route) {
            return null;
        }

        return result.route.legs.map((leg) => ({ ...leg, source: 'connector' as const }));
    }

    setActiveRoute(route: ActiveRoute | null): void {
        this.m.navigation.cancelArrivalClear();
        this.m.activeRoute = route;
        this.m.routeGeometry = route ? buildRouteGeometry(route.legs) : null;
        this.m.waypointAlong = route && this.m.routeGeometry
            ? route.waypoints.map((waypoint) =>
                projectionAlong(waypoint, this.m.routeGeometry?.points ?? []) ?? 0)
            : [];

        this.m.arrived = false;
        this.m.deviation.reset();
        this.m.deviation.resetProgress();
        this.m.arrivalSoundPlayed = false;
        this.m.lastRouteDrawAlong = -1;
        this.m.routeHover = null;
        this.m.spokenGuidance.clear();
        this.m.advisorFlow.clearAdvisorPrompt();
        this.drawRoute();
        this.m.emitState(true);
    }

    clearRoute(): void {
        this.m.generation += 1;
        this.m.activeRoute = null;
        this.m.routeGeometry = null;
        this.m.waypointAlong = [];
        this.m.routeHover = null;
        this.m.spokenGuidance.clear();
        this.m.routeSource.clear();
        this.m.routeBehindSource.clear();
        this.m.advisorSource.clear();
        this.m.navigating = false;
        this.m.arrived = false;
        this.m.deviation.reset();
        this.m.deviation.resetProgress();
        this.m.arrivalSoundPlayed = false;
        this.m.lastRouteDrawAlong = -1;
        this.m.offRoute = false;
        this.m.stale = false;
        this.m.calculating = false;
        this.m.status = null;
        this.m.advisorFlow.clearAdvisorPrompt();
    }

    drawRoute(): void {
        this.m.routeSource.clear();
        this.m.routeBehindSource.clear();
        this.m.advisorSource.clear();

        if (!this.m.activeRoute) {
            return;
        }

        const geometry = this.m.routeGeometry;
        const projection = this.m.navigating && this.m.position && geometry
            ? projectPointToPolyline(this.m.position[0], this.m.position[1], geometry.points)
            : null;
        const along = projection?.along ?? null;

        if (projection !== null && along !== null && geometry) {
            // Fade the part already travelled, so the remaining line stands out.
            for (const leg of this.m.activeRoute.legs) {
                if (leg.points.length < 4) {
                    continue;
                }
                this.m.routeBehindSource.addFeature(
                    new Feature(new LineString(flattenToCoordinates(leg.points))),
                );
            }

            // `sliceLegsFrom` takes a flattened segment index, not metres along
            // the route. Passing the distance made the ahead slice jump past the
            // player and faded the whole route instead of only the passed part.
            const ahead = sliceLegsFrom(
                this.m.activeRoute.legs,
                geometry,
                projection.segment,
                this.m.position,
            );
            for (const leg of ahead) {
                if (leg.points.length < 4) {
                    continue;
                }
                const feature = new Feature(new LineString(flattenToCoordinates(leg.points)));
                feature.setStyle(this.routeStyle(leg.kind, leg.mode, leg.passable !== false));
                this.m.routeSource.addFeature(feature);
            }
            this.m.lastRouteDrawAlong = along;
            return;
        }

        for (const leg of this.m.activeRoute.legs) {
            if (leg.points.length < 4) {
                continue;
            }
            const feature = new Feature(new LineString(flattenToCoordinates(leg.points)));
            feature.setStyle(this.routeStyle(leg.kind, leg.mode, leg.passable !== false));
            this.m.routeSource.addFeature(feature);
        }
    }

    drawSharedPreview(data: SharedRouteData): void {
        this.m.sharedSource.clear();

        const legs = sharedRouteLegs(data);
        for (const leg of legs) {
            if (leg.points.length < 4) {
                continue;
            }
            const feature = new Feature(new LineString(flattenToCoordinates(leg.points)));
            feature.setStyle(this.sharedStyle(leg.kind));
            this.m.sharedSource.addFeature(feature);
        }

        const waypoints = sharedRouteWaypoints(data);
        for (let index = 0; index < waypoints.length; index += 1) {
            const feature = new Feature(new Point(waypoints[index]));
            feature.setStyle(this.waypointStyle(index));
            this.m.sharedSource.addFeature(feature);
        }
    }

    private routeStyle(kind: RouteLegKind, mode: TravelMode, passable = true): Style {
        const key = `${mode}:${kind}:${passable ? 'ok' : 'blocked'}`;
        const cached = this.m.legStyles.get(key);
        if (cached) {
            return cached;
        }

        const colors: Record<RouteLegKind, string> = {
            road: '#22c55e',
            offroad: '#f59e0b',
            walk: '#38bdf8',
            water: '#3b82f6',
            air: '#a78bfa',
        };
        const dashed = !passable || kind === 'walk' || kind === 'air';

        const style = new Style({
            stroke: new Stroke({
                color: passable ? colors[kind] : '#ef4444',
                width: passable ? (mode === 'air' ? 2 : 4) : 5,
                lineDash: dashed ? [8, 6] : undefined,
            }),
        });

        this.m.legStyles.set(key, style);
        return style;
    }

    private sharedStyle(kind: RouteLegKind): Style {
        return new Style({
            stroke: new Stroke({
                color: kind === 'walk' ? 'rgba(56, 189, 248, 0.9)' : 'rgba(34, 211, 238, 0.9)',
                width: 3,
                lineDash: [6, 6],
            }),
        });
    }
}
