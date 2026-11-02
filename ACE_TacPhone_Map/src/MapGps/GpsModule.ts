/**
 * Imperative GPS module for an existing OpenLayers map.
 *
 * Mirrors the `MarkerModule` split: this class owns the GPS layers, the game
 * command handlers, player tracking, route calculation, the shared-route
 * preview/start flow and the transport-mode advisor. It never renders React;
 * the overlay subscribes through {@link GpsModuleCallbacks.onStateChange}.
 *
 * Player tracking data comes from the game at 10 Hz:
 *
 * ```
 * { a: 'ACE_TacPhone_Map', c: 'GPS.Update',
 *   position, view, direction, speed, velocity }
 * ```
 *
 * Vehicle changes arrive as `GPS.VehicleChanged` and are debounced because
 * `GetOutMan` + `GetInMan` fire back to back when switching vehicles.
 */

import type { TerrainData } from '@ace-tacphone/api';
import type OlMap from 'ol/Map';
import type MapBrowserEvent from 'ol/MapBrowserEvent';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import ImageStatic from 'ol/source/ImageStatic';
import VectorSource from 'ol/source/Vector';
import DragPan from 'ol/interaction/DragPan';
import { Circle as CircleStyle, Fill, Icon, Stroke, Style, Text } from 'ol/style';

import type { GpsStartRouteOptions, MapFlyToOptions } from '../api';
import { mapCommandRegistry } from '../CommandRegistry';
import { t } from '../i18n';
import {
    registerGpsTestProbe,
    unregisterGpsTestProbe,
    type MapGpsDebugState,
    type MapGpsLayerDebugState,
    type MapGpsLayersDebugState,
    type MapGpsTestProbe,
} from '../MapMarkers/MapTestHooks';
import { onGpsSettingsChanged, readGpsSettings, type GpsSettings } from '../MapOptions';
import { getTerrainHeights } from '../MapMarkers/TerrainHeightApi';
import {
    DEBUG_OVERLAY_ALPHA,
    buildCostOverlayCanvas,
    buildHeightOverlayCanvas,
    debugGridExtent,
    sampleDebugGrid,
    type DebugSample,
} from './GpsDebugOverlay';
import type {
    ActiveRoute,
    AdvisorPrompt,
    GpsDebugOverlayMode,
    GpsStatus,
    GpsViewState,
    RouteDebugGrid,
    RouteLeg,
    RouteLegKind,
    RoutePlanResult,
    RouteSummary,
    SharedPreviewInfo,
    TravelMode,
    VehiclePerformance,
} from './GpsTypes';
import { createInitialGpsViewState, isTravelMode } from './GpsTypes';
import { RoutePlanner, type WaterRouteWaypoints } from './RoutePlanner';
import { legSpeed } from '../routing/SpeedModel';
import { computeRouteMetrics, remainingEta } from '../routing/RouteMetrics';
import { nextManeuver, nextWaypointAhead } from '../routing/TurnInstructions';
import { DeviationTracker } from '../routing/DeviationTracker';
import { parseVehicleChange, VehicleChangeDebouncer } from '../routing/VehicleChange';
import {
    buildRouteGeometry,
    flattenToCoordinates,
    projectionAlong,
    sliceLegsFrom,
    type RouteGeometry,
} from './RouteSplice';
import { TransportModeAdvisor } from './TransportModeAdvisor';
import {
    decodeSharedRoute,
    distanceBetween,
    flatPointCount,
    normalizeDegrees,
    projectPointToPolyline,
    sharedRouteBBox,
    sharedRouteLegs,
    sharedRoutePrimaryMode,
    sharedRouteWalkDistance,
    sharedRouteWaypoints,
    type SharedRouteData,
} from './SharedRoute';

/** Game-side GPS interest; must match INTEREST_GPS in the game add-on. */
export const GPS_INTEREST = 'ACE_TacPhone_Map.gps';

const MAP_APP = 'ACE_TacPhone_Map';

const FOLLOW_SUSPEND_MS = 5000;

/** Player speed above which the advisor may offer an alternative. */
const ADVISOR_MIN_SPEED = 1;

