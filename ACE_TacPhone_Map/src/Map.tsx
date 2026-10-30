import React, { createRef, type RefObject } from 'react'
import styles from './styles.module.scss'

import "ol/ol.css";
import type { AppProps } from '@ace-tacphone/api';
import Map from "ol/Map";
import { View } from 'ol';
import type { ViewOptions } from 'ol/View.js';
import TileLayer from 'ol/layer/Tile';
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom';
import DragPan from 'ol/interaction/DragPan';
import type { MapBrowserEvent } from 'ol';
import type { FeatureLike } from 'ol/Feature';


import Projection from 'ol/proj/Projection';
import { getTopLeft } from 'ol/extent.js';
import TileGrid from 'ol/tilegrid/TileGrid.js';
import ImageTileSource from 'ol/source/ImageTile';

import { LayerSwitcher } from './LayerSwitcher';
import { MarkerLayerManager, type MarkerColor, type MarkerType } from './MapMarkers/MarkerLayer';
import { MarkerCreateDialog } from './MapMarkers/MarkerCreateDialog';
import { MarkerContextMenu } from './MapMarkers/MarkerContextMenu';
import { createMarker, createPolylineMarker, type MarkerCreationData } from './MapMarkers/MarkerApi';
import { PolylineDrawing, simplifyPolyline } from './MapMarkers/PolylineDrawing';
import { PolylineDrawControls } from './MapMarkers/PolylineDrawControls';
import { getTerrainHeights } from './MapMarkers/TerrainHeightApi';
import {
    MAP_SERVICE,
    MAP_SERVICE_VERSION,
    type MapApi,
    type MapFlyToOptions,
} from './api';

// Game-side data interest for marker updates. Must match INTEREST_MARKERS in
// addons/tacphone/apps/map/script_component.hpp.
const MAP_MARKERS_INTEREST = 'ACE_TacPhone_Map.markers';

const LONG_PRESS_DURATION_MS = 600;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
// Press-and-hold on a marker picks it up. Same delay for mouse and touch.
const MARKER_MOVE_HOLD_MS = 100;
// Assumed marker menu size, used to keep it inside the map container.
const MARKER_MENU_WIDTH_PX = 200;
const MARKER_MENU_HEIGHT_PX = 100;
const MARKER_MENU_MARGIN_PX = 8;

const TERRAIN_TILE_SIZE = 256;
const TERRAIN_MIN_RESOLUTION = 0.2;
const TERRAIN_TILE_CACHE_SIZE = 48;
// Placeholder size until the terrain SVG reports the real one.
const INITIAL_TERRAIN_EXTENT: [number, number, number, number] = [0, 0, 30720, 30720];

// Freehand strokes only record a vertex after the pointer moved this far, in
// map units (meters). Kept small enough to follow the hand, large enough that a
// stroke does not flood the game with points.
const POLYLINE_FREEHAND_MIN_DISTANCE_M = 5;
// Ramer-Douglas-Peucker tolerance applied to the drawn line before sending it.
const POLYLINE_SIMPLIFY_TOLERANCE_M = 2;

/**
 * Polyline input mode. Module scope keeps the checkbox choice for the current
 * page session, across Map panel mounts; a page reload resets it to freehand.
 */
let polylineClickPerPointMode = false;

/**
 * Terrain heights for the current page session, keyed by whole-meter map
 * coordinate. The terrain does not change while the page is open, so a point
 * only has to be asked for once, even across undos and new drawings.
 *
 * `globalThis.Map` because `Map` in this module is the OpenLayers map class.
 */
const terrainHeightCache = new globalThis.Map<string, number>();

/** Cache key for a map coordinate, rounded to whole meters. */
function terrainHeightKey(x: number, y: number): string {
    return `${Math.round(x)},${Math.round(y)}`;
}

interface MarkerDialogState {
  isOpen: boolean;
  mode: 'create' | 'edit';
  /** Internal name of the marker being edited; null while creating. */
  markerName: string | null;
  coordinate: [number, number] | null;
  initialLabel: string;
  initialType: string;
  initialColor: string;
  markerTypes: MarkerType[];
  markerColors: MarkerColor[];
}

interface MarkerMenuState {
  name: string;
  /** Position in pixels, relative to the map container. */
  x: number;
  y: number;
}

/** A marker lifted by the pointer, waiting to be dropped. */
interface MarkerMoveState {
  name: string;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  pointerType: string;
}

/** A pending press-and-hold on a marker that will start a move. */
interface MarkerHoldState {
  name: string;
  pointerId: number;
  x: number;
  y: number;
  pointerType: string;
}

interface PolylineDrawState {
  isActive: boolean;
  /** CfgMarkerColors class name of the line color; '' until the colors load. */
  color: string;
  /** Number of placed vertices, mirrored from PolylineDrawing for the UI. */
  vertexCount: number;
  /** Checkbox: a click/tap places one vertex instead of drawing freehand. */
  clickPerPoint: boolean;
}

interface MapState {
  layerSwitcherIsOpen: boolean;
  markerDialog: MarkerDialogState;
  markerMenu: MarkerMenuState | null;
  terrainError: string | null;
  polylineDraw: PolylineDrawState;
}

class App extends React.Component<AppProps,MapState> {
    // Setup the ref for the map canvas container element
    private mapRef: RefObject<HTMLDivElement | null> = createRef();
    // Keep the map instance directly on the class instance
    private map: Map | null = null;
    private terrainLayers: TileLayer<ImageTileSource>[] = [];
    private terrainLoadToken = 0;
    private terrainViewReady = false;

    private markerManager: MarkerLayerManager | null = null;

    /** Releases the marker-data interest; set while this panel is mounted. */
    private releaseMarkersInterest: (() => void) | undefined;

    /** Unregister function for the Map API. */
    private unregisterMapApi: (() => void) | undefined;

    private longPressTimer: number | null = null;
    private longPressStart: { x: number; y: number; pointerId: number; coordinate: [number, number] } | null = null;

    /** Marker under the mouse pointer, if it may be moved/deleted. */
    private hoveredMarkerName: string | null = null;
    /** Pending press-and-hold that will lift a marker. */
    private markerHoldTimer: number | null = null;
    private markerHoldStart: MarkerHoldState | null = null;
    /** Touch only: opens the context menu when the hold never turns into a drag. */
    private markerMenuTimer: number | null = null;
    /** Marker currently being dragged by the pointer. */
    private markerMoveState: MarkerMoveState | null = null;
    /** Pointer capture taken by the marker move, if it could be set. */
    private markerPointerCapture: { viewport: HTMLElement; pointerId: number } | null = null;

    private polylineDrawing: PolylineDrawing | null = null;
    /** Press that may become a vertex when the pointer does not pan (click mode). */
    private polylineTapStart: { pointerId: number; x: number; y: number } | null = null;
    /** Pointer currently drawing a freehand stroke, or null. */
    private polylineStrokePointerId: number | null = null;
    /** True while freehand mode suppresses native touch scrolling. */
    private freehandTouchCapture = false;
    /** Right-button pan, only handled while drawing mode is armed. */
    private drawingDragPan: DragPan | null = null;

    private loadMarkerIcon = (iconPath: string): Promise<string> => {
        if (!this.markerManager) {
            return Promise.reject(new Error('Marker manager is not initialized'));
        }

        return this.markerManager.loadMarkerIcon(iconPath);
    };


    constructor(props: AppProps) {
        super(props);
        this.state = {
            layerSwitcherIsOpen: false,
            markerDialog: {
                isOpen: false,
                mode: 'create',
                markerName: null,
                coordinate: null,
                initialLabel: '',
                initialType: '',
                initialColor: '',
                markerTypes: [],
                markerColors: [],
            },
            markerMenu: null,
            terrainError: null,
            polylineDraw: {
                isActive: false,
                color: '',
                vertexCount: 0,
                clickPerPoint: polylineClickPerPointMode,
            },
        };
    }

    private getPreservedViewState(
        previousView: View | null,
        extent: [number, number, number, number],
        maxResolution: number,
    ): { center: [number, number]; resolution: number } | null {
        if (!previousView) {
            return null;
        }

        const center = previousView.getCenter();
        const resolution = previousView.getResolution();

        if (
            !center ||
            !Number.isFinite(center[0]) ||
            !Number.isFinite(center[1]) ||
            typeof resolution !== 'number' ||
            !Number.isFinite(resolution) ||
            center[0] < extent[0] || center[0] > extent[2] ||
            center[1] < extent[1] || center[1] > extent[3] ||
            resolution < TERRAIN_MIN_RESOLUTION || resolution > maxResolution
        ) {
            return null;
        }

        return { center: [center[0], center[1]], resolution };
    }

