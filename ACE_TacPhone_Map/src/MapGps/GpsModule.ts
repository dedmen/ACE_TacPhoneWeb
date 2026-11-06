/**
 * Imperative GPS module for an existing OpenLayers map.
 *
 * This class is the orchestrator: it owns the GPS layers and the shared GPS
 * state, and it delegates the detailed behaviour to sibling sections, each
 * of which holds a back-reference to the module:
 *
 * - `GpsCamera` — follow/rotation/zoom and the map pointer interactions
 * - `GpsRoutes` — waypoints, measurements, route planning and drawing
 * - `GpsNavigation` — metrics, deviation, guidance and arrival
 * - `GpsAdvisor` — the transport-mode advisor offer flow
 * - `GpsDebugProbe` — the `window.__TACPHONE_MAP_TEST__.gps` surface and the
 *   debug cost/height overlay layers
 *
 * The module is still the object registered as the `MapGpsTestProbe`; it keeps
 * thin public delegators that forward to the probe. It never renders React;
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
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import ImageStatic from 'ol/source/ImageStatic';
import VectorSource from 'ol/source/Vector';
import { Icon, Stroke, Style } from 'ol/style';

import type { GpsStartRouteOptions, MapFlyToOptions } from '../api';
import { mapCommandRegistry } from '../CommandRegistry';
import { t } from '../i18n';
import {
    registerGpsTestProbe,
    unregisterGpsTestProbe,
    type MapGpsTestProbe,
} from '../MapMarkers/MapTestHooks';
import { onGpsSettingsChanged, readGpsSettings, type GpsSettings } from '../MapOptions';
import { DEBUG_OVERLAY_ALPHA } from './GpsDebugOverlay';
import type {
    ActiveRoute,
    GpsDebugOverlayMode,
    GpsStatus,
    GpsViewState,
    RouteDebugGrid,
    RouteSummary,
    SharedPreviewInfo,
    TravelMode,
    VehiclePerformance,
} from './GpsTypes';
import { createInitialGpsViewState, isTravelMode } from './GpsTypes';
import { RoutePlanner } from './RoutePlanner';
import { remainingEta } from '../routing/RouteMetrics';
import type { RouteLegHoverInfo } from '../routing/RouteLegInfo';
import { DeviationTracker } from '../routing/DeviationTracker';
import { parseVehicleChange, VehicleChangeDebouncer } from '../routing/VehicleChange';
import {
    buildRouteGeometry,
    projectionAlong,
    sliceLegsFrom,
    type RouteGeometry,
} from './RouteSplice';
import { TransportModeAdvisor } from './TransportModeAdvisor';
import {
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
import { GpsCamera } from './GpsCamera';
import { GpsRoutes } from './GpsRoutes';
import { GpsNavigation } from './GpsNavigation';
import { GpsAdvisor } from './GpsAdvisor';
import { GpsDebugProbe } from './GpsDebugProbe';

/** Game-side GPS interest; must match INTEREST_GPS in the game add-on. */
export const GPS_INTEREST = 'ACE_TacPhone_Map.gps';

const MAP_APP = 'ACE_TacPhone_Map';

const FOLLOW_SUSPEND_MS = 5000;

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

/**
 * Imperative GPS behaviour for one OpenLayers map. The state fields below are
 * public module-internal: the sibling sections read and write them through
 * their back-reference to this instance.
 */
export class GpsModule implements MapGpsTestProbe {
    public readonly map: OlMap;
    private readonly callbacks: GpsModuleCallbacks;

    public readonly playerSource = new VectorSource();
    public readonly routeSource = new VectorSource();
    public readonly routeBehindSource = new VectorSource();
    public readonly sharedSource = new VectorSource();
    public readonly advisorSource = new VectorSource();
    public readonly waypointSource = new VectorSource();
    public readonly measurementSource = new VectorSource();

