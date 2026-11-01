// Host Options panel.
//
// Apps register their schemas through `window.TacPhone.options`; this panel is
// the only UI that edits them. The left sidebar lists the apps, the right side
// shows one simple row per option plus optional one-click presets.

import React from "react";
import type {
    AppOptionDefinition,
    AppOptionPreset,
    AppOptionsRegistration,
    AppProps,
} from "@ace-tacphone/api";

import { appOptions } from "../Backend/AppOptions";
import { appDirectory } from "../Backend/AppDirectory";
import styles from "./OptionsPanel.module.css";

interface OptionsPanelState {
    registrations: readonly AppOptionsRegistration[];
    /** App whose options are shown; undefined when no app registered any. */
    selectedApp: string | undefined;
}

function firstPanelId(app: string): string | undefined {
    try {
        return window.TacPhone.apps.knownApps.get(app)?.panels[0]?.id;
    } catch {
        return undefined;
    }
}

/** Sidebar title: registration title, then the first panel's default title. */
function appTitle(registration: AppOptionsRegistration): string {
    if (registration.title)
        return registration.title;

    try {
        const panel = window.TacPhone.apps.knownApps.get(registration.app)?.panels[0];
        const title = panel?.GetDefaultTitle?.();
        if (typeof title === "string" && title.length > 0)
            return title;
    } catch (error) {
        console.warn(`TacPhone could not read the title of app "${registration.app}".`, error);
    }

    return registration.app;
}

/** Sidebar icon: registration icon, then the first panel's resolved icon. */
function appIcon(registration: AppOptionsRegistration): string | undefined {
    if (registration.icon)
        return registration.icon;

    const panelId = firstPanelId(registration.app);
    if (!panelId)
        return undefined;

    try {
        return window.TacPhone.apps.getPanelMeta(panelId)?.icon;
    } catch {
        return undefined;
    }
}

function formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** Registrations sorted by their displayed title, for a deterministic sidebar. */
function sortedRegistrations(): readonly AppOptionsRegistration[] {
    return [...appOptions.list()]
        .sort((left, right) => appTitle(left).localeCompare(appTitle(right)));
}

function AppIcon({ registration }: { registration: AppOptionsRegistration }): React.ReactNode {
    const icon = appIcon(registration);
    if (icon)
        return <img className={styles.AppIcon} src={icon} alt="" />;

    const initial = appTitle(registration).trim().charAt(0).toUpperCase() || "?";

    return <span className={`${styles.AppIcon} ${styles.Monogram}`}>{initial}</span>;
}

interface OptionRowProps {
    app: string;
    definition: AppOptionDefinition;
    value: unknown;
}