    private createTerrainView(
        projection: Projection,
        extent: [number, number, number, number],
        previousView: View | null,
    ): { view: View; preserved: boolean } {
        // At this resolution a single tile covers the whole terrain, so it is the
        // farthest the view needs to zoom out. The extent constraint caps it further
        // when the panel is larger than that tile.
        const maxResolution = Math.max(
            Math.max(extent[2] - extent[0], extent[3] - extent[1]) / TERRAIN_TILE_SIZE,
            TERRAIN_MIN_RESOLUTION,
        );

        const options: ViewOptions = {
            projection,
            extent,
            // Let fit() show the whole terrain on panels whose aspect ratio differs
            // from the terrain instead of clipping one axis.
            showFullExtent: true,
            minResolution: TERRAIN_MIN_RESOLUTION,
            maxResolution,
            center: [
                (extent[0] + extent[2]) / 2,
                (extent[1] + extent[3]) / 2,
            ],
            resolution: maxResolution,
        };

        const preservedState = this.getPreservedViewState(previousView, extent, maxResolution);
        if (preservedState) {
            options.center = preservedState.center;
            options.resolution = preservedState.resolution;
        }

        return { view: new View(options), preserved: preservedState !== null };
    }

    /**
     * Holds the game-side marker interest while this panel is mounted. Multiple
     * Map panels share one game interest through the host's reference count, so
     * this is safe to call once per mounted panel and guarded against repeats.
     */
    private acquireMarkersInterest(): void {
        if (this.releaseMarkersInterest) {
            return;
        }

        this.releaseMarkersInterest = window.TacPhone.interests.acquire(MAP_MARKERS_INTEREST);
    }

    /**
     * Releases the marker interest exactly once, even when map creation failed
     * part-way. The stored disposer is idempotent, but it is also cleared so a
     * later mount cannot release twice.
     */
    private releaseMarkersInterestIfHeld(): void {
        const release = this.releaseMarkersInterest;
        if (!release) {
            return;
        }

        this.releaseMarkersInterest = undefined;
        release();
    }

    componentDidMount() {

        if (!this.mapRef.current) return;

        // Acquire the marker interest before the marker manager requests the
        // initial snapshot, so the game filters and sends marker updates from
        // that point on. The transport preserves request order, so the acquire
        // is processed before GetAllMarkers.
        this.acquireMarkersInterest();

        var projection = new Projection({
            code: 'static-image',
            units: 'pixels',
            extent: INITIAL_TERRAIN_EXTENT
        });

        const map = new Map({
            target: this.mapRef.current,
            layers: [],
            view: this.createTerrainView(projection, INITIAL_TERRAIN_EXTENT, null).view,
        });
        this.map = map;
        // The map instance is imperative, so re-render to hand it to the layer switcher.
        this.forceUpdate();

        this.markerManager = new MarkerLayerManager('Markers');
        this.markerManager.layer.setZIndex(1);
        map.addLayer(this.markerManager.layer);

        // Preview layer for the polyline being drawn, stacked above the markers.
        this.polylineDrawing = new PolylineDrawing();
        this.polylineDrawing.layer.setZIndex(2);
        map.addLayer(this.polylineDrawing.layer);

        // Drawing owns the left button, so a dedicated DragPan that only takes
        // the right mouse button keeps the map pannable while it is armed.
        this.drawingDragPan = new DragPan({ condition: this.isDrawingPanEvent });
        map.addInteraction(this.drawingDragPan);

        // Double-click (desktop) creates a marker. Remove the default double-click zoom
        // interaction so that creating a marker doesn't also zoom the map.
        [...map.getInteractions().getArray()].forEach((interaction) => {
            if (interaction instanceof DoubleClickZoom) {
                map.removeInteraction(interaction);
            }
        });

        map.on('dblclick', this.handleMapDoubleClick);

        // Long-press (touch) creates a marker.
        const viewport = map.getViewport();
        viewport.addEventListener('pointerdown', this.handleMapPointerDown);
        viewport.addEventListener('pointermove', this.handleMapPointerMove);
        viewport.addEventListener('pointerup', this.handleMapPointerUp);
        viewport.addEventListener('pointercancel', this.handleMapPointerUp);
        viewport.addEventListener('pointerleave', this.handleViewportPointerLeave);
        viewport.addEventListener('contextmenu', this.handleViewportContextMenu);
        // Not passive: Chromium only lets a touchmove listener stop the native
        // scroll/pan gesture (and with it `pointercancel`) when it can call
        // preventDefault(). `touch-action` is the primary guard; this is the
        // fallback for hosts that re-enable panning on an ancestor.
        viewport.addEventListener('touchmove', this.handleViewportTouchMove, { passive: false });

        // Delete key removes the hovered player marker.
        window.addEventListener('keydown', this.handleWindowKeyDown);

        void window.TacPhone.networking.LoadGameTerrain({ drawTreeObjects: false, layerMountains: true, simpleRoads: true })
            .then((svgString) => {
                const bytes = new TextEncoder().encode(svgString);
                return this.applyNewTerrainSVG(bytes);
            })
            .catch((error: unknown) => {
                console.error('Failed to load map terrain', error);
                this.showTerrainError(error);
            });

        /**
         * Build and register the MapApi when the map instance exists.
         * Registration happens here; flyTo requests before registration will be handled
         * by applyNewTerrainSVG when terrainViewReady becomes true.
         */
        this.buildAndRegisterMapApi();
    }

    private buildAndRegisterMapApi(): void {
        if (this.map === null) {
            return;
        }

        /**
         * The MapApi public interface for other apps:
         * - flyTo(options): move the map view
         * - getView(): get current view state
         * - isReady(): check if API is available
         */
        const api: MapApi = {
            flyTo: (options: MapFlyToOptions) => {
                // Validate before doing anything, including storing a pending target.
                if (
                    typeof options.x !== 'number' ||
                    typeof options.y !== 'number' ||
                    !Number.isFinite(options.x) ||
                    !Number.isFinite(options.y)
                ) {
                    console.warn('MapApi.flyTo: invalid x/y coordinates');
                    return;
                }

                // The terrain view is replaced once the SVG arrives, so a request
                // that arrives before then is applied by applyPendingFlyTo().
                if (!this.map || !this.terrainViewReady) {
                    this.pendingFlyTo = options;
                    return;
                }

                const view = this.map.getView();
                const projection = view.getProjection();

                const center = [options.x, options.y];

                // Clamp the center to the current view projection extent when one exists
                const extent = projection.getExtent();
                if (extent) {
                    center[0] = Math.max(extent[0], Math.min(options.x, extent[2]));
                    center[1] = Math.max(extent[1], Math.min(options.y, extent[3]));
                }

                // Only apply resolution when it is a finite positive number
                const resolution = options.resolution !== undefined && Number.isFinite(options.resolution) && options.resolution > 0 ? options.resolution : undefined;

                if (options.animate !== false) {
                    const animation: { center: number[]; resolution?: number; duration: number } = { center, duration: 300 };
                    if (resolution !== undefined)
                        animation.resolution = resolution;
                    view.animate(animation);
                } else {
                    view.setCenter(center);
                    if (resolution !== undefined) {
                        view.setResolution(resolution);
                    }
                }
            },
            getView: () => {
                if (!this.terrainViewReady || this.map === null) {
                    return undefined;
                }

                const view = this.map.getView();
                const center = view.getCenter();
                const resolution = view.getResolution();

                if (
                    !center ||
                    !Number.isFinite(center[0]) ||
                    !Number.isFinite(center[1]) ||
                    typeof resolution !== 'number' ||
                    !Number.isFinite(resolution)
                ) {
                    return undefined;
                }

                return { x: center[0], y: center[1], resolution };
            },
            isReady: () => {
                return this.terrainViewReady && this.map !== null;
            },
        };

        const registration = window.TacPhone.interApp.register(this.props.panel, {
            service: MAP_SERVICE,
            version: MAP_SERVICE_VERSION,
            api,
        });

        this.unregisterMapApi = registration;
    }

