/**
 * HUD overlay for the GPS panel: heading bar, route direction arrow, compass
 * rose, route distance/ETA and the centered player icon.
 *
 * The module updates the state at ~10 Hz; this component is deliberately pure
 * and cheap so those updates stay smooth.
 */

import React from 'react';

import type { GpsViewState } from './GpsTypes';
import { t } from '../i18n';
import { formatDistance, formatDuration } from './GpsFormat';
import styles from './GpsStyles.module.scss';

export interface GpsHudProps {
    state: GpsViewState;
}

function padHeading(value: number): string {
    const wrapped = ((Math.round(value) % 360) + 360) % 360;
    return `${String(wrapped).padStart(3, '0')}°`;
}

function normalize(value: number): number {
    const wrapped = value % 360;
    return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Heading text used by the top bar. */
function formatHeading(state: GpsViewState): string {
    if (!state.hasFix || state.heading === null) {
        return t('STR_ACE_Tacphone_Map_Gps_Hud_NoHeading');
    }
    return t('STR_ACE_Tacphone_Map_Gps_Hud_Heading', padHeading(state.heading));
}

export function GpsHud({ state }: GpsHudProps): React.JSX.Element {
    const heading = state.heading ?? 0;
    const routeArrowAngle = state.routeBearing === null
        ? 0
        : normalize(state.rotating ? state.routeBearing - heading : state.routeBearing);
    const showRouteArrow = state.navigating && state.routeBearing !== null && !state.arrived;

    return (
        <div className={styles.hud} aria-live="polite" data-testid="gps-hud">
            <div className={styles.topBar}>
                <div className={styles.headingBar} data-testid="gps-heading">{formatHeading(state)}</div>

                {showRouteArrow && (
                    <div
                        className={styles.routeArrowInline}
                        style={{ transform: `rotate(${routeArrowAngle}deg)` }}
                        aria-hidden="true"
                    >
                        <svg viewBox="0 0 24 24" width="26" height="26" focusable="false">
                            <path
                                d="M12 2 L20 22 L12 17 L4 22 Z"
                                fill="#22d3ee"
                                stroke="#0f172a"
                                strokeWidth="1.5"
                                strokeLinejoin="round"
                            />
                        </svg>
                    </div>
                )}

                {state.navigating && state.turn !== null && !state.arrived && (
                    <div className={styles.turnIndicator} data-testid="gps-turn" aria-label={state.turn}>
                        <svg viewBox="0 0 24 24" width="22" height="22" focusable="false" aria-hidden="true">
                            <path
                                d={state.turn === 'left'
                                    ? 'M18 20 V10 A8 8 0 0 0 6 4 M6 4 L6 10 M6 4 L12 8'
                                    : state.turn === 'right'
                                        ? 'M6 20 V10 A8 8 0 0 1 18 4 M18 4 L18 10 M18 4 L12 8'
                                        : 'M12 20 V4 M12 4 L6 10 M12 4 L18 10'}
                                fill="none"
                                stroke="#fbbf24"
                                strokeWidth="2.4"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                        {state.turnDistance !== null && (
                            <span>{Math.round(state.turnDistance)} m</span>
                        )}
                    </div>
                )}

                {state.rotating && (
                    <div className={styles.compassInline} aria-hidden="true" data-testid="gps-compass">
                        <svg viewBox="0 0 64 64" width="46" height="46" focusable="false">
                            <g transform={`rotate(${state.mapRotation} 32 32)`}>
                                <circle cx="32" cy="32" r="30" fill="rgba(15,23,42,0.66)" stroke="rgba(148,163,184,0.55)" strokeWidth="1" />
                                <text x="32" y="13" textAnchor="middle" fill="#f87171" fontSize="11" fontWeight="800">N</text>
                                <text x="54" y="36" textAnchor="middle" fill="#cbd5e1" fontSize="9" fontWeight="800">E</text>
                                <text x="32" y="58" textAnchor="middle" fill="#cbd5e1" fontSize="9" fontWeight="800">S</text>
                                <text x="10" y="36" textAnchor="middle" fill="#cbd5e1" fontSize="9" fontWeight="800">W</text>
                            </g>
                        </svg>
                    </div>
                )}

                {state.route && (
                    <div className={styles.routeInfo} data-testid="gps-route-summary">
                        <span>{t('STR_ACE_Tacphone_Map_Gps_Route_Remaining', formatDistance(state.route.remaining))}</span>
                        <span>{t('STR_ACE_Tacphone_Map_Gps_Route_Eta', formatDuration(state.route.remainingEta))}</span>
                        {state.offRoute && <span className={styles.routeWarning}>{t('STR_ACE_Tacphone_Map_Gps_Route_OffRoute')}</span>}
                        {state.stale && <span className={styles.routeWarning}>{t('STR_ACE_Tacphone_Map_Gps_Route_Stale')}</span>}
                    </div>
                )}
            </div>

            {state.arrived && (
                <div className={styles.arrivedBadge}>
                    {t('STR_ACE_Tacphone_Map_Gps_Hud_Arrived')}
                </div>
            )}
        </div>
    );
}
