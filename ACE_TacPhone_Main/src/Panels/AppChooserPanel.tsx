// The tab content every unassigned tab starts with: an app launcher.
//
// Once the user picks an app, the tab "becomes" that app: the choice lives in
// this component's state and in the tab config, so the saved layout restores it
// even while the tab is unmounted, and the flexlayout component stays
// "AppChooser".
//
// The launcher is a phone-style icon grid: one tile per panel, with the app
// icon (or a generated monogram when the app has none), the panel title and the
// owning app name. Clients with a precise pointer (desktop browsers) also get a
// search field above the grid; on a touch phone the field is not rendered, so
// the grid keeps the whole panel.
//
// The panel list is read from the app directory and refreshed through
// `appDirectory.onDidChange`, because panel icons resolve asynchronously after
// the first paint. Failed apps are listed in a separate section instead of
// looking like broken tiles among the working ones.
//
// StrictMode note: the selection is plain state (no instance field, no
// forceUpdate), the state updater is pure, and every host call (setApp,
// setTitle, setIcon, config persistence) is idempotent, so a double mount in
// development does not create the app twice. The catalog and pointer
// subscriptions are installed in componentDidMount and dropped in
// componentWillUnmount.

import React from "react";
import type {
    AppPanelInfo,
    PanelInstance,
    PanelMeta,
    TacPhoneHost,
} from "@ace-tacphone/api";
import styles from './AppChooserPanel.module.css'
import { AppErrorBoundary } from './AppErrorBoundary';
import { panelDirectory } from '../Backend/PanelDirectory';
import { appDirectory } from '../Backend/AppDirectory';

export type AppChooserPanelProps = {
    /** Live handle of the tab this chooser runs in. */
    panel: PanelInstance;
    /** flexlayout TabNode of this tab. */
    node: unknown;
    /** flexlayout Model that holds the tab. */
    model: unknown;
};

type AppChooserPanelState = {
    /** App panel id this tab runs; undefined while the chooser is shown. */
    activeApp: string | undefined;
    /** Current search text. Empty until the user types in the desktop field. */
    filter: string;
    /** True when this client has a mouse/trackpad, which gets the search field. */
    searchable: boolean;
    /** Panels to show, refreshed when the catalog or its icons change. */
    panels: PanelMeta[];
};

/**
 * Matches a desktop client. Same query as the notification close button: a
 * precise pointer and hover means a mouse/trackpad, not the in-game phone.
 */
const DESKTOP_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

function getHost(): TacPhoneHost {
    return window.TacPhone;
}

/** True when this client should show the app search field. */
function isSearchableClient(): boolean {
    return typeof window.matchMedia === "function"
        && window.matchMedia(DESKTOP_POINTER_QUERY).matches;
}

/** Reads the persisted `panelId` out of a tab config. */
function readPanelId(config: unknown): string | undefined {
    if (typeof config !== "object" || config === null || Array.isArray(config))
        return undefined;

    const panelId = (config as { panelId?: unknown }).panelId;
    return typeof panelId === "string" && panelId.length > 0 ? panelId : undefined;
}

/**
 * Initial app of a tab, taken from its persisted config in the state
 * initializer so a restored layout renders the app on the first paint.
 */
function configuredPanelId(panel: PanelInstance): string | undefined {
    const panelId = readPanelId(panel.getConfig());
    if (!panelId)
        return undefined;

    return getHost().apps.knownPanels.has(panelId) ? panelId : undefined;
}

/** Cached display data of one panel, or undefined when the host does not know it. */
function panelMeta(panelId: string): PanelMeta | undefined {
    try {
        return getHost().apps.getPanelMeta(panelId);
    } catch (error) {
        console.error(`TacPhone failed to read the metadata of panel "${panelId}":`, error);
        return undefined;
    }
}

/** Default title of a panel: cached metadata first, then the panel itself. */
function defaultTitle(panelId: string): string {
    const meta = panelMeta(panelId);
    if (meta?.title)
        return meta.title;

    const panel = getHost().apps.knownPanels.get(panelId);
    if (!panel)
        return panelId;

    try {
        const title = panel.GetDefaultTitle?.();
        return typeof title === "string" && title.length > 0 ? title : panelId;
    } catch (error) {
        console.error(`TacPhone panel "${panelId}" failed in GetDefaultTitle():`, error);
        return panelId;
    }
}

/** One entry per selectable panel: cached metadata, with the panel as a fallback. */
function readCatalog(): PanelMeta[] {
    const apps = getHost().apps;

    try {
        const listed = apps.listPanels();
        if (listed.length > 0)
            return listed;
    } catch (error) {
        console.error("TacPhone failed to list the available panels:", error);
    }

    return [...apps.knownPanels.keys()].map(panelId => ({
        id: panelId,
        appName: apps.appNameForPanel(panelId) ?? panelId,
        title: defaultTitle(panelId),
        icon: panelMeta(panelId)?.icon,
    }));
}

