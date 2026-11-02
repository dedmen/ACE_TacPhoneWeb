/**
 * React boundary of the GPS panel.
 *
 * Mirrors `MarkerOverlay`: it acquires the GPS interest, creates the
 * imperative {@link GpsModule} for the existing OpenLayers map, registers the
 * `map.gps_route` Messenger renderer while mounted, and renders the HUD, route
 * panel, shared-route preview and advisor card. All the map work lives in the
 * module.
 */

import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type OlMap from 'ol/Map';
import type { TerrainData } from '@ace-tacphone/api';

import type { GpsStartRouteOptions, MapFlyToOptions } from '../api';
import { t } from '../i18n';
import {
    isMessengerInstalled,
    registerGpsRouteObjectRenderer,
    shareGpsRouteToMessenger,
} from '../MessagingBridge';
import { DEBUG_OVERLAY_ALPHA, type DebugSample } from './GpsDebugOverlay';
import { formatDistance, formatDuration, formatSharedSummary } from './GpsFormat';
import { GpsHud } from './GpsHud';
import {
    GPS_INTEREST,
    GpsModule,
    travelModeLabel,
    type GpsModuleCallbacks,
} from './GpsModule';
import {
    createInitialGpsViewState,
    type GpsDebugOverlayMode,
    type GpsStatus,
    type GpsViewState,
} from './GpsTypes';
import {
    decodeSharedRoute,
    encodeSharedRoute,
    type SharedRouteData,
} from './SharedRoute';
import styles from './GpsStyles.module.scss';

export interface GpsOverlayProps {
    map: OlMap | null;
    terrain: TerrainData | null;
    flyTo: (options: MapFlyToOptions) => void;
    onRequestCloseLayers?: () => void;
}

export interface GpsOverlayHandle {
    openSharedRoute(route: unknown): Promise<boolean>;
    startRouteTo(position: [number, number], options?: GpsStartRouteOptions): Promise<boolean>;
    suspendFollow(): void;
}

type NoticeKey = 'share-failed' | 'too-large' | 'messenger-unavailable' | 'route-failed' | 'shared-unavailable';

function formatWaypointCount(count: number): string {
    return count === 1
        ? t('STR_ACE_Tacphone_Map_Gps_Shared_Waypoints_One', count)
        : t('STR_ACE_Tacphone_Map_Gps_Shared_Waypoints_Other', count);
}

function statusText(status: GpsStatus | null): string | null {
    if (!status) {
        return null;
    }

    switch (status.kind) {
        case 'analyzing':
            return t('STR_ACE_Tacphone_Map_Gps_Status_Analyzing');
        case 'no-terrain':
            return t('STR_ACE_Tacphone_Map_Gps_Status_NoTerrain');
        case 'no-route':
            return t('STR_ACE_Tacphone_Map_Gps_Route_NoRoute');
        case 'no-path':
            return t('STR_ACE_Tacphone_Map_Gps_Route_NoPath');
        case 'route-failed':
            return t('STR_ACE_Tacphone_Map_Gps_Notification_RouteFailed');
        case 'vehicle-changed':
            return t('STR_ACE_Tacphone_Map_Gps_VehicleChanged');
        case 'advisor-unreachable':
            return t('STR_ACE_Tacphone_Map_Gps_Advisor_Unreachable', travelModeLabel(status.mode));
    }
}

function noticeText(notice: NoticeKey): string {
    switch (notice) {
        case 'share-failed':
            return t('STR_ACE_Tacphone_Map_Gps_Notification_ShareFailed');
        case 'too-large':
            return t('STR_ACE_Tacphone_Map_Gps_Notification_RouteTooLarge');
        case 'messenger-unavailable':
            return t('STR_ACE_Tacphone_Map_Gps_Notification_MessengerUnavailable');
        case 'route-failed':
            return t('STR_ACE_Tacphone_Map_Gps_Notification_RouteFailed');
        case 'shared-unavailable':
            return t('STR_ACE_Tacphone_Map_Gps_Shared_Unavailable');
    }
}