const PLAYER_ICON_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">',
    '<circle cx="24" cy="24" r="17" fill="#0284c7" stroke="#ffffff" stroke-width="3"/>',
    '<path d="M24 9 L33 32 L24 26 L15 32 Z" fill="#ffffff"/>',
    '</svg>',
].join('');
const PLAYER_ICON_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(PLAYER_ICON_SVG)}`;

/** Callbacks the React overlay provides. */
export interface GpsModuleCallbacks {
    onStateChange(state: GpsViewState): void;
    /** Used to fit the previewed shared route without touching follow state. */
    flyTo(options: MapFlyToOptions): void;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** True only in debug builds where the game allows debug (`gameInfo.isDebug`). */
function isDebugEnabled(): boolean {
    try {
        return window.TacPhone.gameInfo.isDebug() === true;
    } catch {
        return false;
    }
}

function readPoint(value: unknown): [number, number] | null {
    if (!Array.isArray(value) || value.length < 2) {
        return null;
    }
    const x = value[0];
    const y = value[1];
    return isFiniteNumber(x) && isFiniteNumber(y) ? [x, y] : null;
}

function readNumbers(value: unknown, minimumLength: number): number[] | null {
    if (!Array.isArray(value) || value.length < minimumLength) {
        return null;
    }
    if (!value.every(isFiniteNumber)) {
        return null;
    }
    return value as number[];
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

/** Imperative GPS behaviour for one OpenLayers map. */
export class GpsModule implements MapGpsTestProbe {
    private readonly map: OlMap;
    private readonly callbacks: GpsModuleCallbacks;

    private readonly playerSource = new VectorSource();
    private readonly routeSource = new VectorSource();
    private readonly routeBehindSource = new VectorSource();
    private readonly sharedSource = new VectorSource();
    private readonly advisorSource = new VectorSource();
    private readonly waypointSource = new VectorSource();
    private readonly measurementSource = new VectorSource();

    private readonly playerLayer: VectorLayer<VectorSource>;
    private readonly routeLayer: VectorLayer<VectorSource>;
    private readonly routeBehindLayer: VectorLayer<VectorSource>;
    private readonly sharedLayer: VectorLayer<VectorSource>;
    private readonly advisorLayer: VectorLayer<VectorSource>;
    private readonly waypointLayer: VectorLayer<VectorSource>;
    private readonly measurementLayer: VectorLayer<VectorSource>;

    private readonly playerIcon = new Icon({
        src: PLAYER_ICON_URL,
        anchor: [0.5, 0.5],
        rotation: 0,
    });
    private readonly playerFeature = new Feature(new Point([0, 0]));
    private readonly legStyles = new Map<string, Style>();
    private readonly waypointStyles: Style[] = [];

    private readonly unregisterUpdate: () => void;
    private readonly unregisterVehicle: () => void;
    private readonly unsubscribeOptions: () => void;

    private settings: GpsSettings = { rotateWithPlayer: true, autoRepath: false };
    private readonly planner = new RoutePlanner(null);

    private state: GpsViewState = createInitialGpsViewState();
    private mode: TravelMode = 'foot';
    private detectedMode: TravelMode = 'foot';
    private waterCapable = false;
    private performance: VehiclePerformance = {};
    private manualMode = false;

    private position: [number, number] | null = null;
    private heading: number | null = null;
    private speed = 0;
    private hasFix = false;

    private followEnabled = true;
    private followSuspendedUntil = 0;
    private lastCenter: [number, number] | null = null;
    private lastCenterHeading: number | null = null;
    private everCentered = false;
    private terrainRecenterTimer: number | null = null;
    private planning = false;

    private waypoints: Array<[number, number]> = [];
    private activeRoute: ActiveRoute | null = null;
    private routeGeometry: RouteGeometry | null = null;
    private waypointAlong: number[] = [];

    private navigating = false;
    private arrived = false;
    private stale = false;
    private turn: 'left' | 'right' | 'straight' | null = null;
    private turnDistance: number | null = null;
    private offRoute = false;
    private readonly deviation = new DeviationTracker();
    private lastRouteDrawAlong = -1;
    private arrivalSoundPlayed = false;

    private calculating = false;
    private status: GpsStatus | null = null;

    private sharedPreview: SharedRouteData | null = null;

    private readonly advisor = new TransportModeAdvisor();
    private advisorPlanning = false;
    private advisorToken = 0;
    /** Alternative route drawn for the shown offer; spliced on accept. */
    private advisorAlternative: ActiveRoute | null = null;

    private previewTimer: number | null = null;
    private measurementTimer: number | null = null;
    private measurementToken = 0;
    private waypointDrag: { index: number; pointerId: number } | null = null;
    private waypointDragMoved = false;
    private lastWaypointDragAt = 0;

    private generation = 0;
    private readonly vehicleChanges: VehicleChangeDebouncer;
    private destroyed = false;
    private lastEmitAt = 0;

    // Debug-only test counters and the `setLiveUpdates` switch; the browser
    // tests read them through the debug hook and nothing else depends on them.
    private liveUpdates = true;
    private fixCount = 0;
    private vehicleChangesApplied = 0;
    /** Auto-repaths that actually replaced the route (off-route recovery). */
    private repathCount = 0;

    // Debug-only route-planning overlay (see `setDebugOverlay`). All of it is
    // inert unless `gameInfo.isDebug()` is true when the module is created.
    private readonly debugEnabled: boolean = isDebugEnabled();
    private debugOverlay: GpsDebugOverlayMode = 'none';
    private debugSlopeInfluence = true;
    private debugAlpha = DEBUG_OVERLAY_ALPHA;
    private lastDebugGrid: RouteDebugGrid | null = null;
    private debugCostLayer: ImageLayer<ImageStatic> | null = null;
    private debugHeightLayer: ImageLayer<ImageStatic> | null = null;

    constructor(map: OlMap, callbacks: GpsModuleCallbacks) {
        this.map = map;
        this.callbacks = callbacks;

        this.readSettings();
        this.vehicleChanges = new VehicleChangeDebouncer((payload) => {
            this.applyTravelMode(payload, true);
        });

        if (this.debugEnabled) {
            // Debug-only: collect the planning grid with every plan.
            this.planner.setDebug(true);
        }

        this.playerLayer = new VectorLayer<VectorSource>({
            source: this.playerSource,
            style: new Style({ image: this.playerIcon }),
            zIndex: 70,
        });
        this.routeBehindLayer = new VectorLayer<VectorSource>({
            source: this.routeBehindSource,
            zIndex: 29,
            style: new Style({ stroke: new Stroke({ color: 'rgba(100, 116, 139, 0.22)', width: 3 }) }),
        });
        this.routeLayer = new VectorLayer<VectorSource>({ source: this.routeSource, zIndex: 30 });
        this.sharedLayer = new VectorLayer<VectorSource>({ source: this.sharedSource, zIndex: 28 });
        this.advisorLayer = new VectorLayer<VectorSource>({ source: this.advisorSource, zIndex: 29 });
        this.waypointLayer = new VectorLayer<VectorSource>({ source: this.waypointSource, zIndex: 40 });
        this.measurementLayer = new VectorLayer<VectorSource>({ source: this.measurementSource, zIndex: 45 });

        this.playerFeature.setStyle(new Style({ image: this.playerIcon }));
        this.playerSource.addFeature(this.playerFeature);

        for (const layer of [
            this.sharedLayer,
            this.advisorLayer,
            this.routeBehindLayer,
            this.routeLayer,
            this.waypointLayer,
            this.measurementLayer,
            this.playerLayer,
        ]) {
            this.map.addLayer(layer);
        }

        this.unregisterUpdate = mapCommandRegistry.register('GPS.Update', (payload) => {
            this.handleGpsUpdate(payload);
        });
        this.unregisterVehicle = mapCommandRegistry.register('GPS.VehicleChanged', (payload) => {
            this.handleVehicleChanged(payload);
        });

        this.unsubscribeOptions = onGpsSettingsChanged((settings) => {
            this.settings = settings;
            this.applyRotation(true);
            this.emitState(true);
        });

        this.map.on('singleclick', this.handleSingleClick);
        this.map.on('pointerdrag', this.handleUserPan);
        this.map.getViewport().addEventListener('wheel', this.handleUserPan, { passive: true });
        this.map.getViewport().addEventListener('pointerdown', this.handleWaypointPointerDown, true);
        this.map.getViewport().addEventListener('pointermove', this.handleWaypointPointerMove, true);
        this.map.getViewport().addEventListener('pointerup', this.handleWaypointPointerUp, true);
        this.map.getViewport().addEventListener('pointercancel', this.handleWaypointPointerUp, true);

        // Unconditional, like MarkerModule: the registry is only reachable
        // through the dev-only `window.__TACPHONE_MAP_TEST__` hook.
        registerGpsTestProbe(this);

        void this.requestTravelMode();
        this.emitState(true);
    }

    // ---------------------------------------------------------------------
    // Public API used by the overlay
    // ---------------------------------------------------------------------

    public getState(): GpsViewState {
        return this.state;
    }

    public getActiveRoute(): ActiveRoute | null {
        return this.activeRoute;
    }

    public getTerrainBounds(): { width: number; height: number } | null {
        return this.planner.getBounds();
    }

    /** Vehicle snapshot used for the shared payload's ETA comparison. */
    public getPerformanceSnapshot(): VehiclePerformance | undefined {
        if (this.detectedMode === 'foot') {
            return undefined;
        }
        return { ...this.performance, canFloat: this.waterCapable };
    }

    /** Performance only applies when the selected mode matches the vehicle. */
    private effectivePerformance(): VehiclePerformance | undefined {
        return this.mode === this.detectedMode ? this.performance : undefined;
    }

    private effectiveWaterCapable(): boolean {
        return this.mode === this.detectedMode && this.waterCapable;
    }

    /** Applies the terrain snapshot loaded by the Map panel. */
    public setTerrain(terrain: TerrainData | null): void {
        if (this.destroyed) {
            return;
        }

        this.planner.setTerrain(terrain);
        // A new terrain snapshot invalidates the debug grid's masks and heights.
        this.setDebugGrid(null);
        // The Map replaces its view when terrain arrives. Recenter immediately
        // if a fix already exists; waiting for the next movement left the GPS
        // stuck at the whole-terrain fit when the player was stationary.
        this.everCentered = false;
        this.lastCenter = null;
        this.lastCenterHeading = null;
        // A flyTo/pan in progress owns the view; do not override it just because
        // a terrain snapshot arrived after the command.
        if (this.position && Date.now() >= this.followSuspendedUntil) {
            const view = this.map.getView();
            view.setCenter(this.position);
            this.lastCenter = this.position;
            this.lastCenterHeading = this.heading;
            this.everCentered = true;
        }

        // Tiles can finish after the view replacement and leave the GPS at the
        // whole-terrain center. Validate once more shortly after the load.
        if (this.terrainRecenterTimer !== null) {
            window.clearTimeout(this.terrainRecenterTimer);
            this.terrainRecenterTimer = null;
        }
        if (this.position && Date.now() >= this.followSuspendedUntil) {
            this.terrainRecenterTimer = window.setTimeout(() => {
                this.terrainRecenterTimer = null;
                if (this.destroyed || !this.position || !this.isFollowing) {
                    return;
                }
                const view = this.map.getView();
                const center = view.getCenter();
                if (!center || distanceBetween(center[0], center[1], this.position[0], this.position[1]) > 5) {
                    view.setCenter(this.position);
                    this.lastCenter = this.position;
                    this.lastCenterHeading = this.heading;
                    this.everCentered = true;
                }
            }, 1200);
        }
        this.generation += 1;
        this.calculating = false;
        this.emitState(true);
    }

    /** Switches the planning mode; the player may override the detected mode. */
    public setMode(mode: TravelMode): void {
        if (!isTravelMode(mode) || this.destroyed) {
            return;
        }

        this.mode = mode;
        this.manualMode = true;

        if (this.activeRoute && this.navigating) {
            void this.recalculate();
        }

        this.emitState(true);
    }

    /** Enables or disables waypoint placement on map taps. */
    public setPlanning(active: boolean): void {
        this.planning = active;
        if (active) {
            this.status = null;
        }
        this.emitState(true);
    }

    public addWaypoint(coordinate: [number, number]): void {
        const point = this.clampToTerrain(coordinate);
        if (!point) {
            return;
        }

        this.waypoints.push(point);
        this.planning = true;
        this.rebuildWaypointLayer();
        this.scheduleMeasurements();
        this.schedulePreviewRoute();
        this.emitState(true);
    }

    public removeWaypoint(index: number): void {
        if (index < 0 || index >= this.waypoints.length) {
            return;
        }

        this.waypoints.splice(index, 1);
        this.rebuildWaypointLayer();
        this.scheduleMeasurements();

        if (this.waypoints.length === 0) {
            this.clearRoute();
        } else {
            this.schedulePreviewRoute();
        }

        this.emitState(true);
    }

    public clearWaypoints(): void {
        this.waypoints = [];
        if (this.previewTimer !== null) {
            window.clearTimeout(this.previewTimer);
            this.previewTimer = null;
        }
        if (this.measurementTimer !== null) {
            window.clearTimeout(this.measurementTimer);
            this.measurementTimer = null;
        }
        this.measurementSource.clear();
        this.rebuildWaypointLayer();
        this.clearRoute();
        this.emitState(true);
    }

    /**
     * Calculates the route from the player to the current waypoints.
     * Resolves true when a route exists afterwards; the debug probe uses it.
     */
    public async calculateRoute(): Promise<boolean> {
        if (this.waypoints.length === 0) {
            this.status = { kind: 'no-route' };
            this.emitState(true);
            return false;
        }

        const start = this.position ?? this.waypoints[0];
        await this.planRoute(start, this.waypoints, true);
        return this.activeRoute !== null;
    }

    /**
     * Plans a route to a world position and optionally starts following it.
     *
     * Used by the inter-app `map` service for "Show me how to get there"
     * actions. The travel mode is always the player's detected mode.
     */
    public async startRouteTo(
        position: [number, number],
        options: GpsStartRouteOptions = {},
    ): Promise<boolean> {
        if (this.destroyed) {
            return false;
        }

        const target = this.clampToTerrain(position);
        if (!target) {
            return false;
        }

        if (this.sharedPreview) {
            this.discardSharedRoute();
        }

        const replace = options.replace !== false;
        this.waypoints = replace ? [target] : [...this.waypoints, target];
        this.planning = false;
        this.rebuildWaypointLayer();
        this.scheduleMeasurements();

        await this.planRoute(this.position ?? this.waypoints[0], this.waypoints, true);
        if (this.destroyed || !this.activeRoute) {
            return false;
        }

        if (options.start !== false) {
            this.startNavigation();
        }

        this.emitState(true);
        return true;
    }

    /** Recalculates from the current player position. */
    public async recalculate(): Promise<void> {
        if (this.waypoints.length === 0) {
            return;
        }

        // Manual recalculate always plans a fresh local route to the current
        // waypoint list. For a shared route those waypoints were adopted at
        // Start, so this replaces the shared geometry with the current cost
        // model instead of merely splicing the old shared legs.
        await this.planRoute(this.position ?? this.waypoints[0], this.waypoints, true);
    }

    public startNavigation(): void {
        if (this.activeRoute) {
            this.navigating = true;
            this.arrived = false;
            this.planning = false;
            this.followEnabled = true;
            this.followSuspendedUntil = 0;
            this.stale = false;
            this.deviation.resetProgress();
            this.arrivalSoundPlayed = false;
            this.lastRouteDrawAlong = -1;
            this.drawRoute();
            this.emitState(true);
        } else if (this.waypoints.length > 0) {
            void this.calculateRoute().then(() => {
                if (this.activeRoute) {
                    this.startNavigation();
                }
            });
        }
    }

    public stopNavigation(): void {
        this.navigating = false;
        this.arrived = false;
        this.offRoute = false;
        this.deviation.reset();
        this.lastRouteDrawAlong = -1;
        this.clearAdvisorPrompt();
        this.drawRoute();
        this.emitState(true);
    }

    /** Cancels auto-follow for a few seconds (map API `flyTo`, panel actions). */
    public suspendFollow(): void {
        this.followSuspendedUntil = Date.now() + FOLLOW_SUSPEND_MS;
    }

    /** Shows a validated shared route as a dashed preview. */
    public showSharedRoutePreview(data: SharedRouteData): boolean {
        if (this.destroyed) {
            return false;
        }

        this.sharedPreview = data;
        this.drawSharedPreview(data);
        this.status = null;
        this.suspendFollow();

        const bbox = sharedRouteBBox(data);
        if (bbox[2] - bbox[0] > 0 || bbox[3] - bbox[1] > 0) {
            this.callbacks.flyTo({ bbox, animate: true });
        }

        this.emitState(true);
        return true;
    }

    public discardSharedRoute(): void {
        this.sharedPreview = null;
        this.sharedSource.clear();
        this.emitState(true);
    }

    /** Starts the previewed route, joining at the nearest point. */
    public async startSharedRoute(): Promise<boolean> {
        const data = this.sharedPreview;
        if (!data || this.destroyed) {
            return false;
        }

        const token = ++this.generation;
        const isCancelled = (): boolean => this.destroyed || token !== this.generation;

        const sharedLegs = sharedRouteLegs(data);
        if (sharedLegs.length === 0) {
            return false;
        }

        const waypoints = sharedRouteWaypoints(data);
        const geometry = buildRouteGeometry(sharedLegs);
        const player = this.position ?? (geometry.points.length >= 2
            ? [geometry.points[0], geometry.points[1]] as [number, number]
            : null);

        if (!player) {
            this.status = { kind: 'no-path' };
            this.emitState(true);
            return false;
        }

        const projection = projectPointToPolyline(player[0], player[1], geometry.points);
        const joinPoint: [number, number] = projection
            ? projection.point
            : [geometry.points[0], geometry.points[1]];
        const segment = projection?.segment ?? 0;

        const connector = await this.planConnector(player, joinPoint);
        if (isCancelled()) {
            return false;
        }
        if (!connector) {
            this.status = { kind: 'no-path' };
            this.emitState(true);
            return false;
        }

        const remaining = sliceLegsFrom(sharedLegs, geometry, segment, joinPoint);
        const legs = [...connector, ...remaining].filter((leg) => leg.points.length >= 4);
        if (legs.length === 0) {
            this.status = { kind: 'no-path' };
            this.emitState(true);
            return false;
        }

        const distance = legs.reduce((total, leg) => total + leg.distance, 0);
        const eta = legs.reduce((total, leg) => total + leg.eta, 0);

        const remainingWaypoints = waypoints.filter((waypoint) => {
            const along = projectionAlong(waypoint, geometry.points);
            return along === null || !projection || along > projection.along + 1;
        });

        // The destination is always kept, even when the join point is behind it.
        const routeWaypoints = remainingWaypoints.length > 0
            ? remainingWaypoints
            : waypoints.slice(-1);

        this.setActiveRoute({
            source: 'shared',
            legs,
            waypoints: routeWaypoints,
            distance,
            eta: Number.isFinite(eta) ? eta : null,
            createdAt: data.createdAt,
            label: data.label,
            author: data.author,
            shared: data,
        });

        // Starting a shared route takes over the local waypoint list, so the
        // route panel lists the shared targets instead of stale local ones.
        this.waypoints = routeWaypoints.map((point): [number, number] => [point[0], point[1]]);
        this.rebuildWaypointLayer();

        this.sharedPreview = null;
        this.sharedSource.clear();
        this.navigating = true;
        this.arrived = false;
        this.planning = false;
        this.stale = false;
        this.status = null;
        this.followEnabled = true;
        this.followSuspendedUntil = 0;
        this.advisor.reset();
        this.clearAdvisorPrompt();
        this.emitState(true);
        return true;
    }

    /** Replaces the remaining shared portion with the advisor's alternative. */
    public acceptAdvisor(): void {
        const prompt = this.advisor.prompt;
        const alternative = this.advisorAlternative;
        if (!prompt || !alternative || !this.activeRoute || !this.routeGeometry) {
            return;
        }

        const waypoint = this.activeRoute.waypoints[prompt.waypointIndex];
        const cutProjection = waypoint
            ? projectPointToPolyline(waypoint[0], waypoint[1], this.routeGeometry.points)
            : null;
        const cutSegment = cutProjection ? cutProjection.segment : this.advisor.segment;

        const remaining = sliceLegsFrom(
            this.activeRoute.legs,
            this.routeGeometry,
            cutSegment,
            null,
        );
        const alternativeLegs = alternative.legs.map((leg) => ({
            ...leg,
            source: 'advisor' as const,
        }));
        const legs = [...alternativeLegs, ...remaining].filter((leg) => leg.points.length >= 4);
        const distance = legs.reduce((total, leg) => total + leg.distance, 0);
        const eta = legs.reduce((total, leg) => total + leg.eta, 0);

        this.advisor.accept();
        this.clearAdvisorPrompt();
        this.setActiveRoute({
            ...this.activeRoute,
            legs,
            distance,
            eta: Number.isFinite(eta) ? eta : null,
        });
        this.emitState(true);
    }

    public dismissAdvisor(): void {
        if (!this.advisor.prompt) {
            return;
        }

        this.advisor.dismiss();
        this.clearAdvisorPrompt();
        this.emitState(true);
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.generation += 1;
        this.advisorToken += 1;

        unregisterGpsTestProbe(this);

        this.vehicleChanges.cancel();

        this.unregisterUpdate();
        this.unregisterVehicle();
        this.unsubscribeOptions();

        this.map.un('singleclick', this.handleSingleClick);
        this.map.un('pointerdrag', this.handleUserPan);
        const viewport = this.map.getViewport();
        viewport.removeEventListener('wheel', this.handleUserPan);
        viewport.removeEventListener('pointerdown', this.handleWaypointPointerDown, true);
        viewport.removeEventListener('pointermove', this.handleWaypointPointerMove, true);
        viewport.removeEventListener('pointerup', this.handleWaypointPointerUp, true);
        viewport.removeEventListener('pointercancel', this.handleWaypointPointerUp, true);
        if (this.previewTimer !== null) {
            window.clearTimeout(this.previewTimer);
            this.previewTimer = null;
        }
        if (this.terrainRecenterTimer !== null) {
            window.clearTimeout(this.terrainRecenterTimer);
            this.terrainRecenterTimer = null;
        }

        for (const layer of [
            this.sharedLayer,
            this.advisorLayer,
            this.routeBehindLayer,
            this.routeLayer,
            this.waypointLayer,
            this.measurementLayer,
            this.playerLayer,
        ]) {
            this.map.removeLayer(layer);

            // Do not call layer.dispose(): it nulls the layer in the shared layer
            // state while `Map.frameState_` still references it, which makes a
            // pointer event throw in forEachFeatureAtPixel(). Clearing the
            // renderer and disposing the source releases the same resources.
            layer.clearRenderer();

            const source = layer.getSource();
            layer.setSource(null);
            source?.clear();
            source?.dispose();
        }

        this.removeDebugLayer('cost');
        this.removeDebugLayer('height');
        this.lastDebugGrid = null;

        this.planner.dispose();
    }

    // ---------------------------------------------------------------------
    // Debug/test probe (window.__TACPHONE_MAP_TEST__.gps)
    // ---------------------------------------------------------------------

    /** Live state for the browser tests; reads module fields, not `state`. */
    public getGpsDebugState(): MapGpsDebugState {
        const metrics = this.activeRoute ? this.currentMetrics() : null;
        const rotation = this.map.getView().getRotation();
        const remaining = metrics?.remaining ?? this.activeRoute?.distance ?? 0;
        const remainingTime = remainingEta(
            this.activeRoute?.eta ?? null,
            this.activeRoute?.distance ?? 0,
            remaining,
        );

        let shared: MapGpsDebugState['shared'] = null;
        if (this.sharedPreview) {
            shared = {
                author: this.sharedPreview.author,
                mode: sharedRoutePrimaryMode(this.sharedPreview),
                distance: this.sharedPreview.distance,
                eta: this.sharedPreview.eta,
                waypointCount: flatPointCount(this.sharedPreview.waypoints),
                walkDistance: sharedRouteWalkDistance(this.sharedPreview),
                label: this.sharedPreview.label,
            };
        }

        return {
            hasFix: this.hasFix,
            heading: this.heading,
            position: this.position ? [this.position[0], this.position[1]] : null,
            speed: this.speed,
            mode: this.mode,
            detectedMode: this.detectedMode,
            waterCapable: this.waterCapable,
            planning: this.planning,
            navigating: this.navigating,
            calculating: this.calculating,
            rotating: this.settings.rotateWithPlayer,
            mapRotation: normalizeDegrees((rotation * 180) / Math.PI),
            offRoute: this.offRoute,
            stale: this.stale,
            arrived: this.arrived,
            turn: this.turn,
            turnDistance: this.turnDistance,
            waypoints: this.waypoints.map((point): [number, number] => [point[0], point[1]]),
            route: this.activeRoute
                ? {
                    source: this.activeRoute.source,
                    distance: this.activeRoute.distance,
                    eta: this.activeRoute.eta,
                    remaining,
                    remainingEta: remainingTime,
                    walkDistance: this.activeRoute.legs
                        .filter((leg) => leg.kind === 'walk')
                        .reduce((total, leg) => total + leg.distance, 0),
                    legs: this.activeRoute.legs.map((leg) => ({
                        mode: leg.mode,
                        kind: leg.kind,
                        distance: leg.distance,
                        eta: leg.eta,
                        pointCount: flatPointCount(leg.points),
                        source: leg.source,
                    })),
                }
                : null,
            shared,
            advisor: this.advisor.prompt,
            status: this.status,
            fixCount: this.fixCount,
            vehicleChangesApplied: this.vehicleChangesApplied,
            repathCount: this.repathCount,
            liveUpdates: this.liveUpdates,
            road: this.planner.getRoadStats(),
            heights: this.planner.getHeightStats(),
            debug: {
                enabled: this.debugEnabled,
                overlay: this.debugOverlay,
                alpha: this.debugAlpha,
                hasGrid: this.lastDebugGrid !== null,
                costLayer: this.debugCostLayer !== null,
                heightLayer: this.debugHeightLayer !== null,
                slopeInfluence: this.debugSlopeInfluence,
            },
            layers: this.getLayersDebugState(),
        };
    }

    /** Replaces the waypoint list with clamped copies of `points`. */
    public setWaypoints(points: Array<[number, number]>): void {
        const next: Array<[number, number]> = [];

        for (const point of points) {
            if (!Array.isArray(point) || point.length < 2) {
                continue;
            }

            const clamped = this.clampToTerrain([Number(point[0]), Number(point[1])]);
            if (clamped) {
                next.push(clamped);
            }
        }

        this.waypoints = next;
        this.rebuildWaypointLayer();
        this.scheduleMeasurements();

        if (this.waypoints.length === 0) {
            this.clearRoute();
        } else {
            this.schedulePreviewRoute();
        }

        this.emitState(true);
    }

    /** Decodes and previews a shared route, exactly like the overlay does. */
    public async openSharedRoute(route: unknown): Promise<boolean> {
        if (this.destroyed) {
            return false;
        }

        const decoded = decodeSharedRoute(route, this.planner.getBounds() ?? undefined);
        if (!decoded.ok) {
            return false;
        }

        return this.showSharedRoutePreview(decoded.data);
    }

    /** Debug only: ignores `GPS.Update` pushes while disabled. */
    public setLiveUpdates(enabled: boolean): void {
        this.liveUpdates = enabled === true;
    }

    /**
     * Debug only: picks which route-planning overlay is drawn.
     *
     * `mode` selects none/cost/height/both, `slopeInfluence` decides whether
     * the cost overlay multiplies in the slope component (ignored when the
     * planner had no height data). Both are inert in non-debug builds.
     */
    public setDebugOverlay(
        mode: GpsDebugOverlayMode,
        slopeInfluence: boolean,
        alpha = this.debugAlpha,
    ): void {
        if (this.destroyed || !this.debugEnabled) {
            return;
        }

        this.debugOverlay = mode === 'cost' || mode === 'height' || mode === 'both'
            ? mode
            : 'none';
        this.debugSlopeInfluence = slopeInfluence !== false;
        this.debugAlpha = Math.max(0.05, Math.min(1, Number.isFinite(alpha) ? alpha : this.debugAlpha));
        this.updateDebugLayers();
    }

    /**
     * Debug only: scans the visible map extent and draws the cost/slope
     * overlays without planning a route. This is the "why is this area
     * expensive?" view, available even before a waypoint exists.
     */
    public async scanDebugViewport(mode?: GpsDebugOverlayMode): Promise<boolean> {
        if (this.destroyed || !this.debugEnabled) {
            return false;
        }

        const size = this.map.getSize();
        if (!size || size[0] <= 0 || size[1] <= 0) {
            return false;
        }

        const extent = this.map.getView().calculateExtent(size);
        const overlay = mode ?? this.debugOverlay;
        this.debugOverlay = overlay === 'none' ? 'cost' : overlay;

        const grid = await this.planner.scanDebugGrid(
            [extent[0], extent[1], extent[2], extent[3]],
            this.mode,
            this.effectiveWaterCapable(),
            this.effectivePerformance(),
        );

        if (this.destroyed) {
            return false;
        }

        this.setDebugGrid(grid);
        return grid !== null;
    }

    /** Debug only: values under the mouse for the hover readout. */
    public getDebugSampleAt(position: [number, number]): DebugSample | null {
        if (!this.debugEnabled || !this.lastDebugGrid) {
            return null;
        }
        return sampleDebugGrid(
            this.lastDebugGrid,
            position[0],
            position[1],
            this.debugSlopeInfluence,
        );
    }

    /** Debug only: remembers the grid from the last plan and redraws. */
    private setDebugGrid(grid: RouteDebugGrid | null): void {
        if (!this.debugEnabled) {
            return;
        }

        this.lastDebugGrid = grid;
        this.updateDebugLayers();
    }

    /** Rebuilds the overlay image layers from the stored grid. Idempotent. */
    private updateDebugLayers(): void {
        this.removeDebugLayer('cost');
        this.removeDebugLayer('height');

        if (this.destroyed || !this.debugEnabled || this.debugOverlay === 'none') {
            return;
        }

        const grid = this.lastDebugGrid;
        if (!grid) {
            return;
        }

        const extent = debugGridExtent(grid);
        const wantsCost = this.debugOverlay === 'cost' || this.debugOverlay === 'both';
        const wantsHeight = this.debugOverlay === 'height' || this.debugOverlay === 'both';

        if (wantsCost) {
            const canvas = buildCostOverlayCanvas(grid, this.debugSlopeInfluence, this.debugAlpha);
            if (canvas) {
                // Under the route, above the terrain and marker layers.
                this.debugCostLayer = this.createDebugLayer(canvas, extent, 5);
            }
        }

        if (wantsHeight) {
            const canvas = buildHeightOverlayCanvas(grid, this.debugAlpha);
            if (canvas) {
                this.debugHeightLayer = this.createDebugLayer(canvas, extent, 6);
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
                projection: this.map.getView().getProjection(),
                imageExtent: extent,
            }),
            zIndex,
        });

        this.map.addLayer(layer);
        return layer;
    }

    private removeDebugLayer(which: 'cost' | 'height'): void {
        const layer = which === 'cost' ? this.debugCostLayer : this.debugHeightLayer;
        if (!layer) {
            return;
        }

        if (which === 'cost') {
            this.debugCostLayer = null;
        } else {
            this.debugHeightLayer = null;
        }

        // Same teardown as the other GPS layers: the layer stays registered in
        // the map's frame state, so no `dispose()` on the layer itself.
        this.map.removeLayer(layer);
        layer.clearRenderer();

        const source = layer.getSource();
        layer.setSource(null);
        source?.dispose();
    }

    /** Debug only: feeds a synthetic `GPS.Update` past the liveUpdates switch. */
    public applyFix(payload: unknown): void {
        this.handleGpsUpdate(payload, true);
    }

    /** Debug only: applies a `GPS.VehicleChanged` payload without the debounce. */
    public applyVehicle(payload: unknown): void {
        this.applyTravelMode(payload, true);
    }

    /** Viewport pixels of a world coordinate, or null when it is off-screen. */
    public getPixel(coordinate: [number, number]): [number, number] | null {
        const pixel = this.map.getPixelFromCoordinate(coordinate);
        const size = this.map.getSize();

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
        return this.planner.queryWater(point, radiusM);
    }

    /**
     * Debug/test only: a complete snapshot of the current planner result,
     * including every leg point and the flattened route geometry. This is what
     * `window.__TACPHONE_DEBUG_EVAL__` reads when a route looks wrong.
     */
    public getRouteDebugSnapshot(): unknown {
        return {
            position: this.position ? [this.position[0], this.position[1]] : null,
            mode: this.mode,
            detectedMode: this.detectedMode,
            waterCapable: this.waterCapable,
            planning: this.planning,
            navigating: this.navigating,
            waypoints: this.waypoints.map((point) => [point[0], point[1]]),
            route: this.activeRoute
                ? {
                    source: this.activeRoute.source,
                    distance: this.activeRoute.distance,
                    eta: this.activeRoute.eta,
                    waypoints: this.activeRoute.waypoints.map((point) => [point[0], point[1]]),
                    legs: this.activeRoute.legs.map((leg) => ({
                        mode: leg.mode,
                        kind: leg.kind,
                        distance: leg.distance,
                        eta: leg.eta,
                        source: leg.source,
                        points: [...leg.points],
                    })),
                }
                : null,
            geometry: this.routeGeometry
                ? {
                    points: [...this.routeGeometry.points],
                    legStarts: [...this.routeGeometry.legStarts],
                    total: this.routeGeometry.total,
                }
                : null,
            turn: this.turn,
            turnDistance: this.turnDistance,
            offRoute: this.offRoute,
            status: this.status,
            debugGrid: this.lastDebugGrid
                ? {
                    bbox: [...this.lastDebugGrid.bbox],
                    cell: this.lastDebugGrid.cell,
                    width: this.lastDebugGrid.width,
                    height: this.lastDebugGrid.height,
                    hasSlope: this.lastDebugGrid.hasSlope,
                }
                : null,
        };
    }

    /** Debug/test only: a nearby water-only boat destination. */
    public findBoatTarget(start: [number, number]): Promise<[number, number] | null> {
        return this.planner.findBoatTarget(start);
    }

    /** Debug/test only: road/water/road waypoints for a water-capable route. */
    public findWaterRouteWaypoints(start: [number, number]): Promise<WaterRouteWaypoints | null> {
        return this.planner.findWaterRouteWaypoints(start);
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
        return this.planner.debugRoadQuery(start, goal, this.effectivePerformance(), this.effectiveWaterCapable());
    }

    private getLayersDebugState(): MapGpsLayersDebugState {
        return {
            route: describeLineLayer(this.routeSource),
            shared: describeLineLayer(this.sharedSource),
            advisor: describeLineLayer(this.advisorSource),
            waypoints: { features: this.waypointSource.getFeatures().length },
            playerIcon: {
                visible: this.hasFix,
                rotation: this.playerIcon.getRotation(),
            },
        };
    }

    // ---------------------------------------------------------------------
    // Settings and game commands
    // ---------------------------------------------------------------------

    private readSettings(): void {
        try {
            this.settings = readGpsSettings();
        } catch (error) {
            console.warn('GPS: could not read the GPS options', error);
        }
    }

    private async requestTravelMode(): Promise<void> {
        try {
            const result = await window.TacPhone.networking.Request({
                a: MAP_APP,
                c: 'GetPlayerTravelMode',
            });
            if (!this.destroyed) {
                this.applyTravelMode(result, false);
            }
        } catch (error) {
            console.warn('GPS: could not read the player travel mode', error);
        }
    }

    private applyTravelMode(payload: unknown, fromEvent: boolean): void {
        const parsed = parseVehicleChange(payload, this.detectedMode);
        if (!parsed) {
            return;
        }

        const detected = parsed.detectedMode;
        const previousDetected = this.detectedMode;
        const performance = parsed.performance;

        this.detectedMode = detected;
        this.waterCapable = parsed.waterCapable;
        this.performance = performance;

        if (!this.manualMode) {
            this.mode = detected;
        }

        if (!fromEvent) {
            this.emitState(true);
            return;
        }

        this.vehicleChangesApplied += 1;
        this.status = { kind: 'vehicle-changed' };

        // Stopping close to the destination and getting out counts as arrival.
        if (this.navigating && this.activeRoute && previousDetected !== 'foot' && detected === 'foot') {
            const metrics = this.currentMetrics();
            if (metrics && metrics.remaining <= 150) {
                this.completeArrival();
                this.emitState(true);
                return;
            }
        }

        if (this.activeRoute && (fromEvent || detected !== previousDetected)) {
            // The vehicle changed the available performance; a planned or
            // active route must be recalculated for the new travel mode.
            void this.recalculate();
        }

        this.emitState(true);
    }

    private handleVehicleChanged(payload: unknown): void {
        this.vehicleChanges.push(payload);
    }

    private handleGpsUpdate(payload: unknown, force = false): void {
        if (this.destroyed || !payload || typeof payload !== 'object') {
            return;
        }

        // `setLiveUpdates(false)` freezes the state so synthetic fixes stick.
        if (!force && !this.liveUpdates) {
            return;
        }

        const update = payload as Record<string, unknown>;
        const position = readPoint(update.position);
        if (!position) {
            return;
        }

        const view = readNumbers(update.view, 2);
        const direction = update.direction;
        const velocity = readNumbers(update.velocity, 2);
        const speedKmh = update.speed;

        let heading = this.heading;

        if (view) {
            const horizontal = Math.hypot(view[0], view[1]);
            if (horizontal > 0.05) {
                heading = normalizeDegrees((Math.atan2(view[0], view[1]) * 180) / Math.PI);
            }
        }

        if (heading === null && isFiniteNumber(direction)) {
            heading = normalizeDegrees(direction);
        }

        const speed = velocity
            ? Math.hypot(velocity[0], velocity[1])
            : (isFiniteNumber(speedKmh) ? Math.max(0, speedKmh) / 3.6 : 0);

        this.hasFix = true;
        this.position = position;
        this.heading = heading;
        this.speed = speed;
        this.fixCount += 1;

        this.playerFeature.getGeometry()?.setCoordinates(position);
        this.applyRotation(false);
        this.applyFollow();

        if (this.navigating && this.activeRoute) {
            this.updateNavigation();
        }

        this.emitState(false);
    }

    // ---------------------------------------------------------------------
    // Follow, rotation and zoom
    // ---------------------------------------------------------------------

    private get isFollowing(): boolean {
        // Planning is an explicit editing mode: never pull the map back while
        // the player is placing or dragging waypoints.
        return !this.planning && this.followEnabled && Date.now() >= this.followSuspendedUntil;
    }

    private applyFollow(): void {
        if (!this.isFollowing || !this.position) {
            return;
        }

        const view = this.map.getView();
        const center = view.getCenter();
        // Follow the player whenever the actual view is not on them. The old
        // check only looked at `lastCenter`, so a view replacement (terrain
        // load / Vite reload) could leave the map at the terrain center while
        // `lastCenter` still described the player.
        const offCenter = !center
            || distanceBetween(center[0], center[1], this.position[0], this.position[1]) > 5;
        const moved = this.lastCenter === null
            || distanceBetween(this.position[0], this.position[1], this.lastCenter[0], this.lastCenter[1]) > 1;
        const headingChanged = this.lastCenterHeading !== null
            && this.heading !== null
            && Math.abs(normalizeDegrees(this.heading - this.lastCenterHeading)) > 5;

        if (
            !this.everCentered
            || this.lastCenter === null
            || offCenter
            || (moved && (this.speed > 0.3 || headingChanged))
        ) {
            view.setCenter(this.position);
            this.lastCenter = this.position;
            this.lastCenterHeading = this.heading;
            this.everCentered = true;
        }

        this.applySpeedZoom();
    }

    private applyRotation(force: boolean): void {
        const view = this.map.getView();
        const rotating = this.settings.rotateWithPlayer;

        if (!force && !this.isFollowing) {
            // The map keeps its current rotation while the user pans around.
            this.playerIcon.setRotation(
                Math.abs(view.getRotation()) > 0.01 ? 0 : ((this.heading ?? 0) * Math.PI) / 180,
            );
            return;
        }

        const target = rotating && this.heading !== null
            ? -(this.heading * Math.PI) / 180
            : 0;

        if (Math.abs(view.getRotation() - target) > 0.001) {
            view.setRotation(target);
        }

        this.playerIcon.setRotation(rotating ? 0 : ((this.heading ?? 0) * Math.PI) / 180);
    }

    private applySpeedZoom(): void {
        if (this.offRoute) {
            return;
        }

        const view = this.map.getView();
        const current = view.getResolution();
        if (!isFiniteNumber(current)) {
            return;
        }

        const min = view.getMinResolution();
        const max = view.getMaxResolution();
        if (!(min > 0) || !(max > min)) {
            return;
        }

        const normalized = Math.min(1, this.speed / 30);
        const target = Math.min(max, Math.max(min, min * 12 * (1 - 0.6 * normalized)));

        if (Math.abs(current - target) / target > 0.05) {
            view.setResolution(current * 0.9 + target * 0.1);
        }
    }

    private handleUserPan = (): void => {
        this.suspendFollow();
        const center = this.map.getView().getCenter();
        this.lastCenter = center ? [center[0], center[1]] : this.lastCenter;
        this.lastCenterHeading = this.heading;
    };

    private setDragPanActive(active: boolean): void {
        this.map.getInteractions().forEach((interaction) => {
            if (interaction instanceof DragPan) {
                interaction.setActive(active);
            }
        });
    }

    private waypointIndexAtEvent(event: PointerEvent): number | null {
        const feature = this.map.forEachFeatureAtPixel(
            this.map.getEventPixel(event),
            (candidate) => candidate,
            {
                layerFilter: (layer) => layer === this.waypointLayer,
                hitTolerance: 12,
            },
        );

        const index = feature?.get('waypointIndex');
        return typeof index === 'number' && Number.isInteger(index) ? index : null;
    }

    private handleWaypointPointerDown = (event: PointerEvent): void => {
        if (!event.isPrimary || event.button !== 0) {
            return;
        }

        const index = this.waypointIndexAtEvent(event);
        if (index === null) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        this.waypointDrag = { index, pointerId: event.pointerId };
        this.waypointDragMoved = false;
        this.lastWaypointDragAt = Date.now();
        this.setDragPanActive(false);
        this.map.getViewport().style.cursor = 'grabbing';

        try {
            this.map.getViewport().setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is an enhancement; the document listeners still work.
        }
    };

    private handleWaypointPointerMove = (event: PointerEvent): void => {
        const drag = this.waypointDrag;
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }

        event.preventDefault();
        const coordinate = this.map.getEventCoordinate(event);
        const point = this.clampToTerrain([coordinate[0], coordinate[1]]);
        if (!point) {
            return;
        }

        this.waypoints[drag.index] = point;
        this.waypointDragMoved = true;
        this.rebuildWaypointLayer();
        this.scheduleMeasurements();
        this.schedulePreviewRoute();
    };

    private handleWaypointPointerUp = (event: PointerEvent): void => {
        const drag = this.waypointDrag;
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }

        this.waypointDrag = null;
        this.lastWaypointDragAt = Date.now();
        this.setDragPanActive(true);
        this.map.getViewport().style.cursor = '';
        try {
            this.map.getViewport().releasePointerCapture(event.pointerId);
        } catch {
            // The capture may already be gone.
        }

        if (this.waypointDragMoved) {
            this.schedulePreviewRoute();
        }
    };

    // ---------------------------------------------------------------------
    // Waypoints and route calculation
    // ---------------------------------------------------------------------

    private handleSingleClick = (event: MapBrowserEvent): void => {
        if (!this.planning || this.destroyed) {
            return;
        }

        if (Date.now() - this.lastWaypointDragAt < 300) {
            return;
        }

        const coordinate = event.coordinate;
        const point = this.clampToTerrain([coordinate[0], coordinate[1]]);
        if (!point) {
            return;
        }

        // Clicking an existing route line inserts a waypoint there and keeps
        // the later waypoints after it.
        if (this.activeRoute && this.routeGeometry) {
            const projection = projectPointToPolyline(point[0], point[1], this.routeGeometry.points);
            if (projection && projection.distance <= 25) {
                let index = this.waypointAlong.findIndex((along) => along > projection.along);
                if (index < 0) {
                    index = this.waypoints.length;
                }
                this.waypoints.splice(index, 0, point);
                this.planning = true;
                this.rebuildWaypointLayer();
                this.schedulePreviewRoute();
                this.emitState(true);
                return;
            }
        }

        this.addWaypoint(point);
    };

    private scheduleMeasurements(): void {
        if (this.measurementTimer !== null) {
            window.clearTimeout(this.measurementTimer);
        }
        this.measurementSource.clear();

        if (this.waypoints.length < 2) {
            return;
        }

        const token = ++this.measurementToken;
        this.measurementTimer = window.setTimeout(() => {
            this.measurementTimer = null;
            void getTerrainHeights(this.waypoints)
                .catch(() => null)
                .then((heights) => {
                    if (this.destroyed || token !== this.measurementToken) {
                        return;
                    }
                    this.drawMeasurements(heights);
                });
        }, 250);
    }

    private drawMeasurements(heights: number[] | null): void {
        this.measurementSource.clear();

        for (let index = 0; index + 1 < this.waypoints.length; index += 1) {
            const a = this.waypoints[index];
            const b = this.waypoints[index + 1];
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
            this.measurementSource.addFeature(feature);
        }
    }

    private schedulePreviewRoute(): void {
        if (this.previewTimer !== null) {
            window.clearTimeout(this.previewTimer);
        }

        if (this.waypoints.length === 0) {
            this.clearRoute();
            return;
        }

        this.previewTimer = window.setTimeout(() => {
            this.previewTimer = null;
            if (this.destroyed) {
                return;
            }

            if (this.navigating) {
                void this.recalculate();
            } else {
                void this.planRoute(this.position ?? this.waypoints[0], this.waypoints);
            }
        }, 250);
    }

    private clampToTerrain(point: [number, number]): [number, number] | null {
        if (!isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
            return null;
        }

        const bounds = this.planner.getBounds();
        if (!bounds) {
            return [point[0], point[1]];
        }

        return [
            Math.max(0, Math.min(bounds.width, point[0])),
            Math.max(0, Math.min(bounds.height, point[1])),
        ];
    }

    private rebuildWaypointLayer(): void {
        this.waypointSource.clear();

        for (let index = 0; index < this.waypoints.length; index += 1) {
            const feature = new Feature(new Point(this.waypoints[index]));
            feature.set('waypointIndex', index);
            feature.setStyle(this.waypointStyle(index));
            this.waypointSource.addFeature(feature);
        }
    }

    private waypointStyle(index: number): Style {
        const cached = this.waypointStyles[index];
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
        this.waypointStyles[index] = style;
        return style;
    }

    private async planRoute(
        start: [number, number],
        waypoints: Array<[number, number]>,
        validate = false,
    ): Promise<void> {
        if (this.previewTimer !== null) {
            window.clearTimeout(this.previewTimer);
            this.previewTimer = null;
        }

        const generation = ++this.generation;
        const isCancelled = (): boolean => this.destroyed || generation !== this.generation;

        this.calculating = true;
        this.status = { kind: 'analyzing' };
        this.emitState(true);

        let result: RoutePlanResult;

        try {
            result = await this.planner.plan({
                start,
                waypoints,
                mode: this.mode,
                waterCapable: this.effectiveWaterCapable(),
                performance: this.effectivePerformance(),
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

        this.calculating = false;

        // Debug only: refresh the overlay grid from this plan (no-op otherwise).
        this.setDebugGrid(result.debug ?? null);

        if (result.ok && result.route) {
            this.status = null;
            this.stale = false;
            this.arrived = false;
            this.deviation.reset();
            this.advisor.reset();
            this.setActiveRoute(result.route);
        } else if (result.reason === 'cancelled') {
            return;
        } else {
            this.status = { kind: result.reason === 'no-terrain' ? 'no-terrain' : 'no-path' };
            this.setActiveRoute(null);
        }

        this.emitState(true);
    }

    private async recalculateRemaining(
        start: [number, number],
        reason: 'manual' | 'auto' = 'manual',
    ): Promise<void> {
        if (!this.activeRoute) {
            return;
        }

        if (this.activeRoute.source === 'shared' && this.routeGeometry) {
            const projection = projectPointToPolyline(start[0], start[1], this.routeGeometry.points);
            const segment = projection?.segment ?? 0;
            const aheadIndex = Math.min(
                flatPointCount(this.routeGeometry.points) - 1,
                segment + 1,
            );
            const ahead = this.routeGeometry.points.slice(aheadIndex * 2, aheadIndex * 2 + 2);
            const target: [number, number] = ahead.length >= 2
                ? [ahead[0], ahead[1]]
                : this.activeRoute.waypoints[this.activeRoute.waypoints.length - 1];

            const connector = await this.planConnector(start, target);
            if (!connector) {
                this.status = { kind: 'route-failed' };
                this.emitState(true);
                return;
            }

            const remaining = sliceLegsFrom(
                this.activeRoute.legs,
                this.routeGeometry,
                segment,
                target,
            );
            const legs = [...connector, ...remaining].filter((leg) => leg.points.length >= 4);
            const distance = legs.reduce((total, leg) => total + leg.distance, 0);
            const eta = legs.reduce((total, leg) => total + leg.eta, 0);

            this.setActiveRoute({
                ...this.activeRoute,
                legs,
                distance,
                eta: Number.isFinite(eta) ? eta : null,
            });
            this.stale = false;
            if (reason === 'auto') {
                this.repathCount += 1;
            }
            this.emitState(true);
            return;
        }

        const remaining = this.waypoints.filter((waypoint) => {
            if (!this.routeGeometry) {
                return true;
            }
            const along = projectionAlong(waypoint, this.routeGeometry.points);
            const current = projectPointToPolyline(start[0], start[1], this.routeGeometry.points);
            return along === null || !current || along > current.along + 5;
        });

        if (remaining.length === 0) {
            return;
        }

        const before = this.activeRoute;
        await this.planRoute(start, remaining, true);

        // `planRoute` keeps the previous route on failure, so only a new route
        // object counts as a replacement.
        if (reason === 'auto' && this.activeRoute !== null && this.activeRoute !== before) {
            this.repathCount += 1;
        }
    }

    private async planConnector(
        start: [number, number],
        target: [number, number],
    ): Promise<RouteLeg[] | null> {
        if (distanceBetween(start[0], start[1], target[0], target[1]) < 5) {
            return [];
        }

        if (this.mode === 'air') {
            const distance = distanceBetween(start[0], start[1], target[0], target[1]);
            const speed = legSpeed('air', 'air', this.performance, false);
            return [{
                mode: 'air',
                kind: 'air',
                points: [start[0], start[1], target[0], target[1]],
                distance,
                eta: speed > 0 ? distance / speed : 0,
                source: 'connector',
            }];
        }

        const result = await this.planner.plan({
            start,
            waypoints: [target],
            mode: this.mode,
            waterCapable: this.effectiveWaterCapable(),
            performance: this.effectivePerformance(),
            cancelled: () => this.destroyed,
        });

        if (!result.ok || !result.route) {
            return null;
        }

        return result.route.legs.map((leg) => ({ ...leg, source: 'connector' as const }));
    }

    private setActiveRoute(route: ActiveRoute | null): void {
        this.activeRoute = route;
        this.routeGeometry = route ? buildRouteGeometry(route.legs) : null;
        this.waypointAlong = route && this.routeGeometry
            ? route.waypoints.map((waypoint) =>
                projectionAlong(waypoint, this.routeGeometry?.points ?? []) ?? 0)
            : [];

        this.arrived = false;
        this.deviation.reset();
        this.deviation.resetProgress();
        this.arrivalSoundPlayed = false;
        this.lastRouteDrawAlong = -1;
        this.clearAdvisorPrompt();
        this.drawRoute();
        this.emitState(true);
    }

    private clearRoute(): void {
        this.generation += 1;
        this.activeRoute = null;
        this.routeGeometry = null;
        this.waypointAlong = [];
        this.routeSource.clear();
        this.routeBehindSource.clear();
        this.advisorSource.clear();
        this.navigating = false;
        this.arrived = false;
        this.deviation.reset();
        this.deviation.resetProgress();
        this.arrivalSoundPlayed = false;
        this.lastRouteDrawAlong = -1;
        this.offRoute = false;
        this.stale = false;
        this.calculating = false;
        this.status = null;
        this.clearAdvisorPrompt();
    }

    private drawRoute(): void {
        this.routeSource.clear();
        this.routeBehindSource.clear();
        this.advisorSource.clear();

        if (!this.activeRoute) {
            return;
        }

        const geometry = this.routeGeometry;
        const projection = this.navigating && this.position && geometry
            ? projectPointToPolyline(this.position[0], this.position[1], geometry.points)
            : null;
        const along = projection?.along ?? null;

        if (projection !== null && along !== null && geometry) {
            // Fade the part already travelled, so the remaining line stands out.
            for (const leg of this.activeRoute.legs) {
                if (leg.points.length < 4) {
                    continue;
                }
                this.routeBehindSource.addFeature(
                    new Feature(new LineString(flattenToCoordinates(leg.points))),
                );
            }

            // `sliceLegsFrom` takes a flattened segment index, not metres along
            // the route. Passing the distance made the ahead slice jump past the
            // player and faded the whole route instead of only the passed part.
            const ahead = sliceLegsFrom(
                this.activeRoute.legs,
                geometry,
                projection.segment,
                this.position,
            );
            for (const leg of ahead) {
                if (leg.points.length < 4) {
                    continue;
                }
                const feature = new Feature(new LineString(flattenToCoordinates(leg.points)));
                feature.setStyle(this.routeStyle(leg.kind, leg.mode));
                this.routeSource.addFeature(feature);
            }
            this.lastRouteDrawAlong = along;
            return;
        }

        for (const leg of this.activeRoute.legs) {
            if (leg.points.length < 4) {
                continue;
            }
            const feature = new Feature(new LineString(flattenToCoordinates(leg.points)));
            feature.setStyle(this.routeStyle(leg.kind, leg.mode));
            this.routeSource.addFeature(feature);
        }
    }

    private drawSharedPreview(data: SharedRouteData): void {
        this.sharedSource.clear();

        const legs = sharedRouteLegs(data);
        for (const leg of legs) {
            if (leg.points.length < 4) {
                continue;
            }
            const feature = new Feature(new LineString(flattenToCoordinates(leg.points)));
            feature.setStyle(this.sharedStyle(leg.kind));
            this.sharedSource.addFeature(feature);
        }

        const waypoints = sharedRouteWaypoints(data);
        for (let index = 0; index < waypoints.length; index += 1) {
            const feature = new Feature(new Point(waypoints[index]));
            feature.setStyle(this.waypointStyle(index));
            this.sharedSource.addFeature(feature);
        }
    }

    private routeStyle(kind: RouteLegKind, mode: TravelMode): Style {
        const key = `${mode}:${kind}`;
        const cached = this.legStyles.get(key);
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
        const dashed = kind === 'walk' || kind === 'air';

        const style = new Style({
            stroke: new Stroke({
                color: colors[kind],
                width: mode === 'air' ? 2 : 4,
                lineDash: dashed ? [8, 6] : undefined,
            }),
        });

        this.legStyles.set(key, style);
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

    // ---------------------------------------------------------------------
    // Navigation metrics, deviation and arrival
    // ---------------------------------------------------------------------

    private updateNavigation(): void {
        const metrics = this.currentMetrics();
        if (!metrics || !this.routeGeometry) {
            return;
        }

        const maneuver = nextManeuver(this.routeGeometry.points, metrics.along);
        this.turn = maneuver.turn;
        this.turnDistance = maneuver.distance;

        if (Math.abs(metrics.along - this.lastRouteDrawAlong) > 5) {
            this.drawRoute();
        }

        const view = this.map.getView();
        const size = this.map.getSize();
        const resolution = view.getResolution();
        const viewportPixels = size && size[0] > 0 && size[1] > 0
            ? Math.max(1, Math.min(size[0], size[1]) - 160)
            : 0;

        const decision = this.deviation.update({
            now: Date.now(),
            metrics,
            mode: this.mode,
            speed: this.speed,
            navigating: this.navigating,
            following: this.isFollowing,
            autoRepath: this.settings.autoRepath,
            waypointAlong: this.waypointAlong,
            nextWaypoint: nextWaypointAhead(this.waypoints, this.waypointAlong, metrics.along),
            position: this.position,
            view: isFiniteNumber(resolution) && viewportPixels > 0
                ? {
                    resolution,
                    maxResolution: view.getMaxResolution(),
                    viewportPixels,
                }
                : null,
        });

        this.offRoute = decision.offRoute;

        if (decision.reachedWaypoint) {
            window.TacPhone.audio.play('message');
        }

        if (decision.zoomResolution !== null && this.position) {
            // Keep the player centered and zoom out only enough for the next
            // waypoint to fit; never fit the whole terrain.
            view.setCenter(this.position);
            this.lastCenter = this.position;
            view.setResolution(decision.zoomResolution);
        }

        if (decision.repath && this.position) {
            void this.recalculateRemaining(this.position, 'auto');
        }

        if (decision.arrived) {
            this.completeArrival();
        }

        if (
            this.navigating
            && this.activeRoute?.source === 'shared'
            && !decision.offRoute
            && this.speed > ADVISOR_MIN_SPEED
        ) {
            this.evaluateAdvisor(metrics);
        } else if (this.advisor.prompt) {
            this.clearAdvisorPrompt();
        }
    }

    private completeArrival(): void {
        if (this.arrived) {
            return;
        }

        this.arrived = true;
        this.navigating = false;
        this.clearAdvisorPrompt();
        if (!this.arrivalSoundPlayed) {
            this.arrivalSoundPlayed = true;
            window.TacPhone.audio.play('success');
        }
    }

    private currentMetrics() {
        if (!this.position || !this.routeGeometry) {
            return null;
        }
        return computeRouteMetrics(this.position, this.routeGeometry);
    }

    // ---------------------------------------------------------------------
    // Transport-mode advisor
    // ---------------------------------------------------------------------

    private evaluateAdvisor(metrics: {
        along: number;
        segment: number;
        legIndex: number;
    }): void {
        const route = this.activeRoute;
        if (!route || !this.routeGeometry) {
            return;
        }

        const authoredLeg = route.legs[metrics.legIndex];
        if (!authoredLeg) {
            return;
        }

        const authoredPerf = route.shared?.vehicle;
        const authoredWater = authoredPerf?.canFloat === true;
        const authoredSpeed = authoredLeg.distance > 0 && authoredLeg.eta > 0
            ? authoredLeg.distance / authoredLeg.eta
            : legSpeed(authoredLeg.mode, authoredLeg.kind, authoredPerf, authoredWater);

        const decision = this.advisor.evaluate({
            now: Date.now(),
            source: route.source,
            navigating: this.navigating,
            moving: this.speed > ADVISOR_MIN_SPEED,
            onRoute: !this.offRoute,
            planningInFlight: this.advisorPlanning,
            mode: this.mode,
            authoredMode: authoredLeg.mode,
            legSource: authoredLeg.source,
            along: metrics.along,
            waypointAlong: this.waypointAlong,
            authoredSpeed,
        });

        if (decision.kind === 'cancel-prompt') {
            this.clearAdvisorPrompt();
            return;
        }

        if (decision.kind !== 'evaluate') {
            return;
        }

        this.requestAdvisorAlternative(decision, route, metrics, authoredLeg);
    }

    /** Plans the alternative the advisor asked for and shows the offer. */
    private requestAdvisorAlternative(
        decision: { nextWaypointIndex: number; authoredRemaining: number; threshold: number },
        route: ActiveRoute,
        metrics: { along: number; segment: number; legIndex: number },
        authoredLeg: RouteLeg,
    ): void {
        const waypoint = route.waypoints[decision.nextWaypointIndex];
        if (!waypoint) {
            return;
        }

        const authoredMode = authoredLeg.mode;

        this.advisorPlanning = true;
        const token = ++this.advisorToken;
        // The plan is only valid for the mode it was requested with: the player
        // can switch travel mode while it runs.
        const plannedMode = this.mode;

        void this.planner.plan({
            start: this.position ?? waypoint,
            waypoints: [waypoint],
            mode: plannedMode,
            waterCapable: this.effectiveWaterCapable(),
            performance: this.effectivePerformance(),
            cancelled: () => this.destroyed || token !== this.advisorToken,
        }).then((result) => {
            this.advisorPlanning = false;

            if (this.destroyed || token !== this.advisorToken || plannedMode !== this.mode) {
                return;
            }

            if (!result.ok || !result.route || result.route.eta === null) {
                const failed = this.advisor.markPlanFailed(
                    Date.now(),
                    result.reason === 'no-path' ? 'no-path' : 'error',
                );

                if (failed.warnUnreachable && !this.destroyed) {
                    this.status = { kind: 'advisor-unreachable', mode: this.mode };
                    this.emitState(true);
                }
                return;
            }

            this.advisor.markPlanSucceeded();
            if (this.status?.kind === 'advisor-unreachable') {
                this.status = null;
            }

            const alternativeSeconds = result.route.eta;
            if (!this.advisor.accepts(alternativeSeconds, decision.authoredRemaining)) {
                return;
            }

            const prompt: AdvisorPrompt = {
                authoredMode,
                mode: plannedMode,
                alternativeSeconds,
                savesSeconds: decision.authoredRemaining - alternativeSeconds,
                waypointIndex: decision.nextWaypointIndex,
            };
            this.advisor.showPrompt(prompt, {
                segment: metrics.segment,
                authoredRemaining: decision.authoredRemaining,
            });
            this.advisorAlternative = result.route;

            this.drawAdvisorAlternative(result.route, authoredMode);

            try {
                window.TacPhone.audio.play('alert');
            } catch (error) {
                console.warn('GPS: could not play the advisor sound', error);
            }

            this.emitState(true);
        }).catch((error: unknown) => {
            this.advisorPlanning = false;
            console.warn('GPS: advisor route planning failed', error);
        });
    }

    private drawAdvisorAlternative(route: ActiveRoute, authoredMode: TravelMode): void {
        this.advisorSource.clear();

        for (const leg of route.legs) {
            if (leg.points.length < 4) {
                continue;
            }
            const feature = new Feature(new LineString(flattenToCoordinates(leg.points)));
            feature.setStyle(new Style({
                stroke: new Stroke({
                    color: 'rgba(244, 114, 182, 0.95)',
                    width: 3,
                    lineDash: [3, 5],
                }),
            }));
            this.advisorSource.addFeature(feature);
        }

        // Keep the authored mode readable for the card text.
        this.advisorSource.set('authoredMode', authoredMode);
    }

    private clearAdvisorPrompt(): void {
        const hadPrompt = this.advisor.prompt !== null;
        this.advisor.clearPrompt();
        this.advisorAlternative = null;

        if (!hadPrompt && this.advisorSource.getFeatures().length === 0) {
            return;
        }

        this.advisorToken += 1;
        this.advisorSource.clear();
    }

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    private buildState(): GpsViewState {
        const metrics = this.activeRoute ? this.currentMetrics() : null;
        const rotation = this.map.getView().getRotation();

        let route: RouteSummary | null = null;
        if (this.activeRoute) {
            const remaining = metrics?.remaining ?? this.activeRoute.distance;
            const remainingTime = remainingEta(
                this.activeRoute.eta,
                this.activeRoute.distance,
                remaining,
            );
            route = {
                distance: this.activeRoute.distance,
                remaining,
                eta: this.activeRoute.eta,
                remainingEta: remainingTime,
                walkDistance: this.activeRoute.legs
                    .filter((leg) => leg.kind === 'walk')
                    .reduce((total, leg) => total + leg.distance, 0),
                source: this.activeRoute.source,
                author: this.activeRoute.author,
                label: this.activeRoute.label,
            };
        }

        let shared: SharedPreviewInfo | null = null;
        if (this.sharedPreview) {
            shared = {
                author: this.sharedPreview.author,
                mode: sharedRoutePrimaryMode(this.sharedPreview),
                distance: this.sharedPreview.distance,
                eta: this.sharedPreview.eta,
                waypointCount: flatPointCount(this.sharedPreview.waypoints),
                walkDistance: sharedRouteWalkDistance(this.sharedPreview),
                label: this.sharedPreview.label,
            };
        }

        const state: GpsViewState = {
            ...this.state,
            hasFix: this.hasFix,
            heading: this.heading,
            position: this.position ? [this.position[0], this.position[1]] : null,
            speed: this.speed,
            mode: this.mode,
            detectedMode: this.detectedMode,
            waterCapable: this.waterCapable,
            planning: this.planning,
            navigating: this.navigating,
            calculating: this.calculating,
            rotating: this.settings.rotateWithPlayer,
            mapRotation: normalizeDegrees((rotation * 180) / Math.PI),
            offRoute: this.offRoute,
            stale: this.stale,
            arrived: this.arrived,
            waypointCount: this.waypoints.length,
            waypoints: this.waypoints.map((point) => [point[0], point[1]] as [number, number]),
            route,
            routeBearing: metrics?.bearing ?? null,
            turn: this.turn,
            turnDistance: this.turnDistance,
            status: this.status,
            shared,
            advisor: this.advisor.prompt,
        };

        this.state = state;
        return state;
    }

    private emitState(force: boolean): void {
        if (this.destroyed) {
            return;
        }

        const now = Date.now();
        if (!force && now - this.lastEmitAt < 80) {
            return;
        }

        this.lastEmitAt = now;
        this.callbacks.onStateChange(this.buildState());
    }
}

// ---------------------------------------------------------------------------
// Route geometry helpers live in ./RouteSplice (game-free, unit tested).
// ---------------------------------------------------------------------------

/** Kept so the route panel can show a localized label for the current mode. */
export function travelModeLabel(mode: TravelMode): string {
    switch (mode) {
        case 'foot':
            return t('STR_ACE_Tacphone_Map_Gps_Mode_Foot');
        case 'ground':
            return t('STR_ACE_Tacphone_Map_Gps_Mode_Ground');
        case 'boat':
            return t('STR_ACE_Tacphone_Map_Gps_Mode_Boat');
        case 'air':
            return t('str_dn_aircraft');
    }
}