    private readonly playerLayer: VectorLayer<VectorSource>;
    private readonly routeLayer: VectorLayer<VectorSource>;
    private readonly routeBehindLayer: VectorLayer<VectorSource>;
    private readonly sharedLayer: VectorLayer<VectorSource>;
    private readonly advisorLayer: VectorLayer<VectorSource>;
    public readonly waypointLayer: VectorLayer<VectorSource>;
    private readonly measurementLayer: VectorLayer<VectorSource>;

    public readonly playerIcon = new Icon({
        src: PLAYER_ICON_URL,
        anchor: [0.5, 0.5],
        rotation: 0,
    });
    private readonly playerFeature = new Feature(new Point([0, 0]));
    public readonly legStyles = new Map<string, Style>();
    public readonly waypointStyles: Style[] = [];

    private readonly unregisterUpdate: () => void;
    private readonly unregisterVehicle: () => void;
    private readonly unsubscribeOptions: () => void;

    // updateRate only affects the game-side sync (GpsUpdateRateSync); 10 is the
    // schema default until readSettings() picks up the stored value.
    public settings: GpsSettings = { rotateWithPlayer: true, autoRepath: false, updateRate: 10 };
    public readonly planner = new RoutePlanner(null);

    // Sibling sections; constructed in the constructor before the test probe
    // is registered and before the first `emitState`.
    public camera: GpsCamera;
    public routes: GpsRoutes;
    public navigation: GpsNavigation;
    public advisorFlow: GpsAdvisor;
    public debugProbe: GpsDebugProbe;

    private state: GpsViewState = createInitialGpsViewState();
    public mode: TravelMode = 'foot';
    public detectedMode: TravelMode = 'foot';
    public waterCapable = false;
    /** Ground routing preference controlled from the route panel. */
    public groundFastest = false;
    public performance: VehiclePerformance = {};
    private manualMode = false;

    public position: [number, number] | null = null;
    public heading: number | null = null;
    public speed = 0;
    public hasFix = false;

    public followEnabled = true;
    public followSuspendedUntil = 0;
    public lastCenter: [number, number] | null = null;
    public lastCenterHeading: number | null = null;
    public everCentered = false;
    private terrainRecenterTimer: number | null = null;
    public planning = false;

    public waypoints: Array<[number, number]> = [];
    public activeRoute: ActiveRoute | null = null;
    public routeGeometry: RouteGeometry | null = null;
    public waypointAlong: number[] = [];

    public navigating = false;
    public arrived = false;
    /** Pending auto-clear of the route after the Arrived badge. */
    public arrivalTimer: number | null = null;
    public stale = false;
    public turn: 'left' | 'right' | 'straight' | null = null;
    public turnDistance: number | null = null;
    /** Speech cues already delivered for the active route. */
    public readonly spokenGuidance = new Set<string>();
    public lastSpeechAt = 0;
    public offRoute = false;
    public readonly deviation = new DeviationTracker();
    public lastRouteDrawAlong = -1;
    public arrivalSoundPlayed = false;

    public calculating = false;
    public status: GpsStatus | null = null;

    public sharedPreview: SharedRouteData | null = null;
    /** True while the route panel is open and route hover should be tracked. */
    public routeHoverEnabled = true;
    public routeHover: RouteLegHoverInfo | null = null;

    public readonly advisor = new TransportModeAdvisor();
    public advisorPlanning = false;
    public advisorToken = 0;
    /** Alternative route drawn for the shown offer; spliced on accept. */
    public advisorAlternative: ActiveRoute | null = null;

    public previewTimer: number | null = null;
    public measurementTimer: number | null = null;
    public measurementToken = 0;
    public waypointDrag: { index: number; pointerId: number } | null = null;
    public waypointDragMoved = false;
    public lastWaypointDragAt = 0;

    public generation = 0;
    public readonly vehicleChanges: VehicleChangeDebouncer;
    public destroyed = false;
    private lastEmitAt = 0;