function OptionControl({ app, definition, value }: OptionRowProps): React.ReactNode {
    const { key, type } = definition;
    const [selectOpen, setSelectOpen] = React.useState(false);
    const selectWrapRef = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        if (!selectOpen)
            return;

        const closeOutside = (event: PointerEvent): void => {
            if (!selectWrapRef.current?.contains(event.target as Node))
                setSelectOpen(false);
        };

        document.addEventListener("pointerdown", closeOutside);
        return () => document.removeEventListener("pointerdown", closeOutside);
    }, [selectOpen]);

    if (type === "boolean") {
        return (
            <input
                id={`option-${definition.key}`}
                className={styles.Checkbox}
                type="checkbox"
                checked={value === true}
                onChange={(event) => appOptions.set(app, key, event.target.checked)}
            />
        );
    }

    if (type === "select") {
        const choices = definition.choices ?? [];
        const selected = choices.findIndex(choice => choice.value === value);
        const selectedChoice = selected >= 0 ? choices[selected] : undefined;
        const buttonId = `option-${definition.key}`;
        const menuId = `${buttonId}-menu`;

        return (
            <div
                ref={selectWrapRef}
                className={styles.SelectWrap}
                onBlur={(event) => {
                    // Close only when focus left the whole widget.
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                        setSelectOpen(false);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape")
                        setSelectOpen(false);
                }}
            >
                <button
                    id={buttonId}
                    type="button"
                    className={styles.Select}
                    aria-haspopup="listbox"
                    aria-expanded={selectOpen}
                    aria-controls={selectOpen ? menuId : undefined}
                    onClick={() => setSelectOpen(open => !open)}
                >
                    <span className={styles.SelectValue}>
                        {selectedChoice?.label ?? "Choose…"}
                    </span>
                </button>

                {selectOpen && (
                    <div id={menuId} className={styles.SelectMenu} role="listbox" aria-labelledby={buttonId}>
                        {choices.map((choice, index) => (
                            <button
                                key={`${choice.label}:${index}`}
                                type="button"
                                role="option"
                                aria-selected={index === selected}
                                className={`${styles.SelectOption} ${index === selected ? styles.SelectOptionSelected : ""}`}
                                onClick={() => {
                                    appOptions.set(app, key, choice.value);
                                    setSelectOpen(false);
                                    selectWrapRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
                                }}
                            >
                                {choice.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    if (type === "number") {
        const number = typeof value === "number" ? value : Number(value);
        const safeValue = Number.isFinite(number) ? number : definition.default as number;
        const hasBounds = definition.min !== undefined || definition.max !== undefined;

        if (hasBounds) {
            return (
                <div className={styles.NumberRow}>
                    <input
                        id={`option-${definition.key}`}
                        className={styles.Range}
                        type="range"
                        min={definition.min ?? 0}
                        max={definition.max ?? 100}
                        step={definition.step ?? 1}
                        value={safeValue}
                        onChange={(event) => appOptions.set(app, key, Number(event.target.value))}
                    />
                    <output className={styles.NumberValue}>
                        {formatNumber(safeValue)}{definition.unit ? ` ${definition.unit}` : ""}
                    </output>
                </div>
            );
        }

        return (
            <div className={styles.NumberRow}>
                <input
                    id={`option-${definition.key}`}
                    className={styles.NumberInput}
                    type="number"
                    min={definition.min}
                    max={definition.max}
                    step={definition.step}
                    value={safeValue}
                    onChange={(event) => {
                        if (event.target.value.length === 0)
                            return;

                        const next = Number(event.target.value);
                        if (Number.isFinite(next))
                            appOptions.set(app, key, next);
                    }}
                />
                {definition.unit && <span className={styles.NumberValue}>{definition.unit}</span>}
            </div>
        );
    }

    return (
        <input
            id={`option-${definition.key}`}
            className={styles.TextInput}
            type="text"
            value={typeof value === "string" ? value : ""}
            onChange={(event) => appOptions.set(app, key, event.target.value)}
        />
    );
}

function OptionRow(props: OptionRowProps): React.ReactNode {
    const { definition } = props;
    const controlId = `option-${definition.key}`;

    return (
        <div className={styles.OptionRow}>
            <div className={styles.OptionText}>
                <label className={styles.OptionLabel} htmlFor={controlId}>
                    {definition.label}
                </label>
                {definition.description && (
                    <div className={styles.OptionDescription}>{definition.description}</div>
                )}
            </div>
            <div className={styles.OptionControl}>
                <OptionControl {...props} />
            </div>
        </div>
    );
}

export class OptionsPanel extends React.Component<AppProps, OptionsPanelState> {
    state: OptionsPanelState = {
        registrations: sortedRegistrations(),
        selectedApp: sortedRegistrations()[0]?.app,
    };

    private unsubscribeOptions: (() => void) | undefined;
    private unsubscribeApps: (() => void) | undefined;

    private refresh = (): void => {
        const registrations = sortedRegistrations();

        this.setState(previous => {
            const selectedApp = previous.selectedApp && registrations.some(entry => entry.app === previous.selectedApp)
                ? previous.selectedApp
                : registrations[0]?.app;

            return { registrations, selectedApp };
        });
    };

    private selectApp = (app: string): void => {
        this.setState({ selectedApp: app });
    };

    private isPresetActive(preset: AppOptionPreset, values: Readonly<Record<string, unknown>>): boolean {
        return Object.entries(preset.values).every(([key, value]) => values[key] === value);
    }

    componentDidMount(): void {
        this.unsubscribeOptions = appOptions.onDidChange(this.refresh);
        // Icons resolve after the first paint; re-render when the catalog updates.
        this.unsubscribeApps = appDirectory.onDidChange(this.refresh);
        this.refresh();
    }

    componentWillUnmount(): void {
        this.unsubscribeOptions?.();
        this.unsubscribeOptions = undefined;
        this.unsubscribeApps?.();
        this.unsubscribeApps = undefined;
    }

    private renderApp(registration: AppOptionsRegistration): React.ReactNode {
        const values = appOptions.getValues(registration.app);
        const presets = registration.presets ?? [];

        return (
            <>
                <header className={styles.Header}>
                    <h2 className={styles.Title}>{appTitle(registration)}</h2>
                    <button
                        type="button"
                        className={styles.ResetButton}
                        onClick={() => appOptions.reset(registration.app)}
                    >
                        Reset
                    </button>
                </header>

                {presets.length > 0 && (
                    <section className={styles.Presets}>
                        <div className={styles.SectionLabel}>Presets</div>
                        <div className={styles.PresetRow}>
                            {presets.map(preset => (
                                <button
                                    key={preset.id}
                                    type="button"
                                    title={preset.description}
                                    className={`${styles.PresetButton} ${this.isPresetActive(preset, values) ? styles.PresetButtonActive : ""}`}
                                    onClick={() => appOptions.apply(registration.app, preset.values)}
                                >
                                    {preset.label}
                                </button>
                            ))}
                        </div>
                    </section>
                )}

                <div className={styles.OptionsList}>
                    {registration.options.map(definition => (
                        <OptionRow
                            key={definition.key}
                            app={registration.app}
                            definition={definition}
                            value={values[definition.key]}
                        />
                    ))}
                </div>
            </>
        );
    }

    render(): React.ReactNode {
        const { registrations, selectedApp } = this.state;
        const selected = registrations.find(entry => entry.app === selectedApp) ?? registrations[0];

        return (
            <div className={styles.Panel}>
                <nav className={styles.Sidebar} aria-label="Apps">
                    <div className={styles.SidebarTitle}>Options</div>
                    {registrations.map(registration => {
                        const title = appTitle(registration);

                        return (
                            <button
                                key={registration.app}
                                type="button"
                                title={title}
                                aria-label={title}
                                className={`${styles.AppButton} ${registration.app === selected?.app ? styles.AppButtonSelected : ""}`}
                                onClick={() => this.selectApp(registration.app)}
                            >
                                <AppIcon registration={registration} />
                                <span className={styles.AppLabel}>{title}</span>
                            </button>
                        );
                    })}
                    {registrations.length === 0 && (
                        <div className={styles.SidebarEmpty}>No options</div>
                    )}
                </nav>

                <section className={styles.Content}>
                    {selected
                        ? this.renderApp(selected)
                        : (
                            <div className={styles.Empty}>
                                <div className={styles.EmptyTitle}>No app options yet</div>
                                <div className={styles.EmptyHint}>
                                    Apps register their options at startup; they appear here.
                                </div>
                            </div>
                        )}
                </section>
            </div>
        );
    }
}