    componentWillUnmount(): void {
        /**
         * Release the marker interest first: it must happen even if the map was
         * only partially created, and no teardown step below can skip it.
         */
        this.releaseMarkersInterestIfHeld();

        /**
         * Unregister the MapApi BEFORE map teardown, so that window.TacPhone.interApp.list()
         * and other lookups see the cleanup immediately. The pendingFlyTo is now
         * stale (map is null), so we clear it as well.
         */
        if (this.unregisterMapApi) {
            this.unregisterMapApi();
            this.unregisterMapApi = undefined;
        }

        /** Clear pending fly-to on unmount. */
        this.pendingFlyTo = null;

        this.cancelLongPress();
        this.cancelMarkerHold();
        this.clearMarkerMenuTimer();
        this.polylineTapStart = null;
        this.polylineStrokePointerId = null;
        this.freehandTouchCapture = false;
        window.removeEventListener('keydown', this.handleWindowKeyDown);

        // Drop an in-progress marker move: flush the last position to the game
        // and make sure no pointer capture or disabled interaction survives.
        if (this.markerMoveState) {
            this.markerManager?.endMarkerMove(this.markerMoveState.name);
            this.markerMoveState = null;
        }
        this.releaseMarkerPointerCapture();
        this.setDragPanActive(true);
        this.hoveredMarkerName = null;

        this.terrainLoadToken += 1;

        const map = this.map;
        this.map = null;

        if (map) {
            map.un('dblclick', this.handleMapDoubleClick);

            const viewport = map.getViewport();
            viewport.removeEventListener('pointerdown', this.handleMapPointerDown);
            viewport.removeEventListener('pointermove', this.handleMapPointerMove);
            viewport.removeEventListener('pointerup', this.handleMapPointerUp);
            viewport.removeEventListener('pointercancel', this.handleMapPointerUp);
            viewport.removeEventListener('pointerleave', this.handleViewportPointerLeave);
            viewport.removeEventListener('contextmenu', this.handleViewportContextMenu);
            viewport.removeEventListener('touchmove', this.handleViewportTouchMove);

            // The preview layer needs the map only while it is attached.
            if (this.polylineDrawing) {
                map.removeLayer(this.polylineDrawing.layer);
            }

            if (this.drawingDragPan) {
                map.removeInteraction(this.drawingDragPan);
                this.drawingDragPan = null;
            }

            // Detach the map from the DOM target
            map.setTarget(undefined);
        }

        this.polylineDrawing?.destroy();
        this.polylineDrawing = null;

        // this.map is already null, so this only disposes the tile sources.
        this.disposeTerrainLayers();

        if (this.markerManager) {
            this.markerManager.destroy(); // Safely detaches from global registry
        }
    }

    private toggleLayerSwitcherMenu = (): void => {
        // The two panels share the same corner; never let them overlap.
        const aboutToOpen = !this.state.layerSwitcherIsOpen;
        if (aboutToOpen && this.state.polylineDraw.isActive) {
            this.stopPolylineDrawing();
        }

        this.setState((prevState) => ({ layerSwitcherIsOpen: !prevState.layerSwitcherIsOpen }));
    };

    private closeLayerSwitcherMenu = (): void => {
        this.setState({ layerSwitcherIsOpen: false });
    };

    /** Resolves a CfgMarkerColors class name to the CSS color used for the preview. */
    private getDrawingColorCss(colorClassName: string): string {
        const colors = this.markerManager?.getMarkerColors() ?? [];
        const match = colors.find((color) => color.className === colorClassName);
        return match?.color ?? '#ffffff';
    }

    /**
     * The marker config arrives asynchronously, so an armed drawing mode may
     * start without colors. This fills in the first one once they are known.
     */
    private loadDrawingColorsIfNeeded(): void {
        const manager = this.markerManager;
        if (!manager) {
            return;
        }

        void manager.whenMarkerConfigLoaded().then(() => {
            if (!this.map || !this.state.polylineDraw.isActive) {
                return;
            }

            const colors = manager.getMarkerColors();
            const color = this.state.polylineDraw.color || colors[0]?.className || '';

            this.setState((prevState) => ({
                polylineDraw: { ...prevState.polylineDraw, color },
            }));
            this.polylineDrawing?.setColor(this.getDrawingColorCss(color));
        });
    }

    private handlePolylineColorSelect = (colorClassName: string): void => {
        this.setState((prevState) => ({
            polylineDraw: { ...prevState.polylineDraw, color: colorClassName },
        }));
        this.polylineDrawing?.setColor(this.getDrawingColorCss(colorClassName));
    };

    private handlePolylineClickPerPointChange = (clickPerPoint: boolean): void => {
        polylineClickPerPointMode = clickPerPoint;

        // A mode switch ends the current gesture but keeps placed vertices.
        this.finishPolylineStroke();
        this.polylineTapStart = null;

        this.setState((prevState) => ({
            polylineDraw: { ...prevState.polylineDraw, clickPerPoint },
        }));

        this.polylineDrawing?.setMeasurementsEnabled(clickPerPoint);

        // Vertices placed in freehand mode have no heights yet, and the
        // measuring overlay needs one per point.
        if (clickPerPoint) {
            this.backfillPolylineHeights();
        }

        // Freehand owns the drag gesture and locks the map; click-per-point
        // needs drag-to-pan again.
        this.setDragPanActive(clickPerPoint);
        this.setFreehandTouchCapture(!clickPerPoint);
    };

    private togglePolylineDrawing = (): void => {
        if (this.state.polylineDraw.isActive) {
            this.stopPolylineDrawing();
            return;
        }

        const colors = this.markerManager?.getMarkerColors() ?? [];
        const color = this.state.polylineDraw.color || colors[0]?.className || '';

        // Drawing and the marker interaction panels are exclusive: they share
        // the map surface and the same pointer gestures.
        this.setState({
            layerSwitcherIsOpen: false,
            markerMenu: null,
            polylineDraw: {
                isActive: true,
                color,
                vertexCount: 0,
                clickPerPoint: polylineClickPerPointMode,
            },
        });

        this.polylineDrawing?.clear();
        this.polylineDrawing?.setColor(this.getDrawingColorCss(color));
        // Distances and angles are a click-per-point measuring aid; freehand
        // strokes are too dense to annotate.
        this.polylineDrawing?.setMeasurementsEnabled(polylineClickPerPointMode);
        this.polylineTapStart = null;
        this.polylineStrokePointerId = null;

        this.cancelMarkerHold();
        this.cancelLongPress();
        this.clearMarkerMenuTimer();
        // Drawing owns the pointer, so no marker is hovered any more. Without
        // this, a stale hover would keep the Delete key armed.
        this.hoveredMarkerName = null;

        if (this.markerMoveState) {
            this.markerManager?.endMarkerMove(this.markerMoveState.name);
            this.markerMoveState = null;
            this.releaseMarkerPointerCapture();
        }

        // Freehand drawing must not pan; click-per-point still relies on it.
        this.setDragPanActive(polylineClickPerPointMode);
        this.setFreehandTouchCapture(!polylineClickPerPointMode);
        this.setMapCursor('crosshair');

        if (colors.length === 0) {
            this.loadDrawingColorsIfNeeded();
        }
    };

    private stopPolylineDrawing = (): void => {
        this.polylineTapStart = null;
        this.polylineStrokePointerId = null;
        this.polylineDrawing?.setMeasurementsEnabled(false);
        this.polylineDrawing?.clear();
        this.setState((prevState) => ({
            polylineDraw: { ...prevState.polylineDraw, isActive: false, vertexCount: 0 },
        }));
        this.setDragPanActive(true);
        this.setFreehandTouchCapture(false);
        this.resetMapCursor();
    };

    private handlePolylineUndo = (): void => {
        this.finishPolylineStroke();
        this.polylineDrawing?.undoLastPoint();
        this.syncPolylineVertexCount();
    };

