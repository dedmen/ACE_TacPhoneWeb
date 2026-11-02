/**
 * Marker module for an existing OpenLayers map.
 *
 * Owns the marker layers, polyline drawing preview, measurement overlays and
 * all map pointer/keyboard interactions for markers and polylines. Map.tsx only
 * creates this module and renders the React UI around it, so a map can be
 * created without markers by simply not instantiating this module.
 */

import type OlMap from 'ol/Map';
import type MapBrowserEvent from 'ol/MapBrowserEvent';
import type { FeatureLike } from 'ol/Feature';
import DragPan from 'ol/interaction/DragPan';

import {
    isEditableMarkerName,
    MarkerLayerManager,
    type MarkerChatData,
    type MarkerColor,
    type MarkerPreviewDraft,
    type MarkerProperties,
    type MarkerType,
} from './MarkerLayer';
import { PolylineDrawing, simplifyPolyline } from './PolylineDrawing';
import { createMarker, createPolylineMarker, type MarkerCreationData } from './MarkerApi';
import { normalizeDirectionForGame, type MarkerChannel } from './Channels';
import { resolveTerrainHeights } from './TerrainHeightApi';
import { markerColorToCss, parseMarkerColor } from './MarkerColorUtils';
import type { MapBoundingBox, MapFlyToOptions, MapFocusMarkerOptions } from '../api';
import {
    registerMapTestManager,
    unregisterMapTestManager,
    type MapDebugState,
} from './MapTestHooks';
import { t } from '../i18n';

const LONG_PRESS_DURATION_MS = 600;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const MARKER_MOVE_HOLD_MS = 100;
const POLYLINE_FREEHAND_MIN_DISTANCE_M = 5;
const POLYLINE_SIMPLIFY_TOLERANCE_M = 2;
/** Pointer distance in pixels that grabs an existing polyline vertex. */
const POLYLINE_VERTEX_HIT_RADIUS_PX = 12;
/** World-space box used when focusing a marker without an explicit bbox. */
const MARKER_FOCUS_SIZE_METERS = 800;
/** Screen-space glow size around a focused icon marker. */
const MARKER_HIGHLIGHT_SIZE_PX = 48;

/** Kept at module scope so the choice survives Map panel remounts. */
let polylineClickPerPointMode = false;

export interface PolylineUiState {
    isActive: boolean;
    /** CfgMarkerColors class name; '' until colors load. */
    color: string;
    vertexCount: number;
    clickPerPoint: boolean;
    /** True while the vertices of an existing polyline are being edited. */
    isEditing: boolean;
    /** Name of the polyline being edited, or '' when not editing. */
    editingName: string;
}

export interface MarkerModuleCallbacks {
    /** True while the React marker dialog is open. */
    isDialogOpen(): boolean;
    /**
     * False for a read-only map (GPS): markers are drawn, but no create/edit/
     * drag interactions run. Missing means interactive.
     */
    isInteractive?(): boolean;
    onOpenCreateDialog(coordinate: [number, number]): void;
    onOpenEditDialog(name: string): void;
    onOpenMarkerMenu(name: string, clientX: number, clientY: number): void;
    onCloseMarkerMenu(): void;
    onPolylineStateChange(state: PolylineUiState): void;
    /** Normal Map flyTo, used by focusMarker(). */
    flyTo(options: MapFlyToOptions): void;
}

interface MarkerHoldState {
    name: string;
    pointerId: number;
    x: number;
    y: number;
    pointerType: string;
}

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

/** Local state of a polyline edit session (existing vertices only). */
interface PolylineEditState {
    name: string;
    /** Points before the edit, restored when the save fails. */
    original: [number, number][];
    /** True when the polyline carries the measurements tag. */
    clickPerPoint: boolean;
    /** Vertex currently dragged, if any. */
    drag: { pointerId: number; index: number } | null;
    /** True while the save request is in flight. */
    saving: boolean;
}

function hasMovedBeyondTolerance(x: number, y: number, event: PointerEvent): boolean {
    const dx = event.clientX - x;
    const dy = event.clientY - y;
    return dx * dx + dy * dy > LONG_PRESS_MOVE_TOLERANCE_PX * LONG_PRESS_MOVE_TOLERANCE_PX;
}