/** True when every whitespace-separated token of `query` occurs in `values`. */
function matchesQuery(query: string, values: Array<string | undefined>): boolean {
    const tokens = query.toLowerCase().split(/\s+/).filter(token => token.length > 0);
    if (tokens.length === 0)
        return true;

    const haystack = values.filter(value => typeof value === "string").join(" ").toLowerCase();
    return tokens.every(token => haystack.includes(token));
}

/** Stable hue per panel id, so a generated monogram keeps one color across reloads. */
function hueFor(id: string): number {
    let hash = 0;
    for (let index = 0; index < id.length; index++)
        hash = (hash * 31 + id.charCodeAt(index)) >>> 0;

    return hash % 360;
}

/** Up to two initials of a title, used when the app has no icon. */
function monogram(title: string): string {
    const words = title.trim().split(/\s+/).filter(word => word.length > 0);
    if (words.length === 0)
        return "?";

    if (words.length === 1)
        return words[0].slice(0, 2).toUpperCase();

    return (words[0][0] + words[1][0]).toUpperCase();
}

/** Background of a generated icon; the same hue drives the monogram tile. */
function monogramStyle(id: string): React.CSSProperties {
    const hue = hueFor(id);
    return {
        background: `linear-gradient(150deg, hsl(${hue} 58% 58%), hsl(${(hue + 38) % 360} 54% 36%))`,
    };
}

/** Hides an icon that failed to decode, revealing the monogram underneath. */
function hideBrokenIcon(event: React.SyntheticEvent<HTMLImageElement>): void {
    event.currentTarget.style.display = "none";
}

export class AppChooserPanel extends React.Component<AppChooserPanelProps, AppChooserPanelState> {
    state: AppChooserPanelState = {
        activeApp: configuredPanelId(this.props.panel),
        filter: "",
        searchable: isSearchableClient(),
        panels: readCatalog(),
    };

    /** Installed while mounted; drives the search field on desktop clients. */
    private pointerQuery: MediaQueryList | undefined;
    /** Unsubscribes from app directory changes (icons, reloads). */
    private unsubscribeCatalog: (() => void) | undefined;
    /** Search input, so Clear puts the cursor back where the user expects it. */
    private searchInput: HTMLInputElement | null = null;

    componentDidMount(): void {
        this.unsubscribeCatalog = appDirectory.onDidChange(() => this.refreshCatalog());

        if (typeof window.matchMedia === "function") {
            this.pointerQuery = window.matchMedia(DESKTOP_POINTER_QUERY);
            this.pointerQuery.addEventListener("change", this.handlePointerChange);
        }

        // A panel mounted after LoadAvailableApps() is normally complete, but a
        // late icon load still updates the grid through onDidChange().
        this.refreshCatalog();
    }

    componentWillUnmount(): void {
        this.unsubscribeCatalog?.();
        this.unsubscribeCatalog = undefined;

        this.pointerQuery?.removeEventListener("change", this.handlePointerChange);
        this.pointerQuery = undefined;

        this.searchInput = null;
    }

    /** Refreshes the tiles without touching the selection or the search text. */
    private refreshCatalog(): void {
        this.setState({ panels: readCatalog() });
    }

    /** Pointer type can change (a tablet with a mouse, DevTools emulation). */
    private handlePointerChange = (): void => {
        const searchable = isSearchableClient();

        // A hidden filter would silently keep filtering, so drop it on touch.
        this.setState({
            searchable,
            filter: searchable ? this.state.filter : "",
        });
    };