    private handlePolylineFinish = (): void => {
        this.finishPolylineStroke();

        const flat = this.polylineDrawing?.getFlatPolyline() ?? [];
        if (flat.length < 4) {
            return;
        }

        const drawn: Array<[number, number]> = [];
        for (let index = 0; index + 1 < flat.length; index += 2) {
            drawn.push([flat[index], flat[index + 1]]);
        }

        const points = simplifyPolyline(drawn, POLYLINE_SIMPLIFY_TOLERANCE_M);
        if (points.length < 2) {
            return;
        }

        // 'Default' is the game's CfgMarkerColors fallback, so a line can still
        // be created when the color list had not loaded yet.
        const color = this.state.polylineDraw.color || 'Default';

        try {
            // createPolylineMarker throws synchronously for invalid input, while
            // the request itself fails asynchronously.
            createPolylineMarker(points, color).catch((error: unknown) => {
                console.error('Failed to create polyline marker', error);
            });
        } catch (error) {
            console.error('Failed to create polyline marker', error);
        }

        // Keep the mode armed so several lines can be drawn in a row.
        this.polylineDrawing?.clear();
        this.polylineTapStart = null;
        this.setState((prevState) => ({
            polylineDraw: { ...prevState.polylineDraw, vertexCount: 0 },
        }));
    };

    /** Mirrors the preview's vertex count into React state. */
    private syncPolylineVertexCount(): void {
        const vertexCount = this.polylineDrawing?.getPointCount() ?? 0;
        this.setState((prevState) => ({
            polylineDraw: { ...prevState.polylineDraw, vertexCount },
        }));
    }

    /**
     * Fetches terrain heights for the vertices at `indices` and applies them to
     * the preview, using cached heights where possible. Only used by the
     * click-per-point measuring overlay; freehand strokes request no heights.
     */
    private requestPolylineHeights(indices: readonly number[]): void {
        const drawing = this.polylineDrawing;
        if (!drawing || indices.length === 0) {
            return;
        }

        const positions: Array<[number, number]> = [];
        const requested: Array<{ index: number; point: [number, number] }> = [];

        for (const index of indices) {
            const point = drawing.getPoint(index);
            if (!point) {
                continue;
            }

            // A cached height can be applied right away, which also covers the
            // backfill after a mode switch without a round trip.
            const cached = terrainHeightCache.get(terrainHeightKey(point[0], point[1]));
            if (cached !== undefined) {
                drawing.setPointHeight(index, cached);
                continue;
            }

            positions.push(point);
            requested.push({ index, point });
        }

        if (positions.length === 0) {
            return;
        }

        getTerrainHeights(positions)
            .then((heights) => {
                for (let i = 0; i < requested.length; i++) {
                    const { index, point } = requested[i];
                    const height = heights[i];
                    terrainHeightCache.set(terrainHeightKey(point[0], point[1]), height);

                    // The vertex may have been undone or replaced while the
                    // request was in flight, so the index is only trusted while
                    // it still holds the same coordinate.
                    const current = this.polylineDrawing?.getPoint(index);
                    if (current && current[0] === point[0] && current[1] === point[1]) {
                        this.polylineDrawing?.setPointHeight(index, height);
                    }
                }
            })
            .catch((error: unknown) => {
                console.warn('Failed to fetch terrain heights', error);
            });
    }

    /** Requests heights for every vertex already placed, e.g. after a mode switch. */
    private backfillPolylineHeights(): void {
        const count = this.polylineDrawing?.getPointCount() ?? 0;
        if (count === 0) {
            return;
        }

        const indices: number[] = [];
        for (let index = 0; index < count; index++) {
            indices.push(index);
        }

        this.requestPolylineHeights(indices);
    }

    /**
     * Adds a map coordinate to the preview when it is at least `minDistance`
     * away from the previous vertex (`0` disables the distance check). Distance
     * is in map units, which are meters on the terrain projection.
     */
    private appendPolylineCoordinate(coordinate: [number, number], minDistance: number): void {
        const drawing = this.polylineDrawing;
        if (!drawing) {
            return;
        }

        if (minDistance > 0) {
            const flat = drawing.getFlatPolyline();
            if (flat.length >= 2) {
                const dx = coordinate[0] - flat[flat.length - 2];
                const dy = coordinate[1] - flat[flat.length - 1];
                if (dx * dx + dy * dy < minDistance * minDistance) {
                    return;
                }
            }
        }

        const nextIndex = drawing.getPointCount();
        drawing.addPoint(coordinate);

        // Heights are only annotated in the click-per-point measuring overlay,
        // so a freehand stroke (which can add many points) asks for none.
        if (this.state.polylineDraw.clickPerPoint && drawing.getPointCount() > nextIndex) {
            this.requestPolylineHeights([nextIndex]);
        }
    }

    private beginPolylineStroke(event: PointerEvent): void {
        const map = this.map;
        if (!map || this.polylineStrokePointerId !== null) {
            return;
        }

        const coordinate = map.getEventCoordinate(event);
        if (!coordinate) {
            return;
        }

        this.polylineStrokePointerId = event.pointerId;
        this.appendPolylineCoordinate(
            [coordinate[0], coordinate[1]],
            POLYLINE_FREEHAND_MIN_DISTANCE_M,
        );

        // Freehand drawing must never pan the map, even if the mode was toggled
        // while a marker move was still winding down.
        this.setDragPanActive(false);
        this.setMapCursor('crosshair');
    }

    private extendPolylineStroke(event: PointerEvent): void {
        if (this.polylineStrokePointerId === null || event.pointerId !== this.polylineStrokePointerId) {
            return;
        }

        const map = this.map;
        if (!map) {
            return;
        }

        const coordinate = map.getEventCoordinate(event);
        if (!coordinate) {
            return;
        }

        this.appendPolylineCoordinate(
            [coordinate[0], coordinate[1]],
            POLYLINE_FREEHAND_MIN_DISTANCE_M,
        );
    }

    /**
     * Ends the stroke without dropping points. Keeps the count in React state
     * up to date only here, so a long drag does not re-render the panel on
     * every sampled vertex.
     */
    private finishPolylineStroke(event?: PointerEvent): void {
        if (this.polylineStrokePointerId === null) {
            return;
        }

        if (event && event.pointerId !== this.polylineStrokePointerId) {
            return;
        }

        this.polylineStrokePointerId = null;
        this.syncPolylineVertexCount();
    }

    /**
     * Adds a vertex at the pointer position in click-per-point mode. A tap that
     * lands on the last vertex is ignored: double-taps and finger jitter would
     * otherwise create zero-length segments the game cannot draw.
     */
    private addPolylineVertex(event: PointerEvent): void {
        const map = this.map;
        const drawing = this.polylineDrawing;
        if (!map || !drawing) {
            return;
        }

        const coordinate = map.getEventCoordinate(event);
        if (!coordinate) {
            return;
        }

        const flat = drawing.getFlatPolyline();
        if (flat.length >= 2) {
            const lastPixel = map.getPixelFromCoordinate([
                flat[flat.length - 2],
                flat[flat.length - 1],
            ]);
            const pixel = map.getPixelFromCoordinate([coordinate[0], coordinate[1]]);

            if (lastPixel && pixel) {
                const dx = pixel[0] - lastPixel[0];
                const dy = pixel[1] - lastPixel[1];
                if (dx * dx + dy * dy <= 36) {
                    return;
                }
            }
        }

        this.appendPolylineCoordinate([coordinate[0], coordinate[1]], 0);
        this.syncPolylineVertexCount();
        this.setMapCursor('crosshair');
    }

    private showTerrainError(error: unknown): void {
        if (!this.map) {
            return;
        }

        this.setState({
            terrainError: error instanceof Error ? error.message : String(error),
        });
    }

    private handleMapDoubleClick = (event: MapBrowserEvent): void => {
        // Two tap-ups already placed the points; the double-click emulation
        // would only try to create a marker on top of the line.
        if (this.state.polylineDraw.isActive) {
            return;
        }

        // OpenLayers also emulates double-click for touch double taps.
        // Touch markers open the context menu instead.
        const originalEvent = event.originalEvent as PointerEvent;
        if (originalEvent.pointerType === 'touch') {
            return;
        }

        // A double-click on a player marker edits it; any other marker owns the
        // spot, so no new marker may be created on top of it.
        const markerName = this.getEditableMarkerNameAtEvent(originalEvent);
        if (markerName) {
            this.openMarkerEditDialog(markerName);
            return;
        }

        if (this.getMarkerNameAtEvent(originalEvent)) {
            return;
        }

        this.openMarkerDialog([event.coordinate[0], event.coordinate[1]]);
    };

    private getMarkerFeatureAtEvent(event: PointerEvent | MouseEvent): FeatureLike | null {
        const map = this.map;
        const manager = this.markerManager;

        if (!map || !manager) {
            return null;
        }

        return map.forEachFeatureAtPixel(
            map.getEventPixel(event),
            (candidate) => candidate,
            {
                layerFilter: (layer) => layer === manager.layer,
                hitTolerance: 6,
            },
        ) ?? null;
    }

