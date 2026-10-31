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

const LONG_PRESS_DURATION_MS = 600;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const MARKER_MOVE_HOLD_MS = 100;
const POLYLINE_FREEHAND_MIN_DISTANCE_M = 5;
const POLYLINE_SIMPLIFY_TOLERANCE_M = 2;

/** Kept at module scope so the choice survives Map panel remounts. */
let polylineClickPerPointMode = false;

export interface PolylineUiState {
    isActive: boolean;
    /** CfgMarkerColors class name; '' until colors load. */
    color: string;
    vertexCount: number;
    clickPerPoint: boolean;
}

export interface MarkerModuleCallbacks {
    /** True while the React marker dialog is open. */
    isDialogOpen(): boolean;
    onOpenCreateDialog(coordinate: [number, number]): void;
    onOpenEditDialog(name: string): void;
    onOpenMarkerMenu(name: string, clientX: number, clientY: number): void;
    onCloseMarkerMenu(): void;
    onPolylineStateChange(state: PolylineUiState): void;
    /** Normal Map flyTo, used by focusMarker(). */
    flyTo(position: [number, number]): void;
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
    };

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
        viewport.addEventListener('pointerdown', this.handleMapPointerDown);
        viewport.addEventListener('pointermove', this.handleMapPointerMove);
        viewport.addEventListener('pointerup', this.handleMapPointerUp);
        viewport.addEventListener('pointercancel', this.handleMapPointerUp);
        viewport.addEventListener('pointerleave', this.handleViewportPointerLeave);
        viewport.addEventListener('contextmenu', this.handleViewportContextMenu);
        viewport.addEventListener('touchmove', this.handleViewportTouchMove, { passive: false });

        window.addEventListener('keydown', this.handleWindowKeyDown);
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;

        this.cancelLongPress();
        this.cancelMarkerHold();
        this.clearMarkerMenuTimer();
        this.polylineTapStart = null;
        this.polylineStrokePointerId = null;

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

    public async focusMarker(name: string): Promise<boolean> {
        await this.manager.whenMarkersLoaded();
        if (this.destroyed) {
            return false;
        }

        return this.manager.focusMarker(name, (position) => this.callbacks.flyTo(position));
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

    public togglePolyline(): void {
        if (this.polylineState.isActive) {
            this.stopPolyline();
            return;
        }

        const colors = this.manager.getMarkerColors();
        const color = this.polylineState.color || colors[0]?.className || '';

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

        if (colors.length === 0) {
            this.loadDrawingColorsIfNeeded();
        }
    }

    public stopPolyline(): void {
        this.polylineTapStart = null;
        this.polylineStrokePointerId = null;
        this.polylineDrawing.setMeasurementsEnabled(false);
        this.polylineDrawing.clear();
        this.setPolylineState({ isActive: false, vertexCount: 0 });
        this.setDragPanActive(true);
        this.setFreehandTouchCapture(false);
        this.resetMapCursor();
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

        // 'Default' is the game's CfgMarkerColors fallback.
        const color = this.polylineState.color || 'Default';
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

            const colors = this.manager.getMarkerColors();
            const color = this.polylineState.color || colors[0]?.className || '';
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
        if (this.callbacks.isDialogOpen() || this.polylineState.isActive) {
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
        if (this.polylineState.isActive) {
            event.preventDefault();
            return;
        }

        if (this.markerMoveState || this.markerHoldStart) {
            event.preventDefault();
            return;
        }

        const markerName = this.getEditableMarkerNameAtEvent(event);
        if (markerName) {
            event.preventDefault();
            this.callbacks.onOpenMarkerMenu(markerName, event.clientX, event.clientY);
        }
    };

    private handleWindowKeyDown = (event: KeyboardEvent): void => {
        if (this.callbacks.isDialogOpen()) {
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

        if (event.key !== 'Delete' || this.polylineState.isActive) {
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
        if (!event.isPrimary || this.callbacks.isDialogOpen()) {
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

    private handleMapPointerMove = (event: PointerEvent): void => {
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