function isEditableElement(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    if (target.isContentEditable) {
        return true;
    }

    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

export class MarkerModule {
    public readonly manager: MarkerLayerManager;

    private readonly map: OlMap;
    private readonly callbacks: MarkerModuleCallbacks;
    private readonly polylineDrawing: PolylineDrawing;
    private readonly drawingDragPan: DragPan;

    private polylineState: PolylineUiState = {
        isActive: false,
        color: '',
        vertexCount: 0,
        clickPerPoint: polylineClickPerPointMode,
        isEditing: false,
        editingName: '',
    };

    /** Set while the vertices of an existing polyline are being moved. */
    private polylineEdit: PolylineEditState | null = null;

    private longPressTimer: number | null = null;
    private longPressStart: { x: number; y: number; pointerId: number; coordinate: [number, number] } | null = null;

    private hoveredMarkerName: string | null = null;
    private markerHoldTimer: number | null = null;
    private markerHoldStart: MarkerHoldState | null = null;
    private markerMenuTimer: number | null = null;
    private markerMoveState: MarkerMoveState | null = null;
    private markerPointerCapture: { viewport: HTMLElement; pointerId: number } | null = null;

    private polylineTapStart: { pointerId: number; x: number; y: number } | null = null;
    private polylineStrokePointerId: number | null = null;
    private freehandTouchCapture = false;
    private destroyed = false;

    constructor(map: OlMap, callbacks: MarkerModuleCallbacks) {
        this.map = map;
        this.callbacks = callbacks;

        this.manager = new MarkerLayerManager(map);
        this.polylineDrawing = new PolylineDrawing();
        this.polylineDrawing.layer.setZIndex(4);
        this.map.addLayer(this.polylineDrawing.layer);

        this.drawingDragPan = new DragPan({ condition: this.isDrawingPanEvent });
        this.map.addInteraction(this.drawingDragPan);

        this.map.on('dblclick', this.handleMapDoubleClick);

        const viewport = this.map.getViewport();
        // Capture phase: a vertex press must not start a map drag-pan, so it is
        // swallowed before OpenLayers sees the pointerdown.
        viewport.addEventListener('pointerdown', this.handleVertexPointerDownCapture, true);
        viewport.addEventListener('pointerdown', this.handleMapPointerDown);
        viewport.addEventListener('pointermove', this.handleMapPointerMove);
        viewport.addEventListener('pointerup', this.handleMapPointerUp);
        viewport.addEventListener('pointercancel', this.handleMapPointerUp);
        viewport.addEventListener('pointerleave', this.handleViewportPointerLeave);
        viewport.addEventListener('contextmenu', this.handleViewportContextMenu);
        viewport.addEventListener('touchmove', this.handleViewportTouchMove, { passive: false });

        window.addEventListener('keydown', this.handleWindowKeyDown);

        // Browser tests read the live channel/alpha state through this hook.
        registerMapTestManager(this);
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;

        unregisterMapTestManager(this);

        this.cancelLongPress();
        this.cancelMarkerHold();
        this.clearMarkerMenuTimer();
        this.polylineTapStart = null;
        this.polylineStrokePointerId = null;
        this.cancelPolylineEdit();

        if (this.markerMoveState) {
            this.manager.endMarkerMove(this.markerMoveState.name);
            this.markerMoveState = null;
        }
        this.releaseMarkerPointerCapture();

        // Restore map interactions in case the module is detached from a map
        // that keeps running.
        this.setDragPanActive(true);
        this.setFreehandTouchCapture(false);
        this.resetMapCursor();

        this.map.un('dblclick', this.handleMapDoubleClick);

        const viewport = this.map.getViewport();
        viewport.removeEventListener('pointerdown', this.handleVertexPointerDownCapture, true);
        viewport.removeEventListener('pointerdown', this.handleMapPointerDown);
        viewport.removeEventListener('pointermove', this.handleMapPointerMove);
        viewport.removeEventListener('pointerup', this.handleMapPointerUp);
        viewport.removeEventListener('pointercancel', this.handleMapPointerUp);
        viewport.removeEventListener('pointerleave', this.handleViewportPointerLeave);
        viewport.removeEventListener('contextmenu', this.handleViewportContextMenu);
        viewport.removeEventListener('touchmove', this.handleViewportTouchMove);
        window.removeEventListener('keydown', this.handleWindowKeyDown);

        this.map.removeInteraction(this.drawingDragPan);
        this.polylineDrawing.destroy();
        this.map.removeLayer(this.polylineDrawing.layer);
        this.manager.destroy();
    }

    // ---------------------------------------------------------------------
    // Public marker/manager surface used by Map.tsx
    // ---------------------------------------------------------------------

    public whenChannelsLoaded(): Promise<void> {
        return this.manager.whenChannelsLoaded();
    }

    public whenMarkerConfigLoaded(): Promise<void> {
        return this.manager.whenMarkerConfigLoaded();
    }

    public getEffectiveChannelForRequest(channel: unknown): number {
        return this.manager.getEffectiveChannelForRequest(channel);
    }

    public isMultiplayer(): boolean {
        return this.manager.isMultiplayer();
    }

    public getActiveChannel(): number {
        return this.manager.getActiveChannel();
    }

    public setActiveChannel(channel: number): void {
        this.manager.setActiveChannel(channel);
    }

    public getAvailableChannels(): MarkerChannel[] {
        return this.manager.getAvailableChannels();
    }

    public getChannelLabel(channel: number): string {
        return this.manager.getChannelLabel(channel);
    }

    public getMarkerTypes(): MarkerType[] {
        return this.manager.getMarkerTypes();
    }

    public getMarkerColors(): MarkerColor[] {
        return this.manager.getMarkerColors();
    }

    /**
     * Colors the polyline UI offers. The game's `Default` CfgMarkerColors class
     * is the same black as `Black`, so it is hidden here; polylines use a real
     * color class and the marker dialog owns the virtual "type default" entry.
     */
    public getPolylineColors(): MarkerColor[] {
        return this.manager.getMarkerColors().filter((color) => color.className !== 'Default');
    }

    /** Remembered polyline color, or the first real color (Black) as fallback. */
    private resolvePolylineColor(): string {
        const colors = this.getPolylineColors();
        const remembered = this.polylineState.color;

        if (
            remembered !== ''
            && remembered !== 'Default'
            && (parseMarkerColor(remembered) !== undefined
                || colors.some((color) => color.className === remembered))
        ) {
            return remembered;
        }

        return colors[0]?.className ?? 'Default';
    }

    public loadMarkerIcon(iconPath: string): Promise<string> {
        return this.manager.loadMarkerIcon(iconPath);
    }

    public getMarkerData(name: string): MarkerProperties | null {
        return this.manager.getMarkerData(name);
    }

    public getMarkerChatData(name: string): MarkerChatData | null {
        return this.manager.getMarkerChatData(name);
    }

    public hasMarker(name: string): boolean {
        return this.manager.hasMarker(name);
    }

    public whenMarkersLoaded(): Promise<void> {
        return this.manager.whenMarkersLoaded();
    }

    public async focusMarker(name: string, options?: MapFocusMarkerOptions): Promise<boolean> {
        await this.manager.whenMarkersLoaded();
        if (this.destroyed) {
            return false;
        }

        const half = MARKER_FOCUS_SIZE_METERS / 2;
        const focusBox = (position: [number, number]): MapBoundingBox => options?.bbox
            ?? [
                position[0] - half,
                position[1] - half,
                position[0] + half,
                position[1] + half,
            ];

        const focused = await this.manager.focusMarker(name, (position, geometryBbox) => {
            const fitBbox: MapBoundingBox = options?.bbox
                ?? geometryBbox
                ?? focusBox(position);
            const wantsSmallHighlight = options?.bbox === undefined && geometryBbox === undefined;

            this.callbacks.flyTo({
                x: position[0],
                y: position[1],
                bbox: fitBbox,
                animate: true,
                highlight: options?.highlight,
                highlightSizePx: wantsSmallHighlight ? MARKER_HIGHLIGHT_SIZE_PX : undefined,
            });
        });

        if (focused) {
            return true;
        }

        // A shared object can outlive its marker. The provider (this app) owns
        // the fallback; Messenger does not know anything about map markers.
        const fallback = options?.fallbackPosition;
        if (
            !Array.isArray(fallback)
            || fallback.length < 2
            || !Number.isFinite(fallback[0])
            || !Number.isFinite(fallback[1])
        ) {
            return false;
        }

        const position: [number, number] = [fallback[0], fallback[1]];
        this.callbacks.flyTo({
            x: position[0],
            y: position[1],
            bbox: focusBox(position),
            animate: true,
            highlight: options?.highlight,
            highlightSizePx: MARKER_HIGHLIGHT_SIZE_PX,
        });

        try {
            window.TacPhone.notifications.show({
                title: t('STR_ACE_Tacphone_Map_Marker_GoneTitle'),
                body: t('STR_ACE_Tacphone_Map_Marker_GoneBody'),
                app: 'ACE_TacPhone_Map',
            });
        } catch (error) {
            console.warn('Could not show the deleted-marker notification', error);
        }

        return true;
    }

    public deleteMarker(name: string): void {
        this.manager.deleteMarker(name);
        if (this.hoveredMarkerName === name) {
            this.hoveredMarkerName = null;
            this.resetMapCursor();
        }
    }

    public updateMarkerProperties(
        name: string,
        changes: {
            label?: string;
            type?: string;
            color?: string;
            dir?: number;
            size?: number | [number, number];
            channel?: number;
        },
    ): void {
        this.manager.updateMarkerProperties(name, {
            ...changes,
            dir: changes.dir !== undefined ? normalizeDirectionForGame(changes.dir) : undefined,
        });
    }

    public createMarker(marker: MarkerCreationData): void {
        const channel = this.manager.getEffectiveChannelForRequest(marker.channel);
        createMarker({
            ...marker,
            dir: normalizeDirectionForGame(marker.dir ?? 0),
            channel,
        }).catch((error: unknown) => {
            console.error('Failed to create marker', error);
        });
    }

    public showMarkerPreview(draft: MarkerPreviewDraft): void {
        this.manager.showMarkerPreview(draft);
    }

    public updateMarkerPreview(draft: MarkerPreviewDraft): void {
        this.manager.updateMarkerPreview(draft);
    }

    public hideMarkerPreview(): void {
        this.manager.hideMarkerPreview();
    }

    // ---------------------------------------------------------------------
    // Polyline public surface
    // ---------------------------------------------------------------------

    public getPolylineState(): PolylineUiState {
        return { ...this.polylineState };
    }

    /**
     * What the context menu should offer for a marker: the point dialog, the
     * polyline vertex editor, or nothing for read-only markers.
     */
    public getMarkerEditTarget(name: string): 'point' | 'polyline' | null {
        if (!isEditableMarkerName(name)) {
            return null;
        }

        if (this.manager.getMarkerData(name)) {
            return 'point';
        }

        return this.manager.getPolylineData(name) ? 'polyline' : null;
    }

    /** Debug-only: a marker's vertices in viewport pixels. */
    public getMarkerPixels(name: string): [number, number][] | null {
        const coordinates = this.manager.getMarkerCoordinates(name);
        if (!coordinates) {
            return null;
        }

        const pixels: [number, number][] = [];
        for (const coordinate of coordinates) {
            const pixel = this.map.getPixelFromCoordinate(coordinate);
            if (pixel) {
                pixels.push([pixel[0], pixel[1]]);
            }
        }

        return pixels.length > 0 ? pixels : null;
    }

    /** Debug-only live state for the browser tests. */
    public getMapDebugState(): MapDebugState {
        const previewColors = this.polylineDrawing.getDebugColors();

        return {
            ...this.manager.getDebugSnapshot(),
            polyline: {
                ...this.getPolylineState(),
                previewLineColor: previewColors.line,
                previewHaloColor: previewColors.halo,
                points: this.polylineEdit ? this.polylineDrawing.getFlatPolyline() : [],
            },
        };
    }

    public togglePolyline(): void {
        // The pencil button leaves edit mode instead of starting a new line.
        if (this.polylineEdit) {
            this.cancelPolylineEdit();
            return;
        }

        if (this.polylineState.isActive) {
            this.stopPolyline();
            return;
        }

        const color = this.resolvePolylineColor();

        this.polylineDrawing.clear();
        this.polylineDrawing.setColor(this.getDrawingColorCss(color));
        this.polylineDrawing.setMeasurementsEnabled(polylineClickPerPointMode);
        this.polylineTapStart = null;
        this.polylineStrokePointerId = null;

        this.cancelMarkerHold();
        this.cancelLongPress();
        this.clearMarkerMenuTimer();
        this.hoveredMarkerName = null;

        if (this.markerMoveState) {
            this.manager.endMarkerMove(this.markerMoveState.name);
            this.markerMoveState = null;
            this.releaseMarkerPointerCapture();
        }

        this.setDragPanActive(polylineClickPerPointMode);
        this.setFreehandTouchCapture(!polylineClickPerPointMode);
        this.setMapCursor('crosshair');

        this.setPolylineState({
            isActive: true,
            color,
            vertexCount: 0,
            clickPerPoint: polylineClickPerPointMode,
        });

        if (this.getPolylineColors().length === 0) {
            this.loadDrawingColorsIfNeeded();
        }
    }

    public stopPolyline(): void {
        this.polylineTapStart = null;
        this.polylineStrokePointerId = null;
        this.polylineDrawing.setMeasurementsEnabled(false);
        this.polylineDrawing.clear();
        this.setPolylineState({
            isActive: false,
            vertexCount: 0,
            isEditing: false,
            editingName: '',
        });
        this.setDragPanActive(true);
        this.setFreehandTouchCapture(false);
        this.resetMapCursor();
    }

    // ---------------------------------------------------------------------
    // Polyline edit mode
    // ---------------------------------------------------------------------

    /**
     * Loads an existing player polyline into the drawing preview and lets the
     * user drag its vertices. Only `_USER_DEFINED` polylines can be edited.
     */
    public beginPolylineEdit(name: string): boolean {
        if (this.destroyed || !isEditableMarkerName(name)) {
            return false;
        }

        const data = this.manager.getPolylineData(name);
        if (!data || data.points.length < 2) {
            return false;
        }

        if (this.polylineState.isActive) {
            this.stopPolyline();
        }

        this.cancelMarkerHold();
        this.cancelLongPress();
        this.clearMarkerMenuTimer();
        this.hoveredMarkerName = null;

        if (this.markerMoveState) {
            this.manager.endMarkerMove(this.markerMoveState.name);
            this.markerMoveState = null;
            this.releaseMarkerPointerCapture();
        }

        this.polylineEdit = {
            name,
            original: data.points.map(([x, y]): [number, number] => [x, y]),
            clickPerPoint: data.measurements,
            drag: null,
            saving: false,
        };

        this.manager.setEditingPolyline(name);

        this.polylineTapStart = null;
        this.polylineStrokePointerId = null;
        this.polylineDrawing.clear();
        this.polylineDrawing.setColor(this.getDrawingColorCss(data.color));
        this.polylineDrawing.setMeasurementsEnabled(data.measurements);
        this.polylineDrawing.setPoints(data.points);
        this.polylineDrawing.setEditing(true);

        // Touch drags must not scroll the page while a vertex is moved.
        this.setFreehandTouchCapture(true);
        this.setDragPanActive(true);
        this.setMapCursor('');

        this.setPolylineState({
            isActive: true,
            isEditing: true,
            editingName: name,
            color: data.color,
            vertexCount: data.points.length,
            clickPerPoint: data.measurements,
        });

        return true;
    }

    /**
     * Sends the moved vertices to the game. On failure the original points are
     * restored locally and the user is notified.
     */
    public savePolylineEdit(): void {
        const edit = this.polylineEdit;
        if (!edit || this.destroyed || edit.saving || edit.drag) {
            return;
        }

        const points = this.polylineDrawing.getPoints();
        if (points.length < 2) {
            return;
        }

        const original = edit.original.map(([x, y]): [number, number] => [x, y]);
        const name = edit.name;

        // Keep the upsert guard (and the panel) until the game confirmed the
        // new geometry, so a late update with the old points cannot snap the
        // polyline back while the request is in flight.
        edit.saving = true;

        const finish = (): void => {
            if (this.polylineEdit === edit) {
                this.finishPolylineEdit();
            }
        };

        void this.manager.updatePolylineData(name, points).then(finish, (error: unknown) => {
            console.error('Failed to save the edited polyline', error);
            this.manager.applyPolylineGeometry(name, original);
            finish();
            this.showPolylineSaveFailed();
        });
    }

    /** Drops the edit session; the polyline keeps its stored geometry. */
    public cancelPolylineEdit(): void {
        if (!this.polylineEdit) {
            return;
        }

        this.finishPolylineEdit();
    }

    /** Shared teardown of an edit session, without touching the game. */
    private finishPolylineEdit(): void {
        const edit = this.polylineEdit;
        if (!edit) {
            return;
        }

        this.releaseMarkerPointerCapture();
        this.polylineEdit = null;
        this.manager.setEditingPolyline(null);

        this.polylineDrawing.setEditing(false);
        this.polylineDrawing.setMeasurementsEnabled(false);
        this.polylineDrawing.clear();

        this.setPolylineState({
            isActive: false,
            isEditing: false,
            editingName: '',
            vertexCount: 0,
        });
        this.setDragPanActive(true);
        this.setFreehandTouchCapture(false);
        this.resetMapCursor();
    }

    private showPolylineSaveFailed(): void {
        try {
            window.TacPhone.notifications.show({
                title: t('str_3den_display3den_menubar_missionsave_textFailed'),
                app: 'ACE_TacPhone_Map',
                sound: 'alert',
            });
        } catch (error) {
            console.warn('Could not show the polyline save-failure notification', error);
        }
    }

    public setPolylineColor(colorClassName: string): void {
        this.setPolylineState({ color: colorClassName });
        this.polylineDrawing.setColor(this.getDrawingColorCss(colorClassName));
    }

    public setPolylineClickPerPoint(clickPerPoint: boolean): void {
        polylineClickPerPointMode = clickPerPoint;

        this.finishPolylineStroke();
        this.polylineTapStart = null;

        this.setPolylineState({ clickPerPoint });
        this.polylineDrawing.setMeasurementsEnabled(clickPerPoint);

        if (clickPerPoint) {
            this.backfillPolylineHeights();
        }

        this.setDragPanActive(clickPerPoint);
        this.setFreehandTouchCapture(!clickPerPoint);
    }

    public undoPolyline(): void {
        this.finishPolylineStroke();
        this.polylineDrawing.undoLastPoint();
        this.syncPolylineVertexCount();
    }

    public finishPolyline(): void {
        this.finishPolylineStroke();

        const flat = this.polylineDrawing.getFlatPolyline();
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

        // 'Default' is the game's CfgMarkerColors fallback when no color is known.
        const color = this.resolvePolylineColor() || 'Default';
        const measurements = this.polylineState.clickPerPoint;
        const channel = this.manager.getEffectiveChannelForRequest(this.manager.getActiveChannel());

        try {
            createPolylineMarker(points, color, channel, measurements).catch((error: unknown) => {
                console.error('Failed to create polyline marker', error);
            });
        } catch (error) {
            console.error('Failed to create polyline marker', error);
        }

        this.polylineDrawing.clear();
        this.polylineTapStart = null;
        this.setPolylineState({ vertexCount: 0 });
    }

    public getDrawingColorCss(colorClassName: string): string {
        const custom = markerColorToCss(colorClassName);
        if (custom) {
            return custom;
        }

        const match = this.manager.getMarkerColors().find((color) => color.className === colorClassName);
        return match?.color ?? '#ffffff';
    }

    // ---------------------------------------------------------------------
    // Polyline internals
    // ---------------------------------------------------------------------

    private setPolylineState(changes: Partial<PolylineUiState>): void {
        this.polylineState = { ...this.polylineState, ...changes };
        this.callbacks.onPolylineStateChange(this.getPolylineState());
    }

    private loadDrawingColorsIfNeeded(): void {
        void this.manager.whenMarkerConfigLoaded().then(() => {
            if (this.destroyed || !this.polylineState.isActive) {
                return;
            }

            const color = this.resolvePolylineColor();
            this.setPolylineState({ color });
            this.polylineDrawing.setColor(this.getDrawingColorCss(color));
        });
    }

    private syncPolylineVertexCount(): void {
        this.setPolylineState({ vertexCount: this.polylineDrawing.getPointCount() });
    }

    private requestPolylineHeights(indices: readonly number[]): void {
        if (indices.length === 0) {
            return;
        }

        const positions: Array<[number, number]> = [];
        const requested: Array<{ index: number; point: [number, number] }> = [];

        for (const index of indices) {
            const point = this.polylineDrawing.getPoint(index);
            if (!point) {
                continue;
            }

            positions.push(point);
            requested.push({ index, point });
        }

        if (positions.length === 0) {
            return;
        }

        void resolveTerrainHeights(positions)
            .then((heights) => {
                for (let i = 0; i < requested.length; i++) {
                    const { index, point } = requested[i];
                    const height = heights[i];
                    if (height === null) {
                        continue;
                    }

                    const current = this.polylineDrawing.getPoint(index);
                    if (current && current[0] === point[0] && current[1] === point[1]) {
                        this.polylineDrawing.setPointHeight(index, height);
                    }
                }
            })
            .catch((error: unknown) => {
                console.warn('Failed to fetch terrain heights', error);
            });
    }

    private backfillPolylineHeights(): void {
        const count = this.polylineDrawing.getPointCount();
        if (count === 0) {
            return;
        }

        const indices: number[] = [];
        for (let index = 0; index < count; index++) {
            indices.push(index);
        }

        this.requestPolylineHeights(indices);
    }

    private appendPolylineCoordinate(coordinate: [number, number], minDistance: number): void {
        if (minDistance > 0) {
            const flat = this.polylineDrawing.getFlatPolyline();
            if (flat.length >= 2) {
                const dx = coordinate[0] - flat[flat.length - 2];
                const dy = coordinate[1] - flat[flat.length - 1];
                if (dx * dx + dy * dy < minDistance * minDistance) {
                    return;
                }
            }
        }

        const nextIndex = this.polylineDrawing.getPointCount();
        this.polylineDrawing.addPoint(coordinate);

        if (this.polylineState.clickPerPoint && this.polylineDrawing.getPointCount() > nextIndex) {
            this.requestPolylineHeights([nextIndex]);
        }
    }

    private beginPolylineStroke(event: PointerEvent): void {
        if (this.polylineStrokePointerId !== null) {
            return;
        }

        const coordinate = this.map.getEventCoordinate(event);
        if (!coordinate) {
            return;
        }

        this.polylineStrokePointerId = event.pointerId;
        this.appendPolylineCoordinate(
            [coordinate[0], coordinate[1]],
            POLYLINE_FREEHAND_MIN_DISTANCE_M,
        );

        this.setDragPanActive(false);
        this.setMapCursor('crosshair');
    }

    private extendPolylineStroke(event: PointerEvent): void {
        if (this.polylineStrokePointerId === null || event.pointerId !== this.polylineStrokePointerId) {
            return;
        }

        const coordinate = this.map.getEventCoordinate(event);
        if (!coordinate) {
            return;
        }

        this.appendPolylineCoordinate(
            [coordinate[0], coordinate[1]],
            POLYLINE_FREEHAND_MIN_DISTANCE_M,
        );
    }

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

    private addPolylineVertex(event: PointerEvent): void {
        const coordinate = this.map.getEventCoordinate(event);
        if (!coordinate) {
            return;
        }

        const flat = this.polylineDrawing.getFlatPolyline();
        if (flat.length >= 2) {
            const lastPixel = this.map.getPixelFromCoordinate([
                flat[flat.length - 2],
                flat[flat.length - 1],
            ]);
            const pixel = this.map.getPixelFromCoordinate([coordinate[0], coordinate[1]]);

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

    // ---------------------------------------------------------------------
    // Marker interactions
    // ---------------------------------------------------------------------

    private handleMapDoubleClick = (event: MapBrowserEvent): void => {
        if (!this.isInteractive() || this.callbacks.isDialogOpen() || this.polylineState.isActive || this.polylineEdit) {
            return;
        }

        const originalEvent = event.originalEvent as PointerEvent;
        if (originalEvent.pointerType === 'touch') {
            return;
        }

        const markerName = this.getEditableMarkerNameAtEvent(originalEvent);
        if (markerName) {
            this.callbacks.onOpenEditDialog(markerName);
            return;
        }

        if (this.getMarkerNameAtEvent(originalEvent)) {
            return;
        }

        this.callbacks.onOpenCreateDialog([event.coordinate[0], event.coordinate[1]]);
    };

    private getMarkerFeatureAtEvent(event: PointerEvent | MouseEvent): FeatureLike | null {
        return this.map.forEachFeatureAtPixel(
            this.map.getEventPixel(event),
            (candidate) => candidate,
            {
                layerFilter: (layer) => this.manager.isMarkerLayer(layer),
                hitTolerance: 6,
            },
        ) ?? null;
    }

    private getMarkerNameAtEvent(event: PointerEvent | MouseEvent): string | null {
        const feature = this.getMarkerFeatureAtEvent(event);
        return feature ? this.manager.getMarkerName(feature) : null;
    }

    private getEditableMarkerNameAtEvent(event: PointerEvent | MouseEvent): string | null {
        const feature = this.getMarkerFeatureAtEvent(event);
        return feature ? this.manager.getEditableMarkerName(feature) : null;
    }

    /** Player marker name (point or polyline) under the pointer, for the menu. */
    private getContextMarkerNameAtEvent(event: PointerEvent | MouseEvent): string | null {
        const name = this.getMarkerNameAtEvent(event);
        return isEditableMarkerName(name) ? name : null;
    }

    /** Read-only maps (GPS) draw markers but accept no marker interaction. */
    private isInteractive(): boolean {
        return this.callbacks.isInteractive?.() !== false;
    }

    private setDragPanActive(active: boolean): void {
        this.map.getInteractions().forEach((interaction) => {
            if (interaction instanceof DragPan && interaction !== this.drawingDragPan) {
                interaction.setActive(active);
            }
        });
    }

    private isDrawingPanEvent = (event: MapBrowserEvent): boolean => {
        if (!this.polylineState.isActive) {
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

    private setFreehandTouchCapture(active: boolean): void {
        this.freehandTouchCapture = active;
        this.map.getViewport().style.touchAction = active ? 'none' : '';
    }

    private handleViewportTouchMove = (event: TouchEvent): void => {
        if (!this.freehandTouchCapture) {
            return;
        }

        if (event.cancelable) {
            event.preventDefault();
        }
    };

    private setMapCursor(cursor: string): void {
        this.map.getViewport().style.cursor = cursor;
    }

    private resetMapCursor(): void {
        this.setMapCursor('');
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
        if (this.polylineState.isActive) {
            this.finishPolylineStroke();
            this.polylineTapStart = null;
            return;
        }

        this.hoveredMarkerName = null;
        this.polylineTapStart = null;
        this.cancelMarkerHold();

        if (!this.markerMoveState) {
            this.resetMapCursor();
        }
    };

    private handleViewportContextMenu = (event: MouseEvent): void => {
        if (!this.isInteractive()) {
            return;
        }

        if (this.polylineState.isActive) {
            event.preventDefault();
            return;
        }

        if (this.polylineEdit) {
            event.preventDefault();
            return;
        }

        if (this.markerMoveState || this.markerHoldStart) {
            event.preventDefault();
            return;
        }

        const markerName = this.getContextMarkerNameAtEvent(event);
        if (markerName) {
            event.preventDefault();
            this.callbacks.onOpenMarkerMenu(markerName, event.clientX, event.clientY);
        }
    };

    private handleWindowKeyDown = (event: KeyboardEvent): void => {
        if (!this.isInteractive() || this.callbacks.isDialogOpen()) {
            return;
        }

        if (event.key === 'Escape' && this.polylineEdit) {
            if (isEditableElement(event.target) || isEditableElement(document.activeElement)) {
                return;
            }

            event.preventDefault();
            this.cancelPolylineEdit();
            return;
        }

        if (event.key === 'Escape' && this.polylineState.isActive) {
            if (isEditableElement(event.target) || isEditableElement(document.activeElement)) {
                return;
            }

            event.preventDefault();
            this.stopPolyline();
            return;
        }

        if (event.key !== 'Delete' || this.polylineState.isActive || this.polylineEdit) {
            return;
        }

        const name = this.hoveredMarkerName;
        if (!name) {
            return;
        }

        if (isEditableElement(event.target) || isEditableElement(document.activeElement)) {
            return;
        }

        event.preventDefault();
        this.manager.deleteMarker(name);
        this.hoveredMarkerName = null;
        this.resetMapCursor();
        this.callbacks.onCloseMarkerMenu();
    };

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
        if (!this.manager.beginMarkerMove(hold.name)) {
            return;
        }

        this.callbacks.onCloseMarkerMenu();

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

        this.setDragPanActive(false);
        this.setMapCursor('grabbing');

        if (hold.pointerType !== 'mouse') {
            this.clearMarkerMenuTimer();
            this.markerMenuTimer = window.setTimeout(() => {
                this.markerMenuTimer = null;

                const move = this.markerMoveState;
                if (!move || move.moved || move.pointerId !== hold.pointerId) {
                    return;
                }

                this.manager.endMarkerMove(move.name);
                this.releaseMarkerPointerCapture();
                this.setDragPanActive(true);
                this.markerMoveState = null;
                this.resetMapCursor();
                this.callbacks.onOpenMarkerMenu(move.name, move.lastX, move.lastY);
            }, LONG_PRESS_DURATION_MS - MARKER_MOVE_HOLD_MS);
        }

        const viewport = this.map.getViewport();
        try {
            viewport.setPointerCapture(hold.pointerId);
            this.markerPointerCapture = { viewport, pointerId: hold.pointerId };
        } catch {
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
        if (!this.isInteractive() || !event.isPrimary || this.callbacks.isDialogOpen()) {
            return;
        }

        if (this.polylineEdit) {
            // Vertex drags are started in the capture listener, which keeps the
            // press away from the map interactions.
            return;
        }

        if (event.target instanceof Element && event.target.closest('.ol-overlaycontainer-stopevent')) {
            return;
        }

        if (this.polylineState.isActive) {
            if (event.pointerType === 'mouse' && event.button !== 0) {
                return;
            }

            this.cancelLongPress();

            if (this.polylineState.clickPerPoint) {
                this.polylineTapStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
            } else {
                this.beginPolylineStroke(event);
            }

            return;
        }

        if (event.pointerType === 'mouse') {
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

        const markerName = this.getEditableMarkerNameAtEvent(event);
        if (markerName) {
            this.startMarkerHold(markerName, event, MARKER_MOVE_HOLD_MS);
            return;
        }

        if (this.getMarkerNameAtEvent(event)) {
            return;
        }

        const coordinate = this.map.getEventCoordinate(event);
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
            this.callbacks.onOpenCreateDialog(start.coordinate);
        }, LONG_PRESS_DURATION_MS);
    };

    /**
     * Hit-tests the vertices of the polyline being edited and starts a drag on
     * one of them. Runs in the capture phase so OpenLayers never starts a
     * drag-pan for the same press.
     */
    private handleVertexPointerDownCapture = (event: PointerEvent): void => {
        const edit = this.polylineEdit;
        if (!edit || edit.saving || !event.isPrimary || this.callbacks.isDialogOpen() || !this.isInteractive()) {
            return;
        }

        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }

        if (isEditableElement(event.target)) {
            return;
        }

        const index = this.findPolylineVertexAt(event);
        if (index === null) {
            return;
        }

        event.stopPropagation();
        event.preventDefault();

        edit.drag = { pointerId: event.pointerId, index };
        this.setMapCursor('grabbing');

        const viewport = this.map.getViewport();
        try {
            viewport.setPointerCapture(event.pointerId);
            this.markerPointerCapture = { viewport, pointerId: event.pointerId };
        } catch {
            this.markerPointerCapture = null;
        }
    };

    /** Index of the polyline vertex within the hit radius, or null. */
    private findPolylineVertexAt(event: PointerEvent | MouseEvent): number | null {
        if (!this.polylineEdit) {
            return null;
        }

        const pixel = this.map.getEventPixel(event);
        const points = this.polylineDrawing.getPoints();
        const maxDistanceSquared = POLYLINE_VERTEX_HIT_RADIUS_PX * POLYLINE_VERTEX_HIT_RADIUS_PX;
        let bestIndex: number | null = null;
        let bestDistanceSquared = maxDistanceSquared;

        for (let index = 0; index < points.length; index++) {
            const vertexPixel = this.map.getPixelFromCoordinate(points[index]);
            if (!vertexPixel) {
                continue;
            }

            const dx = vertexPixel[0] - pixel[0];
            const dy = vertexPixel[1] - pixel[1];
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared <= bestDistanceSquared) {
                bestDistanceSquared = distanceSquared;
                bestIndex = index;
            }
        }

        return bestIndex;
    }

    private handleMapPointerMove = (event: PointerEvent): void => {
        if (!this.isInteractive()) {
            return;
        }

        const edit = this.polylineEdit;
        if (edit) {
            if (edit.drag) {
                if (event.pointerId !== edit.drag.pointerId) {
                    return;
                }

                event.preventDefault();
                const coordinate = this.map.getEventCoordinate(event);
                if (coordinate) {
                    // Only the grabbed vertex moves; the other points stay.
                    this.polylineDrawing.movePoint(edit.drag.index, [coordinate[0], coordinate[1]]);
                }

                this.setMapCursor('grabbing');
                return;
            }

            if (event.pointerType === 'mouse' && event.buttons === 0) {
                this.setMapCursor(this.findPolylineVertexAt(event) !== null ? 'grab' : '');
            }

            return;
        }

        if (this.polylineState.isActive) {
            if (event.pointerType === 'mouse' && event.buttons !== 0) {
                this.setMapCursor(event.buttons === 2 ? 'grabbing' : 'crosshair');
            }

            if (this.polylineState.clickPerPoint) {
                const start = this.polylineTapStart;
                if (start && hasMovedBeyondTolerance(start.x, start.y, event)) {
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

        if (event.pointerType === 'mouse' && event.buttons === 0) {
            this.updateMarkerHover(event);
        }

        const hold = this.markerHoldStart;
        if (hold && event.pointerId === hold.pointerId && hasMovedBeyondTolerance(hold.x, hold.y, event)) {
            this.cancelMarkerHold();
            return;
        }

        const start = this.longPressStart;
        if (!start || event.pointerId !== start.pointerId) {
            return;
        }

        if (hasMovedBeyondTolerance(start.x, start.y, event)) {
            this.cancelLongPress();
        }
    };

    private updateMarkerMove(event: PointerEvent, move: MarkerMoveState): void {
        if (!move.moved && !hasMovedBeyondTolerance(move.startX, move.startY, event)) {
            return;
        }

        move.moved = true;
        move.lastX = event.clientX;
        move.lastY = event.clientY;
        this.clearMarkerMenuTimer();
        event.preventDefault();

        const coordinate = this.map.getEventCoordinate(event);
        this.manager.moveMarker(move.name, [coordinate[0], coordinate[1]]);
    }

    private handleMapPointerUp = (event: PointerEvent): void => {
        if (!this.isInteractive()) {
            return;
        }

        const edit = this.polylineEdit;
        if (edit) {
            const drag = edit.drag;
            if (!drag || event.pointerId !== drag.pointerId) {
                return;
            }

            edit.drag = null;
            this.releaseMarkerPointerCapture();
            this.setMapCursor('');

            if (edit.clickPerPoint) {
                // Measurements need the terrain height of the moved vertex.
                this.requestPolylineHeights([drag.index]);
            }

            return;
        }

        if (this.polylineState.isActive) {
            if (event.pointerType === 'mouse' && event.button === 2) {
                this.setMapCursor('crosshair');
            }

            if (!this.polylineState.clickPerPoint) {
                this.finishPolylineStroke(event);
                return;
            }

            const start = this.polylineTapStart;
            if (!start || start.pointerId !== event.pointerId) {
                return;
            }

            this.polylineTapStart = null;

            if (event.type === 'pointercancel' || hasMovedBeyondTolerance(start.x, start.y, event)) {
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
        this.clearMarkerMenuTimer();
        const cancelled = event.type === 'pointercancel';
        const coordinate = cancelled ? null : (this.map.getEventCoordinate(event) ?? null);

        if (move.moved && coordinate) {
            this.manager.endMarkerMove(move.name, [coordinate[0], coordinate[1]]);
        } else {
            this.manager.endMarkerMove(move.name);
        }

        this.releaseMarkerPointerCapture();
        this.setDragPanActive(true);
        this.markerMoveState = null;

        if (this.hoveredMarkerName) {
            this.setMapCursor('grab');
        } else {
            this.resetMapCursor();
        }

        if (!cancelled && !move.moved && move.pointerType !== 'mouse') {
            this.callbacks.onOpenMarkerMenu(move.name, event.clientX, event.clientY);
        }
    }

    private cancelLongPress(): void {
        if (this.longPressTimer !== null) {
            window.clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }

        this.longPressStart = null;
    }
}