    /**
     * Returns the name of any registered marker under the event, or null.
     */
    private getMarkerNameAtEvent(event: PointerEvent | MouseEvent): string | null {
        const feature = this.getMarkerFeatureAtEvent(event);
        return feature ? this.markerManager?.getMarkerName(feature) ?? null : null;
    }

    /**
     * Returns the name of the player marker under the event, or null. Only
     * `_USER_DEFINED` point markers of the marker layer are considered, so the
     * result is always safe to pass to the manager's edit/move/delete methods.
     */
    private getEditableMarkerNameAtEvent(event: PointerEvent | MouseEvent): string | null {
        const feature = this.getMarkerFeatureAtEvent(event);
        return feature ? this.markerManager?.getEditableMarkerName(feature) ?? null : null;
    }

    /** Enables/disables map panning while a marker is dragged. */
    private setDragPanActive(active: boolean): void {
        this.map?.getInteractions().forEach((interaction) => {
            // The right-button drawing pan decides on its own (see
            // isDrawingPanEvent), so it is never toggled here.
            if (interaction instanceof DragPan && interaction !== this.drawingDragPan) {
                interaction.setActive(active);
            }
        });
    }

    /**
     * Condition of the right-button DragPan: a held right mouse button pans the
     * map, but only while the drawing mode owns the other gestures.
     */
    private isDrawingPanEvent = (event: MapBrowserEvent): boolean => {
        if (!this.state.polylineDraw.isActive) {
            return false;
        }

        const originalEvent = event.originalEvent;
        return (
            originalEvent instanceof PointerEvent &&
            originalEvent.pointerType === 'mouse' &&
            originalEvent.isPrimary &&
            originalEvent.button === 2
        );
    };

    /**
     * Freehand drawing has to own the whole touch gesture. `ol.css` leaves
     * `touch-action: pan-x pan-y` on the viewport, so on touch the browser
     * claims a drag for native panning after a few pixels, sends
     * `pointercancel`, and the stroke ends after a handful of samples. Only
     * freehand mode disables it: click-per-point keeps native gestures so
     * drag-to-pan still works there.
     */
    private setFreehandTouchCapture(active: boolean): void {
        this.freehandTouchCapture = active;

        const viewport = this.map?.getViewport();
        if (!viewport) {
            return;
        }

        viewport.style.touchAction = active ? 'none' : '';
    }

    /**
     * Last line of defence for freehand drawing: while it is armed, no touch
     * gesture may scroll or pan, even if an ancestor or the host re-enables it.
     * Without this a native pan also fires `pointercancel` and ends the stroke.
     */
    private handleViewportTouchMove = (event: TouchEvent): void => {
        if (!this.freehandTouchCapture) {
            return;
        }

        if (event.cancelable) {
            event.preventDefault();
        }
    };

    private setMapCursor(cursor: string): void {
        const map = this.map;
        if (!map) {
            return;
        }

        map.getViewport().style.cursor = cursor;
    }

    private resetMapCursor(): void {
        this.setMapCursor('');
    }

    private static hasMovedBeyondTolerance(x: number, y: number, event: PointerEvent): boolean {
        const dx = event.clientX - x;
        const dy = event.clientY - y;

        return dx * dx + dy * dy > LONG_PRESS_MOVE_TOLERANCE_PX * LONG_PRESS_MOVE_TOLERANCE_PX;
    }

    private updateMarkerHover(event: PointerEvent): void {
        if (this.markerMoveState) {
            return;
        }

        const name = this.getEditableMarkerNameAtEvent(event);
        if (name === this.hoveredMarkerName) {
            return;
        }

        this.hoveredMarkerName = name;
        this.setMapCursor(name ? 'grab' : '');
    }

    private handleViewportPointerLeave = (): void => {
        // A freehand stroke that leaves the map ends there: without pointer
        // capture there is no pointerup for it any more.
        if (this.state.polylineDraw.isActive) {
            this.finishPolylineStroke();
            this.polylineTapStart = null;
            return;
        }

        // With pointer capture the pointer keep sending events, so this only
        // fires for a pointer that really left the map.
        this.hoveredMarkerName = null;
        this.polylineTapStart = null;
        this.cancelMarkerHold();

        if (!this.markerMoveState) {
            this.resetMapCursor();
        }
    };

    private handleViewportContextMenu = (event: MouseEvent): void => {
        // Drawing mode owns the pointer gestures; a right click or touch hold on
        // empty map space must not open the native menu.
        if (this.state.polylineDraw.isActive) {
            event.preventDefault();
            return;
        }

        // The native menu would otherwise pop up on right click / touch hold and
        // steal the gesture, but it stays available on empty map space.
        if (this.markerMoveState || this.markerHoldStart) {
            event.preventDefault();
            return;
        }

        if (this.getEditableMarkerNameAtEvent(event)) {
            event.preventDefault();
        }
    };

    private handleWindowKeyDown = (event: KeyboardEvent): void => {
        // Esc leaves the drawing mode; the Delete handling below only concerns
        // markers.
        if (event.key === 'Escape' && this.state.polylineDraw.isActive) {
            if (App.isEditableElement(event.target) || App.isEditableElement(document.activeElement)) {
                return;
            }

            event.preventDefault();
            this.stopPolylineDrawing();
            return;
        }

        if (event.key !== 'Delete') {
            return;
        }

        // Drawing suppresses marker interaction, so it must not delete either.
        if (this.state.polylineDraw.isActive) {
            return;
        }

        const name = this.hoveredMarkerName;
        if (!name) {
            return;
        }

        // Never swallow Delete while the user types into a field.
        if (App.isEditableElement(event.target) || App.isEditableElement(document.activeElement)) {
            return;
        }

        event.preventDefault();
        this.markerManager?.deleteMarker(name);

        this.hoveredMarkerName = null;
        this.resetMapCursor();
        this.closeMarkerMenu();
    };

    private static isEditableElement(target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) {
            return false;
        }

        if (target.isContentEditable) {
            return true;
        }