    private handleFilterChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        this.setState({ filter: event.target.value });
    };

    private handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.key !== "Escape" || this.state.filter.length === 0)
            return;

        event.preventDefault();
        this.setState({ filter: "" });
    };

    private clearFilter = (): void => {
        this.setState({ filter: "" });
        this.searchInput?.focus();
    };

    /**
     * Switches the tab to the given app panel.
     *
     * The tab config is what the layout keeps, so it is updated in place next to
     * the runtime override (panel.setApp) and the visible title/icon.
     */
    private switchToApp(panelId: string): void {
        const apps = getHost().apps;
        const meta = panelMeta(panelId);

        if (!meta && !apps.knownPanels.has(panelId))
            return;

        const panel = this.props.panel;

        this.setState({ activeApp: panelId });

        panel.setApp(panelId);
        this.persistPanelId(panel, panelId);

        panel.setTitle(meta?.title || defaultTitle(panelId));
        // An empty icon clears the icon of the previously shown app, so the tab
        // does not keep drawing the wrong one.
        panel.setIcon(meta?.icon ?? "");
    }

    /** Stores `{ ...config, panelId }` on the tab so the layout keeps the choice. */
    private persistPanelId(panel: PanelInstance, panelId: string): void {
        const current = panel.getConfig();
        const base = typeof current === "object" && current !== null && !Array.isArray(current)
            ? current as Record<string, unknown>
            : {};

        try {
            // setPanelConfig() merges into the stored config, so the icon and any
            // app-specific keys survive the switch.
            panelDirectory.setPanelConfig(panel.tabId, { ...base, panelId });
        } catch (error) {
            console.error(`TacPhone failed to persist the app of tab "${panel.tabId}":`, error);
        }
    }

    /** Renders the selected app with the full AppProps contract. */
    private renderApp(panelId: string, panelInfo: AppPanelInfo): React.ReactNode {
        const host = getHost();
        const AppComponent = panelInfo.appComponent;

        return (
            <AppErrorBoundary key={panelId} appName={defaultTitle(panelId)}>
                <AppComponent
                    appId={host.apps.appNameForPanel(panelId) ?? panelId}
                    panelId={panelId}
                    node={this.props.node}
                    model={this.props.model}
                    panel={this.props.panel}
                />
            </AppErrorBoundary>
        );
    }

    /** One app tile: icon (or monogram), title, and the owning app when it differs. */
    private renderTile(entry: PanelMeta): React.ReactNode {
        const showAppName = entry.appName.length > 0 && entry.appName !== entry.title;

        return (
            <button
                key={entry.id}
                type="button"
                className={styles.Tile}
                title={showAppName ? `${entry.title} · ${entry.appName}` : entry.title}
                onClick={() => this.switchToApp(entry.id)}
            >
                <span className={styles.Icon} style={monogramStyle(entry.id)}>
                    <span className={styles.Monogram} aria-hidden="true">{monogram(entry.title)}</span>
                    {entry.icon
                        ? <img key={entry.icon} className={styles.IconImage} src={entry.icon} alt="" onError={hideBrokenIcon} />
                        : null}
                </span>
                <span className={styles.Label}>{entry.title}</span>
                {showAppName ? <span className={styles.AppName}>{entry.appName}</span> : null}
            </button>
        );
    }

    /** A failed app: visible, but not selectable. */
    private renderFailedTile(name: string, error: string): React.ReactNode {
        return (
            <div
                key={`failed-${name}`}
                className={styles.FailedTile}
                title={error}
            >
                <span className={styles.FailedIcon} aria-hidden="true">!</span>
                <span className={styles.Label}>{name}</span>
                <span className={styles.FailedText}>{error}</span>
            </div>
        );
    }

    /** Desktop-only search row; sticky so the grid scrolls underneath it. */
    private renderToolbar(): React.ReactNode {
        const filter = this.state.filter;

        return (
            <div className={styles.Toolbar}>
                <span className={styles.ToolbarTitle}>Apps</span>
                <div className={styles.SearchField}>
                    <svg className={styles.SearchIcon} viewBox="0 0 16 16" aria-hidden="true">
                        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                        <path d="M10.5 10.5 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                    <input
                        ref={element => { this.searchInput = element; }}
                        type="search"
                        className={styles.SearchInput}
                        value={filter}
                        onChange={this.handleFilterChange}
                        onKeyDown={this.handleSearchKeyDown}
                        placeholder="Search apps"
                        aria-label="Search apps"
                        autoFocus
                        autoComplete="off"
                        spellCheck={false}
                    />
                    {filter.length > 0
                        ? <button
                            type="button"
                            className={styles.ClearButton}
                            title="Clear search"
                            aria-label="Clear search"
                            onClick={this.clearFilter}
                        >×</button>
                        : null}
                </div>
            </div>
        );
    }

    private renderEmptyState(): React.ReactNode {
        const query = this.state.filter.trim();

        return (
            <div className={styles.Empty}>
                <span className={styles.EmptyTitle}>
                    {query.length > 0 ? `No apps match “${query}”` : "No apps are installed"}
                </span>
                <span className={styles.EmptyHint}>
                    {query.length > 0
                        ? "Try a different name, or clear the search."
                        : "Apps appear here once the game reports them."}
                </span>
                {query.length > 0
                    ? <button type="button" className={styles.EmptyButton} onClick={this.clearFilter}>Clear search</button>
                    : null}
            </div>
        );
    }

    private renderChooser(): React.ReactNode {
        const query = this.state.filter.trim();
        const entries = this.state.panels.filter(entry => matchesQuery(query, [entry.title, entry.appName, entry.id]));
        const failed = [...getHost().apps.failedApps.entries()]
            .filter(([name, error]) => matchesQuery(query, [name, error]));

        // Only advertise the phone-style grid when it has something to show.
        const hasEntries = entries.length > 0;
        const hasFailed = failed.length > 0;

        return (
            <div className={styles.Chooser}>
                {this.state.searchable ? this.renderToolbar() : null}
                <div className={styles.Content}>
                    {hasEntries
                        ? <div className={styles.Grid}>{entries.map(entry => this.renderTile(entry))}</div>
                        : null}
                    {!hasEntries && !hasFailed
                        ? this.renderEmptyState()
                        : null}
                    {hasFailed
                        ? (
                            <section className={styles.FailedSection}>
                                <h2 className={styles.FailedHeading}>Could not load</h2>
                                <div className={styles.Grid}>
                                    {failed.map(([name, error]) => this.renderFailedTile(name, error))}
                                </div>
                            </section>
                        )
                        : null}
                </div>
            </div>
        );
    }

    render(): React.ReactNode {
        const activeApp = this.state.activeApp;

        if (activeApp) {
            const panelInfo = getHost().apps.knownPanels.get(activeApp);
            if (panelInfo)
                return this.renderApp(activeApp, panelInfo);
        }

        return this.renderChooser();
    }
}
