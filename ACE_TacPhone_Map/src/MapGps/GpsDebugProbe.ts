/**
 * Debug/test probe for the GPS module (the `window.__TACPHONE_MAP_TEST__.gps`
 * surface) plus the debug-only route-planning cost/height overlay layers.
 *
 * Split out of `GpsModule` (the orchestrator). The module is still the object
 * registered as the `MapGpsTestProbe`; it keeps thin public delegators that
 * forward to this class. The class holds a back-reference to the module (`m`)
 * and reads/writes the shared GPS state through it.
 */

import ImageLayer from 'ol/layer/Image';
import ImageStatic from 'ol/source/ImageStatic';
import VectorSource from 'ol/source/Vector';
import { Style, Stroke } from 'ol/style';

import { remainingEta } from '../routing/RouteMetrics';
import type {
    MapGpsDebugState,
    MapGpsLayerDebugState,
    MapGpsLayersDebugState,
} from '../MapMarkers/MapTestHooks';
import {
    buildCostOverlayCanvas,
    buildHeightOverlayCanvas,
    debugGridExtent,
    sampleDebugGrid,
    type DebugSample,
} from './GpsDebugOverlay';
import type { GpsDebugOverlayMode, RouteDebugGrid } from './GpsTypes';
import {
    decodeSharedRoute,
    flatPointCount,
    normalizeDegrees,
    sharedRoutePrimaryMode,
    sharedRouteWalkDistance,
} from './SharedRoute';
import type { WaterRouteWaypoints } from './RoutePlanner';
import type { GpsModule } from './GpsModule';

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** First stroke of a feature style, so the tests can read dash/color. */
function findStroke(style: unknown): Stroke | null {
    if (style instanceof Style) {
        return style.getStroke() ?? null;
    }

    if (Array.isArray(style)) {
        for (const entry of style) {
            const stroke = findStroke(entry);
            if (stroke) {
                return stroke;
            }
        }
    }

    return null;
}

/** Feature count plus the styles actually set on one GPS line layer. */
function describeLineLayer(source: VectorSource): MapGpsLayerDebugState {
    const features = source.getFeatures();
    const colors: string[] = [];
    let lineDash: number[] = [];

    for (const feature of features) {
        const stroke = findStroke(feature.getStyle());
        if (!stroke) {
            continue;
        }

        const color = stroke.getColor();
        if (color !== null && color !== undefined) {
            colors.push(String(color));
        }

        if (lineDash.length === 0) {
            lineDash = [...(stroke.getLineDash() ?? [])];
        }
    }

    return { features: features.length, lineDash, colors };
}

/** Debug/test probe and the debug cost/height overlay layers. */
export class GpsDebugProbe {
    private readonly m: GpsModule;

    constructor(m: GpsModule) {
        this.m = m;
    }

