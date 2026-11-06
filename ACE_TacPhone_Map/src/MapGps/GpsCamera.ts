/**
 * Camera follow, rotation, speed-based zoom and route/waypoint pointer work
 * for the GPS module.
 *
 * Split out of `GpsModule` (the orchestrator). The class holds a back-reference
 * to the module (`m`) and reads/writes the shared GPS state through it; the
 * module registers the arrow-property pointer handlers on the map and removes
 * them again on teardown so the event references stay stable.
 */

import type MapBrowserEvent from 'ol/MapBrowserEvent';
import DragPan from 'ol/interaction/DragPan';

import { followResolution } from '../routing/FollowZoom';
import { findLegIndexForSegment } from '../routing/RouteMetrics';
import { describeRouteLegHover, type RouteLegHoverInfo } from '../routing/RouteLegInfo';
import { distanceBetween, normalizeDegrees, projectPointToPolyline } from './SharedRoute';
import type { GpsModule } from './GpsModule';

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Camera follow, rotation, zoom and pointer handlers for one GPS module. */
export class GpsCamera {
    private readonly m: GpsModule;

    constructor(m: GpsModule) {
        this.m = m;
    }

    get isFollowing(): boolean {
        // Planning is an explicit editing mode: never pull the map back while
        // the player is placing or dragging waypoints.
        return !this.m.planning && this.m.followEnabled && Date.now() >= this.m.followSuspendedUntil;
    }

    applyFollow(): void {
        if (!this.isFollowing || !this.m.position) {
            return;
        }

        const view = this.m.map.getView();
        const center = view.getCenter();
        // Follow the player whenever the actual view is not on them. The old
        // check only looked at `lastCenter`, so a view replacement (terrain
        // load / Vite reload) could leave the map at the terrain center while
        // `lastCenter` still described the player.
        const offCenter = !center
            || distanceBetween(center[0], center[1], this.m.position[0], this.m.position[1]) > 5;
        const moved = this.m.lastCenter === null
            || distanceBetween(this.m.position[0], this.m.position[1], this.m.lastCenter[0], this.m.lastCenter[1]) > 1;
        const headingChanged = this.m.lastCenterHeading !== null
            && this.m.heading !== null
            && Math.abs(normalizeDegrees(this.m.heading - this.m.lastCenterHeading)) > 5;

        if (
            !this.m.everCentered
            || this.m.lastCenter === null
            || offCenter
            || (moved && (this.m.speed > 0.3 || headingChanged))
        ) {
            view.setCenter(this.m.position);
            this.m.lastCenter = this.m.position;
            this.m.lastCenterHeading = this.m.heading;
            this.m.everCentered = true;
        }

        this.applySpeedZoom();
    }

    applyRotation(force: boolean): void {
        const view = this.m.map.getView();
        const rotating = this.m.settings.rotateWithPlayer;

        if (!force && !this.isFollowing) {
            // The map keeps its current rotation while the user pans around.
            this.m.playerIcon.setRotation(
                Math.abs(view.getRotation()) > 0.01 ? 0 : ((this.m.heading ?? 0) * Math.PI) / 180,
            );
            return;
        }

        const target = rotating && this.m.heading !== null
            ? -(this.m.heading * Math.PI) / 180
            : 0;

        if (Math.abs(view.getRotation() - target) > 0.001) {
            view.setRotation(target);
        }

        this.m.playerIcon.setRotation(rotating ? 0 : ((this.m.heading ?? 0) * Math.PI) / 180);
    }

    /**
     * Keeps about one minute of travel visible ahead of the player, with a
     * 200 m local radius while standing still. The target is eased so a speed
     * change zooms smoothly instead of jumping.
     */
    applySpeedZoom(): void {
        const view = this.m.map.getView();
        const current = view.getResolution();
        const size = this.m.map.getSize();
        if (!isFiniteNumber(current) || !size || size[0] <= 0 || size[1] <= 0) {
            return;
        }

        const target = followResolution(
            this.m.speed,
            Math.min(size[0], size[1]),
            view.getMinResolution(),
            view.getMaxResolution(),
        );
        if (target === null) {
            return;
        }

        if (Math.abs(current - target) / target > 0.05) {
            view.setResolution(current * 0.9 + target * 0.1);
        }
    }

    handleUserPan = (): void => {
        this.m.suspendFollow();
        const center = this.m.map.getView().getCenter();
        this.m.lastCenter = center ? [center[0], center[1]] : this.m.lastCenter;
        this.m.lastCenterHeading = this.m.heading;
    };