        return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
    }

    private startMarkerHold(name: string, event: PointerEvent, durationMs: number): void {
        this.cancelMarkerHold();

        this.markerHoldStart = {
            name,
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            pointerType: event.pointerType,
        };

        this.markerHoldTimer = window.setTimeout(() => {
            const hold = this.markerHoldStart;
            this.markerHoldTimer = null;
            this.markerHoldStart = null;

            if (!hold) {
                return;
            }

            this.beginMarkerMove(hold);
        }, durationMs);
    }

    private cancelMarkerHold(): void {
        if (this.markerHoldTimer !== null) {
            window.clearTimeout(this.markerHoldTimer);
            this.markerHoldTimer = null;
        }

        this.markerHoldStart = null;
    }

    private clearMarkerMenuTimer(): void {
        if (this.markerMenuTimer !== null) {
            window.clearTimeout(this.markerMenuTimer);
            this.markerMenuTimer = null;
        }
    }

    private beginMarkerMove(hold: MarkerHoldState): void {
        const manager = this.markerManager;
        const map = this.map;

        if (!manager || !map || !manager.beginMarkerMove(hold.name)) {
            return;
        }

        this.closeMarkerMenu();

        this.markerMoveState = {
            name: hold.name,
            pointerId: hold.pointerId,
            startX: hold.x,
            startY: hold.y,
            lastX: hold.x,
            lastY: hold.y,
            moved: false,
            pointerType: hold.pointerType,
        };

        // The map must not pan while the marker follows the pointer.
        this.setDragPanActive(false);
        this.setMapCursor('grabbing');

        // Touch keeps lifting the marker at 100 ms, but a hold that never
        // turns into a drag is a request for the marker menu, not a move.
        if (hold.pointerType !== 'mouse') {
            this.clearMarkerMenuTimer();
            this.markerMenuTimer = window.setTimeout(() => {
                this.markerMenuTimer = null;

                const move = this.markerMoveState;
                if (!move || move.moved || move.pointerId !== hold.pointerId) {
                    return;
                }

                this.markerManager?.endMarkerMove(move.name);
                this.releaseMarkerPointerCapture();
                this.setDragPanActive(true);
                this.markerMoveState = null;
                this.resetMapCursor();
                this.openMarkerMenu(move.name, move.lastX, move.lastY);
            }, LONG_PRESS_DURATION_MS - MARKER_MOVE_HOLD_MS);
        }

        const viewport = map.getViewport();
        try {
            viewport.setPointerCapture(hold.pointerId);
            this.markerPointerCapture = { viewport, pointerId: hold.pointerId };
        } catch {
            // Capture is best effort; the pointer may already be gone.
            this.markerPointerCapture = null;
        }
    }

    private releaseMarkerPointerCapture(): void {
        const capture = this.markerPointerCapture;
        if (!capture) {
            return;
        }

        this.markerPointerCapture = null;

        try {
            capture.viewport.releasePointerCapture(capture.pointerId);
        } catch {
            // Already released by the browser.
        }
    }

    private handleMapPointerDown = (event: PointerEvent): void => {
        if (!event.isPrimary) {
            return;
        }

        // Ignore map controls (zoom buttons, attribution, ...) and OpenLayers overlays.
        if (event.target instanceof Element && event.target.closest('.ol-overlaycontainer-stopevent')) {
            return;
        }

        // Drawing owns the pointer. Freehand starts a stroke right away;
        // click-per-point only remembers the press until pointerup, so a drag
        // can still pan.
        if (this.state.polylineDraw.isActive) {
            if (event.pointerType === 'mouse' && event.button !== 0) {
                return;
            }

            this.cancelLongPress();

            if (this.state.polylineDraw.clickPerPoint) {
                this.polylineTapStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
            } else {
                this.beginPolylineStroke(event);
            }

            return;
        }

        if (event.pointerType === 'mouse') {
            // Only the primary button grabs markers; the right button is left to
            // the contextmenu handler.
            if (event.button !== 0) {
                return;
            }

            const name = this.getEditableMarkerNameAtEvent(event);
            if (!name) {
                return;
            }

            this.cancelLongPress();
            this.startMarkerHold(name, event, MARKER_MOVE_HOLD_MS);
            return;
        }

        if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
            return;
        }

        this.cancelLongPress();

        // A press on a player marker grabs the marker; any other marker owns
        // the spot, so the create-marker long press must not start there.
        const markerName = this.getEditableMarkerNameAtEvent(event);
        if (markerName) {
            this.startMarkerHold(markerName, event, MARKER_MOVE_HOLD_MS);
            return;
        }

        if (this.getMarkerNameAtEvent(event)) {
            return;
        }

        const coordinate = this.map?.getEventCoordinate(event);
        if (!coordinate) {
            return;
        }

        this.longPressStart = {
            x: event.clientX,
            y: event.clientY,
            pointerId: event.pointerId,
            coordinate: [coordinate[0], coordinate[1]],
        };

        this.longPressTimer = window.setTimeout(() => {
            const start = this.longPressStart;
            this.longPressTimer = null;

            if (!start) {
                return;
            }

            this.longPressStart = null;
            this.openMarkerDialog(start.coordinate);
        }, LONG_PRESS_DURATION_MS);
    };

    private handleMapPointerMove = (event: PointerEvent): void => {
        // No hover or marker drag while drawing. Freehand samples the stroke;
        // click-per-point drops the pending vertex once the pointer pans.
        if (this.state.polylineDraw.isActive) {
            if (event.pointerType === 'mouse' && event.buttons !== 0) {
                // A held right button pans the map (drawing DragPan), so it
                // gets its own cursor; the left button keeps the crosshair.
                this.setMapCursor(event.buttons === 2 ? 'grabbing' : 'crosshair');
            }

            if (this.state.polylineDraw.clickPerPoint) {
                const start = this.polylineTapStart;
                if (start && App.hasMovedBeyondTolerance(start.x, start.y, event)) {
                    this.polylineTapStart = null;
                }
            } else {
                this.extendPolylineStroke(event);
            }
            return;
        }

        const move = this.markerMoveState;
        if (move && event.pointerId === move.pointerId) {
            this.updateMarkerMove(event, move);
            return;
        }

        // Hover only while no button is pressed, so panning does not flicker the
        // cursor between grab and the default.
        if (event.pointerType === 'mouse' && event.buttons === 0) {
            this.updateMarkerHover(event);
        }

        const hold = this.markerHoldStart;
        if (hold && event.pointerId === hold.pointerId && App.hasMovedBeyondTolerance(hold.x, hold.y, event)) {
            // The pointer pans the map instead of grabbing the marker.
            this.cancelMarkerHold();
            return;
        }

        const start = this.longPressStart;
        if (!start || event.pointerId !== start.pointerId) {
            return;
        }

        if (App.hasMovedBeyondTolerance(start.x, start.y, event)) {
            this.cancelLongPress();
        }
    };

    private updateMarkerMove(event: PointerEvent, move: MarkerMoveState): void {
        const map = this.map;
        if (!map) {
            return;
        }

        // Holding still is a "select" gesture on touch, so the marker must not
        // jump to the finger before the user actually drags.
        if (!move.moved && !App.hasMovedBeyondTolerance(move.startX, move.startY, event)) {
            return;
        }

        move.moved = true;
        move.lastX = event.clientX;
        move.lastY = event.clientY;
        // A real drag wins over the touch hold-to-open-menu timer.
        this.clearMarkerMenuTimer();
        event.preventDefault();

        const coordinate = map.getEventCoordinate(event);
        this.markerManager?.moveMarker(move.name, [coordinate[0], coordinate[1]]);
    }

    private handleMapPointerUp = (event: PointerEvent): void => {
        if (this.state.polylineDraw.isActive) {
            if (event.pointerType === 'mouse' && event.button === 2) {
                // End of a right-button pan; back to drawing.
                this.setMapCursor('crosshair');
            }

            if (!this.state.polylineDraw.clickPerPoint) {
                this.finishPolylineStroke(event);
                return;
            }

            const start = this.polylineTapStart;
            if (!start || start.pointerId !== event.pointerId) {
                return;
            }

            this.polylineTapStart = null;

            if (event.type === 'pointercancel' || App.hasMovedBeyondTolerance(start.x, start.y, event)) {
                return;
            }

            this.addPolylineVertex(event);
            return;
        }

        const move = this.markerMoveState;
        if (move && event.pointerId === move.pointerId) {
            this.finishMarkerMove(event, move);
            return;
        }

        if (this.markerHoldStart && event.pointerId === this.markerHoldStart.pointerId) {
            this.cancelMarkerHold();
        }

        if (this.longPressStart && event.pointerId === this.longPressStart.pointerId) {
            this.cancelLongPress();
        }
    };

    private finishMarkerMove(event: PointerEvent, move: MarkerMoveState): void {
        const manager = this.markerManager;
        this.clearMarkerMenuTimer();
        const cancelled = event.type === 'pointercancel'; // pointercancel is bound to the same handler
        const coordinate = cancelled ? null : (this.map?.getEventCoordinate(event) ?? null);

        if (manager) {
            if (move.moved && coordinate) {
                manager.endMarkerMove(move.name, [coordinate[0], coordinate[1]]);
            } else {
                // A press without a drag selects the marker; drop it where it
                // already is instead of snapping it to the pointer.
                manager.endMarkerMove(move.name);
            }
        }

        this.releaseMarkerPointerCapture();
        this.setDragPanActive(true);
        this.markerMoveState = null;

        if (this.hoveredMarkerName) {
            this.setMapCursor('grab');
        } else {
            this.resetMapCursor();
        }

        // Release without dragging on touch/pen opens the marker menu. Desktop
        // keeps its hover + Delete key flow and never opens the menu from a drag.
        if (!cancelled && !move.moved && move.pointerType !== 'mouse') {
            this.openMarkerMenu(move.name, event.clientX, event.clientY);
        }
    }

    private cancelLongPress(): void {
        if (this.longPressTimer !== null) {
            window.clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }

        this.longPressStart = null;
    }

    private openMarkerDialog = (coordinate: [number, number]): void => {
        this.openMarkerDialogWith({
            mode: 'create',
            markerName: null,
            coordinate,
            initialLabel: '',
            initialType: '',
            initialColor: '',
        });
    };

    /**
     * Opens the marker dialog pre-filled for an existing player marker.
     */
    private openMarkerEditDialog = (name: string): void => {
        const data = this.markerManager?.getMarkerData(name);
        if (!data) {
            return;
        }

        this.openMarkerDialogWith({
            mode: 'edit',
            markerName: name,
            coordinate: data.position,
            initialLabel: data.label,
            initialType: data.type,
            initialColor: data.color,
        });
    };

    private openMarkerDialogWith(dialog: {
        mode: 'create' | 'edit';
        markerName: string | null;
        coordinate: [number, number];
        initialLabel: string;
        initialType: string;
        initialColor: string;
    }): void {
        const markerManager = this.markerManager;

        if (!markerManager) {
            return;
        }

        const markerTypes = markerManager.getMarkerTypes();
        const markerColors = markerManager.getMarkerColors();

        this.setState({
            layerSwitcherIsOpen: false,
            markerMenu: null,
            markerDialog: {
                isOpen: true,
                ...dialog,
                markerTypes,
                markerColors,
            },
        });

        if (markerTypes.length === 0 || markerColors.length === 0) {
            void markerManager.whenMarkerConfigLoaded().then(() => {
                if (!this.map) {
                    return;
                }

                this.setState((prevState) => ({
                    markerDialog: {
                        ...prevState.markerDialog,
                        markerTypes: markerManager.getMarkerTypes(),
                        markerColors: markerManager.getMarkerColors(),
                    },
                }));
            });
        }
    }

    private closeMarkerDialog = (): void => {
        this.setState((prevState) => ({
            markerDialog: {
                ...prevState.markerDialog,
                isOpen: false,
                coordinate: null,
            },
        }));
    };

    private handleMarkerDialogSubmit = (marker: MarkerCreationData): void => {
        const { mode, markerName } = this.state.markerDialog;

        if (mode === 'edit' && markerName !== null) {
            this.markerManager?.updateMarkerProperties(markerName, {
                label: marker.label,
                type: marker.type,
                color: marker.color,
            });
        } else {
            createMarker(marker).catch((error: unknown) => {
                console.error('Failed to create marker', error);
            });
        }

        this.closeMarkerDialog();
    };

    /**
     * Opens the marker context menu at a screen position, clamped so the menu
     * stays inside the map container.
     */
    private openMarkerMenu = (name: string, clientX: number, clientY: number): void => {
        const container = this.mapRef.current;

        if (!container) {
            return;
        }

        const rect = container.getBoundingClientRect();

        const maxX = Math.max(MARKER_MENU_MARGIN_PX, rect.width - MARKER_MENU_WIDTH_PX - MARKER_MENU_MARGIN_PX);
        const maxY = Math.max(MARKER_MENU_MARGIN_PX, rect.height - MARKER_MENU_HEIGHT_PX - MARKER_MENU_MARGIN_PX);

        const x = Math.min(Math.max(clientX - rect.left, MARKER_MENU_MARGIN_PX), maxX);
        const y = Math.min(Math.max(clientY - rect.top, MARKER_MENU_MARGIN_PX), maxY);

        this.setState({
            layerSwitcherIsOpen: false,
            markerMenu: { name, x, y },
        });
    };

    private closeMarkerMenu = (): void => {
        if (this.state.markerMenu === null) {
            return;
        }

        this.setState({ markerMenu: null });
    };

    private handleEditMarkerFromMenu = (name: string): void => {
        this.closeMarkerMenu();
        this.openMarkerEditDialog(name);
    };

    private handleDeleteMarkerFromMenu = (name: string): void => {
        this.markerManager?.deleteMarker(name);

        if (this.hoveredMarkerName === name) {
            this.hoveredMarkerName = null;
            this.resetMapCursor();
        }

        this.closeMarkerMenu();
    };


    private splitSVGIntoLayers(bytes: Uint8Array<ArrayBuffer>): {
        width: number;
        height: number;
        layers: Array<{ name: string; imageUrl: string }>;
    } {
        // The SVG file contains the size of the terrain, which we need to know for our tiling and scaling
        // And we also want to split out the SVG layers

        const svgDoc = (new DOMParser()).parseFromString((new TextDecoder('utf-8')).decode(bytes), 'image/svg+xml');
        const rootSvg = svgDoc.documentElement;

        if (rootSvg.tagName.toLowerCase() !== 'svg') {
            throw new Error('The terrain response is not a valid SVG document.');
        }

        // Base measurements of your standalone SVG artwork blueprint
        const widthAttribute = rootSvg.getAttribute("width"); // Get the Terrain size from the SVG head
        const heightAttribute = rootSvg.getAttribute("height");
        const svgBaseWidth = Number(widthAttribute);
        const svgBaseHeight = Number(heightAttribute);

        if (
            widthAttribute === null ||
            heightAttribute === null ||
            !Number.isFinite(svgBaseWidth) ||
            !Number.isFinite(svgBaseHeight) ||
            svgBaseWidth <= 0 ||
            svgBaseHeight <= 0
        ) {
            throw new Error('The terrain SVG is missing a valid width or height.');
        }

        const originalDefs = rootSvg.querySelector("defs"); // defs will be copied into every file
        if (!originalDefs) {
            throw new Error('The terrain SVG is missing its <defs> section.');
        }

        const layers = rootSvg.querySelectorAll("svg > g");
        if (layers.length === 0) {
            throw new Error('The terrain SVG does not contain any layers.');
        }

        var svgSplitLayers: Array<{name: string, imageUrl: string}> = []; // We will split out the different layers

        layers.forEach((layer, index) => {
            // Clone the root <svg> element (shallow clone, so it copies attributes but not children)
            const newSvg = rootSvg.cloneNode(false);
            newSvg.appendChild(originalDefs.cloneNode(true)); // Deep clone the defs
            newSvg.appendChild(layer.cloneNode(true)); // Add the deep cloned layer

            // Serialize the newly constructed SVG DOM tree back into a string
            const serializer = new XMLSerializer();
            const newSVGString = serializer.serializeToString(newSvg);

            const svgBlob = new Blob([newSVGString], { type: "image/svg+xml;charset=utf-8" });
            const blobURL = URL.createObjectURL(svgBlob);

            svgSplitLayers.push({ name: layer.id || `Layer ${index + 1}`, imageUrl: blobURL});
        });

        return {
            width: svgBaseWidth,
            height: svgBaseHeight,
            layers: svgSplitLayers
        };
    }

    private loadTerrainLayerImage(layer: { name: string; imageUrl: string }): Promise<{ name: string; image: HTMLImageElement }> {
        return new Promise((resolve, reject) => {
            const image = new Image();

            image.onload = () => {
                // The browser no longer needs the blob URL once the image is decoded.
                URL.revokeObjectURL(layer.imageUrl);
                resolve({ name: layer.name, image });
            };

            image.onerror = () => {
                URL.revokeObjectURL(layer.imageUrl);
                reject(new Error(`Failed to load terrain layer "${layer.name}".`));
            };

            image.src = layer.imageUrl;
        });
    }

    private disposeTerrainLayers(): void {
        const map = this.map;

        for (const layer of this.terrainLayers) {
            map?.removeLayer(layer);

            const source = layer.getSource();
            layer.setSource(null);
            source?.dispose();
            layer.dispose();
        }

        this.terrainLayers = [];
    }

    private async applyNewTerrainSVG(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        const map = this.map;
        if (!map) {
            return;
        }

        const loadToken = ++this.terrainLoadToken;
        this.setState({ terrainError: null });

        const svgData = this.splitSVGIntoLayers(bytes);

        // Base measurements of your standalone SVG artwork blueprint
        const svgBaseWidth = svgData.width;
        const svgBaseHeight = svgData.height;
        const tileSize = TERRAIN_TILE_SIZE; // Standard map grid slice dimension

        // 1. Establish the boundary coordinate limits matching the SVG native dimensions
        const extent: [number, number, number, number] = [0, 0, svgBaseWidth, svgBaseHeight];
        const projection = map.getView().getProjection();
        projection.setExtent(extent);

        // 2. Generate custom resolution steps for smooth zooming calculation
        const maxZoom = 5;
        const resolutions: Array<number> = [];
        for (let z = 0; z <= maxZoom; ++z) {
            resolutions.push(Math.pow(2, maxZoom - z));
        }
        // We are converting SVG (which has millimeter-accurate information) to pixels.
        // This number is how many meters, one pixel is, on the most zoomed-in state. The code above stops at 1-meter
        resolutions.push(0.2);

        // 3. Set up the logical map tile matrix structure
        const tileGrid = new TileGrid({
            origin: getTopLeft(extent),
            resolutions: resolutions,
            tileSize: tileSize,
        });

        // Load every split SVG image first, so a failure cannot leave half-created
        // tile sources behind.
        const loadedLayers = await Promise.all(
            svgData.layers.map((layer) => this.loadTerrainLayerImage(layer))
        ).catch((error: unknown) => {
            // Ignore failures from a load that has already been superseded.
            if (this.map === map && loadToken === this.terrainLoadToken) {
                throw error;
            }

            return null;
        });

        if (!loadedLayers || this.map !== map || loadToken !== this.terrainLoadToken) {
            return;
        }

        // 4. Create a custom on-the-fly rasterizer source for each layer
        const newLayers: TileLayer<ImageTileSource>[] = [];
        try {
            for (const loadedLayer of loadedLayers) {
                const tileImage = loadedLayer.image;

                const svgTileSource = new ImageTileSource({
                    tileGrid: tileGrid,
                    projection: projection,
                    // The loader function handles slicing on demand
                    loader: function (z, x, y) {
                        return new Promise((resolve, reject) => {
                            // Calculate how many raw coordinate map units fit inside this single screen slice
                            const resolution = resolutions[z];
                            const chunkWidth = tileSize * resolution;
                            const chunkHeight = tileSize * resolution;

                            // Pinpoint the exact viewport frame block context to isolate and crop
                            const svgX = x * chunkWidth;
                            const svgY = y * chunkHeight;

                            // Draw the computed vector fragment text onto an offscreen canvas component
                            const canvas = document.createElement('canvas');
                            canvas.width = tileSize;
                            canvas.height = tileSize;
                            const ctx = canvas.getContext('2d');

                            if (!ctx) {
                                reject(new Error('Failed to create a 2D canvas context for the terrain tile.'));
                                return;
                            }

                            // Instantaneous Blit/Crop: Sub-sections of the single pre-cached image are drawn directly
                            ctx.drawImage(
                                tileImage,
                                svgX, svgY, chunkWidth, chunkHeight, // Bounding source box (Crop area on SVG)
                                0, 0, tileSize, tileSize             // Target destination box (Fills the 256x256 tile)
                            );

                            resolve(canvas);
                        });
                    },
                });

                newLayers.push(new TileLayer({
                    properties: {title: loadedLayer.name},
                    source: svgTileSource,
                    // A phone-sized viewport only needs a few tiles per layer. The
                    // default (512) keeps hundreds of MiB of canvases per layer alive.
                    cacheSize: TERRAIN_TILE_CACHE_SIZE,
                }));
            }
        } catch (error) {
            newLayers.forEach((layer) => {
                const source = layer.getSource();
                layer.setSource(null);
                source?.dispose();
                layer.dispose();
            });
            throw error;
        }

        // 5. Replace any previous terrain layers so repeated loads cannot stack duplicates.
        this.disposeTerrainLayers();

        newLayers.forEach((layer) => {
            map.addLayer(layer);
        });
        this.terrainLayers = newLayers;

        // 6. The view constraints depend on the real terrain size, so they can only
        // be built now. Views have no setExtent(), hence the replacement view.
        const previousView = this.terrainViewReady ? map.getView() : null;
        const { view, preserved } = this.createTerrainView(projection, extent, previousView);
        map.setView(view);
        this.terrainViewReady = true;

        // Keep the user's position on a reload; on the first load (or if the old
        // position no longer fits) show the whole map.
        if (!preserved) {
            view.fit(extent, {
                duration: 1000            // Optional: Smoothly animate the zoom/pan over 1 second
            });
        }

        // A flyTo() that arrived before the terrain view existed must win over the
        // initial fit, so it is applied last.
        if (this.pendingFlyTo) {
            this.applyPendingFlyTo();
        }
    }

    private pendingFlyTo: MapFlyToOptions | null = null;

    /**
     * Apply a pending fly-to request from before the terrain was ready.
     */
    private applyPendingFlyTo(): void {
        const pending = this.pendingFlyTo;
        if (!pending) {
            return;
        }

        this.pendingFlyTo = null;

        const view = this.map?.getView();
        if (!view) {
            console.warn('MapApi: applyPendingFlyTo() called but the map is not ready');
            return;
        }

        const projection = view.getProjection();

        // Validate x/y are finite numbers
        if (
            typeof pending.x !== 'number' ||
            typeof pending.y !== 'number' ||
            !Number.isFinite(pending.x) ||
            !Number.isFinite(pending.y)
        ) {
            console.warn('MapApi: pending fly-to has invalid x/y');
            return;
        }

        const center = [pending.x, pending.y];

        // Clamp the center to the current view projection extent when one exists
        const extent = projection.getExtent();
        if (extent) {
            center[0] = Math.max(extent[0], Math.min(pending.x, extent[2]));
            center[1] = Math.max(extent[1], Math.min(pending.y, extent[3]));
        }

        // Only apply resolution when it is a finite positive number
        const resolution = pending.resolution !== undefined && Number.isFinite(pending.resolution) && pending.resolution > 0 ? pending.resolution : undefined;

        if (pending.animate !== false) {
            const animation: { center: number[]; resolution?: number; duration: number } = { center, duration: 300 };
            if (resolution !== undefined)
                animation.resolution = resolution;
            view.animate(animation);
        } else {
            view.setCenter(center);
            if (resolution !== undefined) {
                view.setResolution(resolution);
            }
        }
    }

    render() {
        const markerMenu = this.state.markerMenu;
        const markerDialog = this.state.markerDialog;

        return (
            // `overflow: hidden` keeps the OpenLayers canvas rounding from
            // making the flexlayout tab scrollable by a pixel or two, which
            // would let Chrome claim touch drags as pans (pointercancel).
            <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>

                <div ref={this.mapRef} className={`${styles.map}`} style={{width: "100%", height: "100%"}}/>

                <LayerSwitcher
                    map={this.map}
                    isOpen={this.state.layerSwitcherIsOpen}
                    onToggle={this.toggleLayerSwitcherMenu}
                    onClose={this.closeLayerSwitcherMenu}
                />

                <PolylineDrawControls
                    isActive={this.state.polylineDraw.isActive}
                    vertexCount={this.state.polylineDraw.vertexCount}
                    colors={this.markerManager?.getMarkerColors() ?? []}
                    selectedColor={this.state.polylineDraw.color}
                    clickPerPoint={this.state.polylineDraw.clickPerPoint}
                    onToggle={this.togglePolylineDrawing}
                    onSelectColor={this.handlePolylineColorSelect}
                    onClickPerPointChange={this.handlePolylineClickPerPointChange}
                    onUndo={this.handlePolylineUndo}
                    onCancel={this.stopPolylineDrawing}
                    onFinish={this.handlePolylineFinish}
                />

                {this.state.terrainError && (
                    <div
                        role="alert"
                        style={{
                            position: 'absolute',
                            top: 15,
                            left: 15,
                            zIndex: 1000,
                            maxWidth: 'calc(100% - 30px)',
                            padding: '8px 12px',
                            border: '1px solid #fca5a5',
                            borderRadius: 4,
                            background: '#fee2e2',
                            color: '#991b1b',
                            fontSize: 13,
                        }}
                    >
                        Failed to load map terrain: {this.state.terrainError}
                    </div>
                )}

                {markerDialog.isOpen && markerDialog.coordinate !== null && (
                    <MarkerCreateDialog
                        key={markerDialog.mode === 'edit' ? `edit:${markerDialog.markerName}` : 'create'}
                        coordinate={markerDialog.coordinate}
                        markerTypes={markerDialog.markerTypes}
                        markerColors={markerDialog.markerColors}
                        loadMarkerIcon={this.loadMarkerIcon}
                        initialLabel={markerDialog.initialLabel}
                        initialType={markerDialog.initialType}
                        initialColor={markerDialog.initialColor}
                        title={markerDialog.mode === 'edit' ? 'Edit Marker' : 'Add Marker'}
                        submitLabel={markerDialog.mode === 'edit' ? 'Save' : 'Create'}
                        onSubmit={this.handleMarkerDialogSubmit}
                        onCancel={this.closeMarkerDialog}
                    />
                )}

                {markerMenu !== null && (
                    <MarkerContextMenu
                        x={markerMenu.x}
                        y={markerMenu.y}
                        onEdit={() => this.handleEditMarkerFromMenu(markerMenu.name)}
                        onDelete={() => this.handleDeleteMarkerFromMenu(markerMenu.name)}
                        onClose={this.closeMarkerMenu}
                    />
                )}
            </div>
        );
    }
}

export default App