    /** Live state for the browser tests; reads module fields, not `state`. */
    getGpsDebugState(): MapGpsDebugState {
        const metrics = this.m.activeRoute ? this.m.navigation.currentMetrics() : null;
        const rotation = this.m.map.getView().getRotation();
        const remaining = metrics?.remaining ?? this.m.activeRoute?.distance ?? 0;
        const remainingTime = remainingEta(
            this.m.activeRoute?.eta ?? null,
            this.m.activeRoute?.distance ?? 0,
            remaining,
        );

        let shared: MapGpsDebugState['shared'] = null;
        if (this.m.sharedPreview) {
            shared = {
                author: this.m.sharedPreview.author,
                mode: sharedRoutePrimaryMode(this.m.sharedPreview),
                distance: this.m.sharedPreview.distance,
                eta: this.m.sharedPreview.eta,
                waypointCount: flatPointCount(this.m.sharedPreview.waypoints),
                walkDistance: sharedRouteWalkDistance(this.m.sharedPreview),
                label: this.m.sharedPreview.label,
            };
        }

        return {
            hasFix: this.m.hasFix,
            heading: this.m.heading,
            position: this.m.position ? [this.m.position[0], this.m.position[1]] : null,
            speed: this.m.speed,
            mode: this.m.mode,
            detectedMode: this.m.detectedMode,
            waterCapable: this.m.waterCapable,
            planning: this.m.planning,
            navigating: this.m.navigating,
            calculating: this.m.calculating,
            rotating: this.m.settings.rotateWithPlayer,
            mapRotation: normalizeDegrees((rotation * 180) / Math.PI),
            offRoute: this.m.offRoute,
            stale: this.m.stale,
            arrived: this.m.arrived,
            turn: this.m.turn,
            turnDistance: this.m.turnDistance,
            waypoints: this.m.waypoints.map((point): [number, number] => [point[0], point[1]]),
            route: this.m.activeRoute
                ? {
                    source: this.m.activeRoute.source,
                    distance: this.m.activeRoute.distance,
                    eta: this.m.activeRoute.eta,
                    remaining,
                    remainingEta: remainingTime,
                    walkDistance: this.m.activeRoute.legs
                        .filter((leg) => leg.kind === 'walk')
                        .reduce((total, leg) => total + leg.distance, 0),
                    legs: this.m.activeRoute.legs.map((leg) => ({
                        mode: leg.mode,
                        kind: leg.kind,
                        surface: leg.surface,
                        roadKind: leg.roadKind,
                        passable: leg.passable,
                        distance: leg.distance,
                        eta: leg.eta,
                        pointCount: flatPointCount(leg.points),
                        source: leg.source,
                    })),
                }
                : null,
            shared,
            advisor: this.m.advisor.prompt,
            status: this.m.status,
            fixCount: this.m.fixCount,
            vehicleChangesApplied: this.m.vehicleChangesApplied,
            repathCount: this.m.repathCount,
            liveUpdates: this.m.liveUpdates,
            road: this.m.planner.getRoadStats(),
            heights: this.m.planner.getHeightStats(),
            debug: {
                enabled: this.m.debugEnabled,
                overlay: this.m.debugOverlay,
                alpha: this.m.debugAlpha,
                hasGrid: this.m.lastDebugGrid !== null,
                costLayer: this.m.debugCostLayer !== null,
                heightLayer: this.m.debugHeightLayer !== null,
                slopeInfluence: this.m.debugSlopeInfluence,
            },
            layers: this.getLayersDebugState(),
        };
    }

    /** Replaces the waypoint list with clamped copies of `points`. */
    setWaypoints(points: Array<[number, number]>): void {
        // New waypoints cancel a pending arrival auto-clear.
        this.m.navigation.cancelArrivalClear();
        const next: Array<[number, number]> = [];

        for (const point of points) {
            if (!Array.isArray(point) || point.length < 2) {
                continue;
            }

            const clamped = this.m.routes.clampToTerrain([Number(point[0]), Number(point[1])]);
            if (clamped) {
                next.push(clamped);
            }
        }

        this.m.waypoints = next;
        this.m.routes.rebuildWaypointLayer();
        this.m.routes.scheduleMeasurements();

        if (this.m.waypoints.length === 0) {
            this.m.routes.clearRoute();
        } else {
            this.m.routes.schedulePreviewRoute();
        }

        this.m.emitState(true);
    }

    /** Decodes and previews a shared route, exactly like the overlay does. */
    async openSharedRoute(route: unknown): Promise<boolean> {
        if (this.m.destroyed) {
            return false;
        }

        const decoded = decodeSharedRoute(route, this.m.planner.getBounds() ?? undefined);
        if (!decoded.ok) {
            return false;
        }

        return this.m.showSharedRoutePreview(decoded.data);
    }

    /** Debug only: ignores `GPS.Update` pushes while disabled. */
    setLiveUpdates(enabled: boolean): void {
        this.m.liveUpdates = enabled === true;
    }

    /**
     * Debug only: picks which route-planning overlay is drawn.
     *
     * `mode` selects none/cost/height/both, `slopeInfluence` decides whether
     * the cost overlay multiplies in the slope component (ignored when the
     * planner had no height data). Both are inert in non-debug builds.
     */
    setDebugOverlay(
        mode: GpsDebugOverlayMode,
        slopeInfluence: boolean,
        alpha = this.m.debugAlpha,
    ): void {
        if (this.m.destroyed || !this.m.debugEnabled) {
            return;
        }

        this.m.debugOverlay = mode === 'cost' || mode === 'height' || mode === 'both'
            ? mode
            : 'none';
        this.m.debugSlopeInfluence = slopeInfluence !== false;
        this.m.debugAlpha = Math.max(0.05, Math.min(1, Number.isFinite(alpha) ? alpha : this.m.debugAlpha));
        this.updateDebugLayers();
    }