/** Player identifier used until the game exposes a display name. */
function resolveAuthor(): string {
    try {
        return window.TacPhone.gameInfo.get()?.playerId ?? '';
    } catch {
        return '';
    }
}

export const GpsOverlay = forwardRef<GpsOverlayHandle, GpsOverlayProps>(function GpsOverlay(
    { map, terrain, flyTo, onRequestCloseLayers },
    ref,
) {
    const [ready, setReady] = useState(false);
    const [state, setState] = useState<GpsViewState>(createInitialGpsViewState);
    const [sharing, setSharing] = useState(false);
    const [notice, setNotice] = useState<NoticeKey | null>(null);
    /** True when starting a shared route would replace the active navigation. */
    const [replacePending, setReplacePending] = useState(false);
    const [panelOpen, setPanelOpen] = useState(false);
    const [, setLocaleTick] = useState(0);

    // Debug-only route-planning overlay. Everything below is inert in a normal
    // build; the dialog labels are plain English on purpose.
    const [debugEnabled, setDebugEnabled] = useState(false);
    const [debugOpen, setDebugOpen] = useState(false);
    const [costOverlay, setCostOverlay] = useState(false);
    const [heightOverlay, setHeightOverlay] = useState(false);
    const [ignoreSlope, setIgnoreSlope] = useState(false);
    const [overlayAlpha, setOverlayAlpha] = useState(DEBUG_OVERLAY_ALPHA);
    const [debugScanning, setDebugScanning] = useState(false);
    const [debugSample, setDebugSample] = useState<DebugSample | null>(null);

    const moduleRef = useRef<GpsModule | null>(null);
    const flyToRef = useRef(flyTo);
    const terrainRef = useRef(terrain);
    const pendingSharedRef = useRef<SharedRouteData | null>(null);

    const debugMode = useMemo<GpsDebugOverlayMode>(() => {
        if (costOverlay && heightOverlay) {
            return 'both';
        }
        if (costOverlay) {
            return 'cost';
        }
        return heightOverlay ? 'height' : 'none';
    }, [costOverlay, heightOverlay]);

    // Read once: the debug flag cannot change while the panel is mounted. The
    // ref lets the module be re-created by StrictMode without losing the
    // current overlay choice.
    const debugRef = useRef<{ mode: GpsDebugOverlayMode; slope: boolean; alpha: number }>({
        mode: 'none',
        slope: true,
        alpha: DEBUG_OVERLAY_ALPHA,
    });

    const scanDebugViewport = useCallback(() => {
        const mode: GpsDebugOverlayMode = costOverlay || heightOverlay ? debugMode : 'cost';
        if (!costOverlay && !heightOverlay) {
            setCostOverlay(true);
        }
        setDebugScanning(true);
        const scan = moduleRef.current?.scanDebugViewport(mode) ?? Promise.resolve(false);
        void scan.finally(() => {
            setDebugScanning(false);
        });
    }, [costOverlay, heightOverlay, debugMode]);

    useEffect(() => {
        if (!map || !debugEnabled || !debugOpen || (!costOverlay && !heightOverlay)) {
            return undefined;
        }

        const viewport = map.getViewport();
        const onMove = (event: PointerEvent): void => {
            const coordinate = map.getEventCoordinate(event);
            setDebugSample(
                moduleRef.current?.getDebugSampleAt([coordinate[0], coordinate[1]]) ?? null,
            );
        };
        const onLeave = (): void => setDebugSample(null);

        viewport.addEventListener('pointermove', onMove);
        viewport.addEventListener('pointerleave', onLeave);
        return () => {
            viewport.removeEventListener('pointermove', onMove);
            viewport.removeEventListener('pointerleave', onLeave);
        };
    }, [map, debugEnabled, debugOpen, costOverlay, heightOverlay]);

    // The latest `flyTo` is only needed from callbacks and effects, so it is
    // synced after the commit instead of written during render.
    useLayoutEffect(() => {
        flyToRef.current = flyTo;
    });

    // Stable module callbacks: the module outlives renders, so re-creating them
    // would restart it on every state update.
    const callbacks = useMemo<GpsModuleCallbacks>(() => ({
        onStateChange: (next) => setState(next),
        flyTo: (options) => flyToRef.current(options),
    }), []);

    useLayoutEffect(() => {
        if (!map) {
            return undefined;
        }

        // Acquire the interest before the module asks for the travel mode, so
        // the game-side per-frame handler starts immediately.
        const releaseInterest = window.TacPhone.interests.acquire(GPS_INTEREST);
        const module = new GpsModule(map, callbacks);

        moduleRef.current = module;
        module.setTerrain(terrainRef.current);
        // Re-apply the debug overlay after a StrictMode remount; the module
        // ignores this unless the game reports debug.
        module.setDebugOverlay(
            debugRef.current.mode,
            debugRef.current.slope,
            debugRef.current.alpha,
        );
        setState(module.getState());
        setReady(true);

        const releaseRenderer = registerGpsRouteObjectRenderer();

        const pending = pendingSharedRef.current;
        if (pending) {
            pendingSharedRef.current = null;
            module.showSharedRoutePreview(pending);
        }

        return () => {
            moduleRef.current = null;
            module.destroy();
            releaseInterest();
            releaseRenderer();
            setReady(false);
            setState(createInitialGpsViewState());
        };
    }, [map, callbacks]);

    useEffect(() => {
        terrainRef.current = terrain;

        if (ready) {
            moduleRef.current?.setTerrain(terrain);
        }
    }, [terrain, ready]);

    useEffect(() => {
        try {
            setDebugEnabled(window.TacPhone.gameInfo.isDebug());
        } catch {
            setDebugEnabled(false);
        }
    }, []);

    useEffect(() => {
        debugRef.current = { mode: debugMode, slope: !ignoreSlope, alpha: overlayAlpha };
        if (ready) {
            moduleRef.current?.setDebugOverlay(debugMode, !ignoreSlope, overlayAlpha);
        }
    }, [debugMode, ignoreSlope, overlayAlpha, ready]);

    useEffect(() => {
        return window.TacPhone.localization.onDidChange(() => {
            setLocaleTick((value) => value + 1);
        });
    }, []);

    useEffect(() => {
        if (!notice) {
            return undefined;
        }

        const timer = window.setTimeout(() => setNotice(null), 4000);
        return () => window.clearTimeout(timer);
    }, [notice]);

    const openSharedRoute = useCallback(async (route: unknown): Promise<boolean> => {
        const currentTerrain = terrainRef.current;
        const bounds = currentTerrain
            ? { width: currentTerrain.width, height: currentTerrain.height }
            : undefined;
        const decoded = decodeSharedRoute(route, bounds);

        if (!decoded.ok) {
            setNotice('shared-unavailable');
            return false;
        }

        setReplacePending(false);

        const module = moduleRef.current;
        if (!module) {
            // The panel is still creating the module; show it once ready.
            pendingSharedRef.current = decoded.data;
            return true;
        }

        return module.showSharedRoutePreview(decoded.data);
    }, []);

    const startRouteTo = useCallback(async (
        position: [number, number],
        options?: GpsStartRouteOptions,
    ): Promise<boolean> => {
        const module = moduleRef.current;
        if (!module) {
            return false;
        }

        const started = await module.startRouteTo(position, options);
        if (!started) {
            setNotice('route-failed');
            return false;
        }

        setNotice(null);
        setPanelOpen(false);
        return true;
    }, []);

    useImperativeHandle(ref, () => ({
        openSharedRoute,
        startRouteTo,
        suspendFollow(): void {
            moduleRef.current?.suspendFollow();
        },
    }), [openSharedRoute, startRouteTo]);

    const togglePlanning = useCallback(() => {
        const module = moduleRef.current;
        if (!module) {
            return;
        }

        onRequestCloseLayers?.();
        module.setPlanning(!module.getState().planning);
    }, [onRequestCloseLayers]);

    const startSharedRoute = useCallback(async () => {
        const module = moduleRef.current;
        if (!module) {
            return;
        }

        const current = module.getState();

        // Replacing a running navigation is confirmed in the card, because the
        // in-game browser does not reliably show a native `confirm()` dialog.
        if (current.navigating && current.route && !replacePending) {
            setReplacePending(true);
            return;
        }

        setReplacePending(false);

        const started = await module.startSharedRoute();
        if (!started) {
            setNotice('route-failed');
        }
    }, [replacePending]);

    const discardSharedRoute = useCallback(() => {
        setReplacePending(false);
        moduleRef.current?.discardSharedRoute();
    }, []);

    const shareRoute = useCallback(async () => {
        const module = moduleRef.current;
        if (!module || sharing) {
            return;
        }

        const route = module.getActiveRoute();
        if (!route) {
            return;
        }

        if (!isMessengerInstalled()) {
            setNotice('messenger-unavailable');
            return;
        }

        const current = module.getState();
        const origin = current.position ?? route.waypoints[0];
        if (!origin) {
            return;
        }

        const encoded = encodeSharedRoute(route, {
            origin,
            author: resolveAuthor(),
            createdAt: Math.round(Date.now() / 1000),
            label: route.label,
            vehicle: module.getPerformanceSnapshot(),
        });

        if (!encoded.ok) {
            setNotice(encoded.reason === 'too-large' ? 'too-large' : 'share-failed');
            return;
        }

        setSharing(true);

        try {
            const result = await shareGpsRouteToMessenger(encoded.data, encoded.data.author);
            if (!result.ok && !result.cancelled) {
                setNotice('share-failed');
            }
        } catch (error) {
            console.warn('GPS: sharing the route failed', error);
            setNotice('share-failed');
        } finally {
            setSharing(false);
        }
    }, [sharing]);

    if (!ready || !map) {
        return null;
    }

    const status = statusText(state.status);
    const advisor = state.advisor;
    const shared = state.shared;

    return (
        <div className={styles.overlay}>
            <GpsHud state={state} />

            <button
                type="button"
                className={styles.panelToggle}
                aria-pressed={panelOpen}
                aria-label={t('STR_ACE_Tacphone_Map_Gps_Route_Title')}
                data-testid="gps-panel-toggle"
                onClick={() => setPanelOpen((open) => !open)}
            >
                <svg viewBox="0 0 24 24" width="22" height="22" focusable="false" aria-hidden="true">
                    <path d="M4 18 L9 6 L15 15 L20 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
                    <circle cx="4" cy="18" r="2.2" fill="currentColor" />
                    <circle cx="20" cy="6" r="2.2" fill="currentColor" />
                </svg>
            </button>

            {panelOpen && (
            <section className={styles.panel} aria-label={t('str_a3_gps1')} data-testid="gps-route-panel">
                <header className={styles.panelHeader}>
                    <h2 className={styles.panelTitle}>{t('str_a3_gps1')}</h2>
                    <span className={styles.modeState}>{travelModeLabel(state.mode)}</span>
                </header>

                {status && <p className={styles.status} data-testid="gps-status">{status}</p>}
                {notice && (
                    <p role="alert" className={styles.notice} data-testid="gps-notice">
                        {noticeText(notice)}
                    </p>
                )}

                <div className={styles.actionRow}>
                    <button
                        type="button"
                        className={styles.button}
                        aria-pressed={state.planning}
                        onClick={togglePlanning}
                    >
                        {t('STR_ACE_Tacphone_Map_Gps_Route_AddWaypoint')}
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={state.waypointCount === 0}
                        onClick={() => moduleRef.current?.clearWaypoints()}
                    >
                        {t('str_disp_arcmap_clear')}
                    </button>
                </div>

                {state.planning && (
                    <p className={styles.hint}>{t('STR_ACE_Tacphone_Map_Gps_Route_PlanningHint')}</p>
                )}

                <h3 className={styles.sectionTitle}>{t('STR_ACE_Tacphone_Map_Gps_Route_Title')}</h3>

                {state.waypoints.length > 0 && (
                    <ol className={styles.waypointList} data-testid="gps-waypoint-list">
                        {state.waypoints.map((_waypoint, index) => (
                            <li key={index} className={styles.waypointItem}>
                                <span className={styles.waypointIndex}>{index + 1}</span>
                                <button
                                    type="button"
                                    className={styles.removeButton}
                                    aria-label={t('STR_ACE_Tacphone_Map_Gps_Route_RemoveWaypoint')}
                                    onClick={() => moduleRef.current?.removeWaypoint(index)}
                                >
                                    ×
                                </button>
                            </li>
                        ))}
                    </ol>
                )}

                {state.route ? (
                    <div className={styles.summary}>
                        {state.route.source === 'shared' && state.route.author && (
                            <div>{t('STR_ACE_Tacphone_Map_Gps_Shared_From', state.route.author)}</div>
                        )}
                        {state.offRoute && (
                            <div className={styles.warning}>
                                {t('STR_ACE_Tacphone_Map_Gps_Route_OffRoute')}
                            </div>
                        )}
                        {state.stale && (
                            <div className={styles.warning}>
                                {t('STR_ACE_Tacphone_Map_Gps_Route_Stale')}
                            </div>
                        )}
                    </div>
                ) : (
                    <p className={styles.muted}>{t('STR_ACE_Tacphone_Map_Gps_Route_NoRoute')}</p>
                )}

                <div className={styles.actionRow}>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={(state.waypointCount === 0 && !state.route) || state.calculating}
                        onClick={() => {
                            if (state.route) {
                                void moduleRef.current?.recalculate();
                            } else {
                                void moduleRef.current?.calculateRoute();
                            }
                        }}
                    >
                        {state.route
                            ? t('STR_ACE_Tacphone_Map_Gps_Route_Recalculate')
                            : t('STR_ACE_Tacphone_Map_Gps_Route_Calculate')}
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={state.waypointCount === 0 && !state.route}
                        onClick={() => {
                            if (state.navigating) {
                                moduleRef.current?.stopNavigation();
                            } else {
                                moduleRef.current?.startNavigation();
                            }
                        }}
                    >
                        {state.navigating
                            ? t('str_a3_stop')
                            : t('str_mprole_start')}
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        disabled={!state.route || sharing}
                        onClick={() => void shareRoute()}
                    >
                        {t('STR_ACE_Tacphone_Map_Gps_Route_Share')}
                    </button>
                </div>

                {shared && (
                    <div className={styles.card} data-testid="gps-shared-card">
                        <h3 className={styles.cardTitle}>
                            {shared.label ?? t('STR_ACE_Tacphone_Map_Gps_Shared_Title')}
                        </h3>
                        <p className={styles.cardText}>
                            {t('STR_ACE_Tacphone_Map_Gps_Shared_From', shared.author)}
                        </p>
                        <p className={styles.cardText}>
                            {formatSharedSummary(
                                travelModeLabel(shared.mode),
                                shared.distance,
                                formatWaypointCount(shared.waypointCount),
                            )}
                        </p>
                        {shared.walkDistance > 0 && (
                            <p className={styles.cardText}>
                                {t(
                                    'STR_ACE_Tacphone_Map_Gps_Shared_Walk',
                                    formatDistance(shared.walkDistance),
                                )}
                            </p>
                        )}
                        <p className={styles.cardText}>
                            {t('STR_ACE_Tacphone_Map_Gps_Route_Eta', formatDuration(shared.eta))}
                        </p>
                        <p className={styles.cardText}>
                            {t('STR_ACE_Tacphone_Map_Gps_Shared_Join')}
                        </p>
                        {replacePending && (
                            <p className={styles.warning} role="alert">
                                {t('STR_ACE_Tacphone_Map_Gps_Shared_ReplaceConfirm')}
                            </p>
                        )}
                        <div className={styles.actionRow}>
                            <button
                                type="button"
                                className={styles.button}
                                onClick={() => void startSharedRoute()}
                            >
                                {replacePending
                                    ? t('STR_ACE_Tacphone_Map_Gps_Shared_Replace')
                                    : t('STR_ACE_Tacphone_Map_Gps_Shared_Start')}
                            </button>
                            <button
                                type="button"
                                className={styles.button}
                                onClick={replacePending
                                    ? () => setReplacePending(false)
                                    : discardSharedRoute}
                            >
                                {replacePending
                                    ? t('STR_3DEN_Display3DEN_ControlsHint_Cancel')
                                    : t('str_a3_rscdisplaylogin_bx_discard')}
                            </button>
                        </div>
                    </div>
                )}

                {advisor && (
                    <div className={styles.card} data-testid="gps-advisor-card">
                        <h3 className={styles.cardTitle}>
                            {t('STR_ACE_Tacphone_Map_Gps_Advisor_Title')}
                        </h3>
                        <p className={styles.cardText}>
                            {t(
                                'STR_ACE_Tacphone_Map_Gps_Advisor_Faster',
                                travelModeLabel(advisor.mode),
                                formatDuration(advisor.alternativeSeconds),
                                formatDuration(advisor.savesSeconds),
                            )}
                        </p>
                        <div className={styles.actionRow}>
                            <button
                                type="button"
                                className={styles.button}
                                onClick={() => moduleRef.current?.acceptAdvisor()}
                            >
                                {t('str_disp_switch')}
                            </button>
                            <button
                                type="button"
                                className={styles.button}
                                onClick={() => moduleRef.current?.dismissAdvisor()}
                            >
                                {t('STR_ACE_Tacphone_Map_Gps_Advisor_Dismiss')}
                            </button>
                        </div>
                    </div>
                )}
            </section>
            )}

            {debugEnabled && (
                <>
                    <button
                        type="button"
                        className={styles.debugLauncher}
                        aria-pressed={debugOpen}
                        data-testid="gps-debug-toggle"
                        onClick={() => setDebugOpen((open) => !open)}
                    >
                        DBG
                    </button>

                    {debugOpen && (
                        <div className={styles.debugPanel} data-testid="gps-debug-panel">
                            <div className={styles.debugTitle}>Route debug</div>
                            <label className={styles.debugRow}>
                                <input
                                    type="checkbox"
                                    checked={costOverlay}
                                    onChange={(event) => setCostOverlay(event.target.checked)}
                                />
                                Cost overlay
                            </label>
                            <label className={styles.debugRow}>
                                <input
                                    type="checkbox"
                                    checked={heightOverlay}
                                    onChange={(event) => setHeightOverlay(event.target.checked)}
                                />
                                Height overlay
                            </label>
                            <label className={styles.debugRow}>
                                <input
                                    type="checkbox"
                                    checked={ignoreSlope}
                                    onChange={(event) => setIgnoreSlope(event.target.checked)}
                                />
                                Ignore slope influence
                            </label>
                            <label className={styles.debugRow}>
                                <span>Alpha</span>
                                <input
                                    type="range"
                                    min="5"
                                    max="100"
                                    step="5"
                                    value={Math.round(overlayAlpha * 100)}
                                    onChange={(event) => {
                                        setOverlayAlpha(Number(event.target.value) / 100);
                                    }}
                                />
                                <span>{Math.round(overlayAlpha * 100)}%</span>
                            </label>
                            <button
                                type="button"
                                className={styles.debugAction}
                                data-testid="gps-debug-scan"
                                disabled={debugScanning}
                                onClick={scanDebugViewport}
                            >
                                {debugScanning ? 'Scanning…' : 'Scan current view'}
                            </button>
                            {debugSample && (costOverlay || heightOverlay) && (
                                <div className={styles.debugReadout} data-testid="gps-debug-readout">
                                    {heightOverlay && (
                                        <div>
                                            Height:{' '}
                                            {debugSample.height === null
                                                ? '--'
                                                : `${debugSample.height.toFixed(1)} m`}
                                        </div>
                                    )}
                                    {costOverlay && (
                                        <div>
                                            Cost:{' '}
                                            {debugSample.cost === null
                                                ? '--'
                                                : `${debugSample.cost.toFixed(4)} s/m`}
                                        </div>
                                    )}
                                    <div>Surface: {debugSample.surface ?? '--'}</div>
                                    <div>Passable: {debugSample.passable ? 'yes' : 'no'}</div>
                                    <div>Slope x{debugSample.slope.toFixed(2)}</div>
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
});