    // Debug-only test counters and the `setLiveUpdates` switch; the browser
    // tests read them through the debug hook and nothing else depends on them.
    public liveUpdates = true;
    public fixCount = 0;
    public vehicleChangesApplied = 0;
    /** Auto-repaths that actually replaced the route (off-route recovery). */
    public repathCount = 0;

    // Debug-only route-planning overlay (see `setDebugOverlay`). All of it is
    // inert unless `gameInfo.isDebug()` is true when the module is created.
    public readonly debugEnabled: boolean = isDebugEnabled();
    public debugOverlay: GpsDebugOverlayMode = 'none';
    public debugSlopeInfluence = true;
    public debugAlpha = DEBUG_OVERLAY_ALPHA;
    public lastDebugGrid: RouteDebugGrid | null = null;
    public debugCostLayer: ImageLayer<ImageStatic> | null = null;
    public debugHeightLayer: ImageLayer<ImageStatic> | null = null;

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

        // Sibling sections first: the options subscription and the event
        // handlers registered below already call into them, and the first
        // `emitState` reads the navigation state.
        this.camera = new GpsCamera(this);
        this.routes = new GpsRoutes(this);
        this.navigation = new GpsNavigation(this);
        this.advisorFlow = new GpsAdvisor(this);
        this.debugProbe = new GpsDebugProbe(this);

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
            this.camera.applyRotation(true);
            this.emitState(true);
        });

        this.map.on('singleclick', this.routes.handleSingleClick);
        this.map.on('pointerdrag', this.camera.handleUserPan);
        this.map.on('pointermove', this.camera.handleRoutePointerMove);
        // OpenLayers only exposes pointermove/pointerdrag/singleclick publicly;
        // the waypoint drag lifecycle (capture, cancel, leave) stays on the DOM.
        this.map.getViewport().addEventListener('wheel', this.camera.handleUserPan, { passive: true });
        this.map.getViewport().addEventListener('pointerdown', this.camera.handleWaypointPointerDown, true);
        this.map.getViewport().addEventListener('pointermove', this.camera.handleWaypointPointerMove, true);
        this.map.getViewport().addEventListener('pointerleave', this.camera.handleRoutePointerLeave, true);
        this.map.getViewport().addEventListener('pointerup', this.camera.handleWaypointPointerUp, true);
        this.map.getViewport().addEventListener('pointercancel', this.camera.handleWaypointPointerUp, true);

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

    /**
     * Enables route-leg hover sampling while the route panel is open.
     * The listener itself stays installed; this only gates the work.
     */
    public setRouteHoverEnabled(enabled: boolean): void {
        if (this.routeHoverEnabled === enabled) {
            return;
        }
        this.routeHoverEnabled = enabled;
        if (!enabled) {
            this.camera.setRouteHover(null);
        }
    }

    /**
     * Route-panel ground preference. `false` keeps the road bias; `true` lets a
     * capable off-road vehicle take a faster shortcut.
     */
    public setGroundFastest(enabled: boolean): void {
        if (this.groundFastest === enabled) {
            return;
        }
        this.groundFastest = enabled;
        this.emitState(true);
        if (this.mode === 'ground' && this.waypoints.length > 0) {
            void this.recalculate();
        }
    }

    /** Vehicle snapshot used for the shared payload's ETA comparison. */
    public getPerformanceSnapshot(): VehiclePerformance | undefined {
        if (this.detectedMode === 'foot') {
            return undefined;
        }
        return { ...this.performance, canFloat: this.waterCapable };
    }

    /** Performance only applies when the selected mode matches the vehicle. */
    public effectivePerformance(): VehiclePerformance | undefined {
        return this.mode === this.detectedMode ? this.performance : undefined;
    }

    public effectiveWaterCapable(): boolean {
        return this.mode === this.detectedMode && this.waterCapable;
    }

    /** Applies the terrain snapshot loaded by the Map panel. */
    public setTerrain(terrain: TerrainData | null): void {
        if (this.destroyed) {
            return;
        }

        const hadRoads = this.planner.hasRoadLayer();
        this.planner.setTerrain(terrain);
        const hasRoads = this.planner.hasRoadLayer();
        // A new terrain snapshot invalidates the debug grid's masks and heights.
        this.debugProbe.setDebugGrid(null);
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
                if (this.destroyed || !this.position || !this.camera.isFollowing) {
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

        if (!hadRoads && hasRoads
            && this.mode === 'ground'
            && this.activeRoute?.source === 'planned'
            && this.waypoints.length > 0) {
            // The first plan ran before the roads layer arrived and became an
            // off-road grid route. Replan once the road graph is available.
            void this.recalculate();
        }
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
        const point = this.routes.clampToTerrain(coordinate);
        if (!point) {
            return;
        }

        this.waypoints.push(point);
        this.planning = true;
        this.routes.rebuildWaypointLayer();
        this.routes.scheduleMeasurements();
        this.routes.schedulePreviewRoute();
        this.emitState(true);
    }

    public removeWaypoint(index: number): void {
        if (index < 0 || index >= this.waypoints.length) {
            return;
        }

        this.waypoints.splice(index, 1);
        this.routes.rebuildWaypointLayer();
        this.routes.scheduleMeasurements();

        if (this.waypoints.length === 0) {
            this.routes.clearRoute();
        } else {
            this.routes.schedulePreviewRoute();
        }

        this.emitState(true);
    }

    public clearWaypoints(): void {
        this.navigation.cancelArrivalClear();
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
        this.routes.rebuildWaypointLayer();
        this.routes.clearRoute();
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
        await this.routes.planRoute(start, this.waypoints, true);
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

        const target = this.routes.clampToTerrain(position);
        if (!target) {
            return false;
        }

        if (this.sharedPreview) {
            this.discardSharedRoute();
        }

        const replace = options.replace !== false;
        this.waypoints = replace ? [target] : [...this.waypoints, target];
        this.planning = false;
        this.routes.rebuildWaypointLayer();
        this.routes.scheduleMeasurements();

        await this.routes.planRoute(this.position ?? this.waypoints[0], this.waypoints, true);
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
        await this.routes.planRoute(this.position ?? this.waypoints[0], this.waypoints, true);
    }

    public startNavigation(): void {
        if (this.activeRoute) {
            this.navigation.cancelArrivalClear();
            this.navigating = true;
            this.arrived = false;
            this.planning = false;
            this.followEnabled = true;
            this.followSuspendedUntil = 0;
            this.stale = false;
            this.deviation.resetProgress();
            this.arrivalSoundPlayed = false;
            this.lastRouteDrawAlong = -1;
            this.routes.drawRoute();
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
        this.navigation.cancelArrivalClear();
        this.navigating = false;
        this.arrived = false;
        this.offRoute = false;
        this.deviation.reset();
        this.lastRouteDrawAlong = -1;
        this.advisorFlow.clearAdvisorPrompt();
        this.routes.drawRoute();
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
        this.routes.drawSharedPreview(data);
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

        const connector = await this.routes.planConnector(player, joinPoint);
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

        this.routes.setActiveRoute({
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
        this.routes.rebuildWaypointLayer();

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
        this.advisorFlow.clearAdvisorPrompt();
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
        this.advisorFlow.clearAdvisorPrompt();
        this.routes.setActiveRoute({
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
        this.advisorFlow.clearAdvisorPrompt();
        this.emitState(true);
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.generation += 1;
        this.advisorToken += 1;
        this.navigation.cancelArrivalClear();

        unregisterGpsTestProbe(this);

        this.vehicleChanges.cancel();

        this.unregisterUpdate();
        this.unregisterVehicle();
        this.unsubscribeOptions();

        this.map.un('singleclick', this.routes.handleSingleClick);
        this.map.un('pointerdrag', this.camera.handleUserPan);
        this.map.un('pointermove', this.camera.handleRoutePointerMove);
        const viewport = this.map.getViewport();
        viewport.removeEventListener('wheel', this.camera.handleUserPan);
        viewport.removeEventListener('pointerdown', this.camera.handleWaypointPointerDown, true);
        viewport.removeEventListener('pointermove', this.camera.handleWaypointPointerMove, true);
        viewport.removeEventListener('pointerleave', this.camera.handleRoutePointerLeave, true);
        viewport.removeEventListener('pointerup', this.camera.handleWaypointPointerUp, true);
        viewport.removeEventListener('pointercancel', this.camera.handleWaypointPointerUp, true);
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

        this.debugProbe.removeDebugLayer('cost');
        this.debugProbe.removeDebugLayer('height');
        this.lastDebugGrid = null;

        this.planner.dispose();
    }

    // ---------------------------------------------------------------------
    // Debug/test probe (window.__TACPHONE_MAP_TEST__.gps)
    //
    // The module stays the registered `MapGpsTestProbe`; every method below
    // is a one-line forward to the section that owns the behaviour.
    // ---------------------------------------------------------------------

    public getGpsDebugState() {
        return this.debugProbe.getGpsDebugState();
    }

    public setWaypoints(points: Array<[number, number]>): void {
        this.debugProbe.setWaypoints(points);
    }

    public async openSharedRoute(route: unknown): Promise<boolean> {
        return this.debugProbe.openSharedRoute(route);
    }

    public setLiveUpdates(enabled: boolean): void {
        this.debugProbe.setLiveUpdates(enabled);
    }

    public setDebugOverlay(
        mode: GpsDebugOverlayMode,
        slopeInfluence: boolean,
        alpha?: number,
    ): void {
        this.debugProbe.setDebugOverlay(mode, slopeInfluence, alpha);
    }

    public async scanDebugViewport(mode?: GpsDebugOverlayMode): Promise<boolean> {
        return this.debugProbe.scanDebugViewport(mode);
    }

    public getDebugSampleAt(position: [number, number]) {
        return this.debugProbe.getDebugSampleAt(position);
    }

    public applyFix(payload: unknown): void {
        this.debugProbe.applyFix(payload);
    }

    public applyVehicle(payload: unknown): void {
        this.debugProbe.applyVehicle(payload);
    }

    public getPixel(coordinate: [number, number]): [number, number] | null {
        return this.debugProbe.getPixel(coordinate);
    }

    public queryWater(
        point: [number, number],
        radiusM: number,
    ): Promise<{ water: boolean; nearestWater: [number, number] | null; hasTerrain: boolean }> {
        return this.debugProbe.queryWater(point, radiusM);
    }

    public getRouteDebugSnapshot(): unknown {
        return this.debugProbe.getRouteDebugSnapshot();
    }

    public findBoatTarget(start: [number, number]): Promise<[number, number] | null> {
        return this.debugProbe.findBoatTarget(start);
    }

    public findWaterRouteWaypoints(start: [number, number]) {
        return this.debugProbe.findWaterRouteWaypoints(start);
    }

    public debugRoadQuery(start: [number, number], goal: [number, number]) {
        return this.debugProbe.debugRoadQuery(start, goal);
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

    public applyTravelMode(payload: unknown, fromEvent: boolean): void {
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
            const metrics = this.navigation.currentMetrics();
            if (metrics && metrics.remaining <= 150) {
                this.navigation.completeArrival();
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

    public handleGpsUpdate(payload: unknown, force = false): void {
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
        this.camera.applyRotation(false);
        this.camera.applyFollow();

        if (this.navigating && this.activeRoute) {
            this.navigation.updateNavigation();
        }

        this.emitState(false);
    }

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    private buildState(): GpsViewState {
        const metrics = this.activeRoute ? this.navigation.currentMetrics() : null;
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
            groundFastest: this.groundFastest,
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
            routeHover: this.routeHover,
        };

        this.state = state;
        return state;
    }

    public emitState(force: boolean): void {
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