    /**
     * Debug only: scans the visible map extent and draws the cost/slope
     * overlays without planning a route. This is the "why is this area
     * expensive?" view, available even before a waypoint exists.
     */
    public async scanDebugViewport(mode?: GpsDebugOverlayMode): Promise<boolean> {
        if (this.m.destroyed || !this.m.debugEnabled) {
            return false;
        }

        const size = this.m.map.getSize();
        if (!size || size[0] <= 0 || size[1] <= 0) {
            return false;
        }

        const extent = this.m.map.getView().calculateExtent(size);
        const overlay = mode ?? this.m.debugOverlay;
        this.m.debugOverlay = overlay === 'none' ? 'cost' : overlay;

        const grid = await this.m.planner.scanDebugGrid(
            [extent[0], extent[1], extent[2], extent[3]],
            this.m.mode,
            this.m.effectiveWaterCapable(),
            this.m.effectivePerformance(),
        );

        if (this.m.destroyed) {
            return false;
        }

        this.setDebugGrid(grid);
        return grid !== null;
    }

    /** Debug only: values under the mouse for the hover readout. */
    public getDebugSampleAt(position: [number, number]): DebugSample | null {
        if (!this.m.debugEnabled || !this.m.lastDebugGrid) {
            return null;
        }
        return sampleDebugGrid(
            this.m.lastDebugGrid,
            position[0],
            position[1],
            this.m.debugSlopeInfluence,
        );
    }

    /** Debug only: remembers the grid from the last plan and redraws. */
    public setDebugGrid(grid: RouteDebugGrid | null): void {
        if (!this.m.debugEnabled) {
            return;
        }

        this.m.lastDebugGrid = grid;
        this.updateDebugLayers();
    }

    /** Rebuilds the overlay image layers from the stored grid. Idempotent. */
    private updateDebugLayers(): void {
        this.removeDebugLayer('cost');
        this.removeDebugLayer('height');

        if (this.m.destroyed || !this.m.debugEnabled || this.m.debugOverlay === 'none') {
            return;
        }

        const grid = this.m.lastDebugGrid;
        if (!grid) {
            return;
        }

        const extent = debugGridExtent(grid);
        const wantsCost = this.m.debugOverlay === 'cost' || this.m.debugOverlay === 'both';
        const wantsHeight = this.m.debugOverlay === 'height' || this.m.debugOverlay === 'both';

        if (wantsCost) {
            const canvas = buildCostOverlayCanvas(grid, this.m.debugSlopeInfluence, this.m.debugAlpha);
            if (canvas) {
                // Under the route, above the terrain and marker layers.
                this.m.debugCostLayer = this.createDebugLayer(canvas, extent, 5);
            }
        }

        if (wantsHeight) {
            const canvas = buildHeightOverlayCanvas(grid, this.m.debugAlpha);
            if (canvas) {
                this.m.debugHeightLayer = this.createDebugLayer(canvas, extent, 6);
            }
        }
    }

    private createDebugLayer(
        canvas: HTMLCanvasElement,
        extent: [number, number, number, number],
        zIndex: number,
    ): ImageLayer<ImageStatic> {
        const layer = new ImageLayer<ImageStatic>({
            source: new ImageStatic({
                url: canvas.toDataURL('image/png'),
                projection: this.m.map.getView().getProjection(),
                imageExtent: extent,
            }),
            zIndex,
        });

        this.m.map.addLayer(layer);
        return layer;
    }

    /** Public so the module's `destroy()` can tear the layers down. */
    public removeDebugLayer(which: 'cost' | 'height'): void {
        const layer = which === 'cost' ? this.m.debugCostLayer : this.m.debugHeightLayer;
        if (!layer) {
            return;
        }

        if (which === 'cost') {
            this.m.debugCostLayer = null;
        } else {
            this.m.debugHeightLayer = null;
        }

        // Same teardown as the other GPS layers: the layer stays registered in
        // the map's frame state, so no `dispose()` on the layer itself.
        this.m.map.removeLayer(layer);
        layer.clearRenderer();

        const source = layer.getSource();
        layer.setSource(null);
        source?.dispose();
    }

    /** Debug only: feeds a synthetic `GPS.Update` past the liveUpdates switch. */
    public applyFix(payload: unknown): void {
        this.m.handleGpsUpdate(payload, true);
    }