    setDragPanActive(active: boolean): void {
        this.m.map.getInteractions().forEach((interaction) => {
            if (interaction instanceof DragPan) {
                interaction.setActive(active);
            }
        });
    }

    waypointIndexAtEvent(event: PointerEvent): number | null {
        const feature = this.m.map.forEachFeatureAtPixel(
            this.m.map.getEventPixel(event),
            (candidate) => candidate,
            {
                layerFilter: (layer) => layer === this.m.waypointLayer,
                hitTolerance: 12,
            },
        );

        const index = feature?.get('waypointIndex');
        return typeof index === 'number' && Number.isInteger(index) ? index : null;
    }

    /**
     * Hover readout for the planned/active route. Projects the pointer onto the
     * full route geometry; a pixel-distance threshold replaces vector feature
     * hit-testing, which is unreliable for lines in Firefox at low zoom.
     */
    handleRoutePointerMove = (event: MapBrowserEvent): void => {
        if (!this.m.routeHoverEnabled || !this.m.activeRoute || !this.m.routeGeometry) {
            if (this.m.routeHover !== null) {
                this.setRouteHover(null);
            }
            return;
        }

        if (this.m.waypointDrag) {
            if (this.m.routeHover !== null) {
                this.setRouteHover(null);
            }
            return;
        }

        const coordinate = event.coordinate;
        const projection = projectPointToPolyline(
            coordinate[0],
            coordinate[1],
            this.m.routeGeometry.points,
        );
        const resolution = this.m.map.getView().getResolution();
        if (!projection || !isFiniteNumber(resolution) || resolution <= 0) {
            this.setRouteHover(null);
            return;
        }

        // Geometry-distance hover instead of vector feature hit-testing:
        // Firefox's line hit-testing is unreliable at low zoom and would only
        // answer on some route features.
        if (projection.distance > Math.max(20 * resolution, 10)) {
            if (this.m.routeHover !== null) {
                this.setRouteHover(null);
            }
            return;
        }
        const legIndex = findLegIndexForSegment(this.m.routeGeometry.legStarts, projection.segment);
        this.setRouteHover(describeRouteLegHover(
            this.m.activeRoute.legs,
            this.m.routeGeometry,
            legIndex,
            this.m.position,
            this.m.activeRoute.waypoints,
        ));
    };

    handleRoutePointerLeave = (): void => {
        this.setRouteHover(null);
    };

    setRouteHover(info: RouteLegHoverInfo | null): void {
        const current = this.m.routeHover;
        if (current === info) {
            return;
        }
        if (current && info
            && current.legIndex === info.legIndex
            && current.fromPlayer === info.fromPlayer
            && current.nextWaypointIndex === info.nextWaypointIndex
            && current.spanDistance === info.spanDistance) {
            return;
        }
        this.m.routeHover = info;
        this.m.emitState(true);
    }

    handleWaypointPointerDown = (event: PointerEvent): void => {
        if (!event.isPrimary || event.button !== 0) {
            return;
        }

        const index = this.waypointIndexAtEvent(event);
        if (index === null) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        this.m.waypointDrag = { index, pointerId: event.pointerId };
        this.m.waypointDragMoved = false;
        this.m.lastWaypointDragAt = Date.now();
        this.setDragPanActive(false);
        this.m.map.getViewport().style.cursor = 'grabbing';

        try {
            this.m.map.getViewport().setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is an enhancement; the document listeners still work.
        }
    };

    handleWaypointPointerMove = (event: PointerEvent): void => {
        const drag = this.m.waypointDrag;
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }

        event.preventDefault();
        const coordinate = this.m.map.getEventCoordinate(event);
        const point = this.m.routes.clampToTerrain([coordinate[0], coordinate[1]]);
        if (!point) {
            return;
        }

        this.m.waypoints[drag.index] = point;
        this.m.waypointDragMoved = true;
        this.m.routes.rebuildWaypointLayer();
        this.m.routes.scheduleMeasurements();
        this.m.routes.schedulePreviewRoute();
    };

    handleWaypointPointerUp = (event: PointerEvent): void => {
        const drag = this.m.waypointDrag;
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }

        this.m.waypointDrag = null;
        this.m.lastWaypointDragAt = Date.now();
        this.setDragPanActive(true);
        this.m.map.getViewport().style.cursor = '';
        try {
            this.m.map.getViewport().releasePointerCapture(event.pointerId);
        } catch {
            // The capture may already be gone.
        }

        if (this.m.waypointDragMoved) {
            this.m.routes.schedulePreviewRoute();
        }
    };
}