    /** Debug only: applies a `GPS.VehicleChanged` payload without the debounce. */
    public applyVehicle(payload: unknown): void {
        this.m.applyTravelMode(payload, true);
    }

    /** Viewport pixels of a world coordinate, or null when it is off-screen. */
    public getPixel(coordinate: [number, number]): [number, number] | null {
        const pixel = this.m.map.getPixelFromCoordinate(coordinate);
        const size = this.m.map.getSize();

        if (!pixel || !size) {
            return null;
        }

        const [x, y] = pixel;
        if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
            return null;
        }

        if (x < 0 || y < 0 || x > size[0] || y > size[1]) {
            return null;
        }

        return [x, y];
    }

    /** Terrain-only water lookup plus the nearest water point. */
    public queryWater(
        point: [number, number],
        radiusM: number,
    ): Promise<{ water: boolean; nearestWater: [number, number] | null; hasTerrain: boolean }> {
        return this.m.planner.queryWater(point, radiusM);
    }

    /**
     * Debug/test only: a complete snapshot of the current planner result,
     * including every leg point and the flattened route geometry. This is what
     * `window.__TACPHONE_DEBUG_EVAL__` reads when a route looks wrong.
     */
    public getRouteDebugSnapshot(): unknown {
        return {
            position: this.m.position ? [this.m.position[0], this.m.position[1]] : null,
            mode: this.m.mode,
            detectedMode: this.m.detectedMode,
            waterCapable: this.m.waterCapable,
            planning: this.m.planning,
            navigating: this.m.navigating,
            waypoints: this.m.waypoints.map((point) => [point[0], point[1]]),
            route: this.m.activeRoute
                ? {
                    source: this.m.activeRoute.source,
                    distance: this.m.activeRoute.distance,
                    eta: this.m.activeRoute.eta,
                    waypoints: this.m.activeRoute.waypoints.map((point) => [point[0], point[1]]),
                    legs: this.m.activeRoute.legs.map((leg) => ({
                        mode: leg.mode,
                        kind: leg.kind,
                        surface: leg.surface,
                        roadKind: leg.roadKind,
                        passable: leg.passable,
                        distance: leg.distance,
                        eta: leg.eta,
                        source: leg.source,
                        points: [...leg.points],
                    })),
                }
                : null,
            geometry: this.m.routeGeometry
                ? {
                    points: [...this.m.routeGeometry.points],
                    legStarts: [...this.m.routeGeometry.legStarts],
                    total: this.m.routeGeometry.total,
                }
                : null,
            turn: this.m.turn,
            turnDistance: this.m.turnDistance,
            offRoute: this.m.offRoute,
            status: this.m.status,
            debugGrid: this.m.lastDebugGrid
                ? {
                    bbox: [...this.m.lastDebugGrid.bbox],
                    cell: this.m.lastDebugGrid.cell,
                    width: this.m.lastDebugGrid.width,
                    height: this.m.lastDebugGrid.height,
                    hasSlope: this.m.lastDebugGrid.hasSlope,
                }
                : null,
        };
    }

    /** Debug/test only: a nearby water-only boat destination. */
    public findBoatTarget(start: [number, number]): Promise<[number, number] | null> {
        return this.m.planner.findBoatTarget(start);
    }

    /** Debug/test only: road/water/road waypoints for a water-capable route. */
    public findWaterRouteWaypoints(start: [number, number]): Promise<WaterRouteWaypoints | null> {
        return this.m.planner.findWaterRouteWaypoints(start);
    }

    /** Debug/test only: nearest road nodes and a road path. */
    public debugRoadQuery(
        start: [number, number],
        goal: [number, number],
    ): {
        startNode: number | null;
        goalNode: number | null;
        startPoint: [number, number] | null;
        goalPoint: [number, number] | null;
        pathLength: number | null;
    } {
        return this.m.planner.debugRoadQuery(start, goal, this.m.effectivePerformance(), this.m.effectiveWaterCapable());
    }

    private getLayersDebugState(): MapGpsLayersDebugState {
        return {
            route: describeLineLayer(this.m.routeSource),
            shared: describeLineLayer(this.m.sharedSource),
            advisor: describeLineLayer(this.m.advisorSource),
            waypoints: { features: this.m.waypointSource.getFeatures().length },
            playerIcon: {
                visible: this.m.hasFix,
                rotation: this.m.playerIcon.getRotation(),
            },
        };
    }
}
