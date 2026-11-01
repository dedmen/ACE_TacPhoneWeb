// Per-app options registry exposed as `window.TacPhone.options`.
//
// Apps register the options they expose from their init(); the host Options
// panel renders them. Values are page-local overrides: a missing value means
// "use the definition default", so changing a default later still reaches users
// who never touched that option.
//
// Persistence is deliberately not part of this module. `App.tsx` owns the saved
// layout envelope and writes `toJson()` / reads `load()` from it.

import type {
    AppOptionChange,
    AppOptionChoice,
    AppOptionDefinition,
    AppOptionKind,
    AppOptionPreset,
    AppOptionsApi,
    AppOptionsRegistration,
} from "@ace-tacphone/api";

type OptionValue = string | number | boolean;
type OptionValues = Map<string, OptionValue>;
type StoredOptions = Record<string, Record<string, OptionValue>>;

interface RegisteredApp {
    registration: AppOptionsRegistration;
    definitions: Map<string, AppOptionDefinition>;
}

const OPTION_KINDS: readonly AppOptionKind[] = ["boolean", "number", "select", "text"];
const NOOP = (): void => undefined;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionValue(value: unknown): value is OptionValue {
    return typeof value === "string"
        || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Validates and normalises a raw value for one definition. Returns undefined for
 * values the widget could not have produced.
 */
function coerceValue(definition: AppOptionDefinition, raw: unknown): OptionValue | undefined {
    switch (definition.type) {
        case "boolean":
            return typeof raw === "boolean" ? raw : undefined;

        case "text":
            return typeof raw === "string" ? raw : undefined;

        case "number": {
            const number = typeof raw === "number"
                ? raw
                : typeof raw === "string" && raw.trim().length > 0
                    ? Number(raw)
                    : Number.NaN;

            if (!Number.isFinite(number))
                return undefined;

            let value = number;

            if (typeof definition.min === "number" && Number.isFinite(definition.min))
                value = Math.max(definition.min, value);

            if (typeof definition.max === "number" && Number.isFinite(definition.max))
                value = Math.min(definition.max, value);

            return value;
        }

        case "select": {
            const choices = definition.choices ?? [];
            const match = choices.find(choice => choice.value === raw || String(choice.value) === String(raw));
            return match?.value;
        }

        default:
            return undefined;
    }
}

function normalizeChoices(raw: unknown): AppOptionChoice[] | undefined {
    if (!Array.isArray(raw))
        return undefined;

    const choices: AppOptionChoice[] = [];
    const seen = new Set<string>();

    for (const entry of raw) {
        if (!isPlainObject(entry))
            continue;

        const { label, value } = entry;
        if (typeof label !== "string" || label.length === 0 || !isOptionValue(value))
            continue;

        const key = `${typeof value}:${String(value)}`;
        if (seen.has(key))
            continue;

        seen.add(key);
        choices.push({ label, value });
    }

    return choices.length > 0 ? choices : undefined;
}

/** Returns a validated definition, or undefined when the app registered garbage. */
function normalizeDefinition(raw: unknown, app: string, index: number): AppOptionDefinition | undefined {
    if (!isPlainObject(raw)) {
        console.warn(`TacPhone app "${app}" option at index ${index} is not an object.`);
        return undefined;
    }

    const { key, label, type, default: defaultValue } = raw;

    if (typeof key !== "string" || key.length === 0) {
        console.warn(`TacPhone app "${app}" option at index ${index} has no valid key.`);
        return undefined;
    }

    if (typeof label !== "string" || label.length === 0) {
        console.warn(`TacPhone app "${app}" option "${key}" has no valid label.`);
        return undefined;
    }

    if (typeof type !== "string" || !(OPTION_KINDS as readonly string[]).includes(type)) {
        console.warn(`TacPhone app "${app}" option "${key}" has an invalid type "${String(type)}".`);
        return undefined;
    }

    const definition: AppOptionDefinition = {
        key,
        label,
        type: type as AppOptionKind,
        default: defaultValue as string | number | boolean,
    };

    if (typeof raw.description === "string")
        definition.description = raw.description;

    if (typeof raw.min === "number" && Number.isFinite(raw.min))
        definition.min = raw.min;

    if (typeof raw.max === "number" && Number.isFinite(raw.max))
        definition.max = raw.max;

    if (typeof raw.step === "number" && Number.isFinite(raw.step) && raw.step > 0)
        definition.step = raw.step;

    if (typeof raw.unit === "string")
        definition.unit = raw.unit;

    if (definition.type === "select") {
        const choices = normalizeChoices(raw.choices);
        if (!choices) {
            console.warn(`TacPhone app "${app}" select option "${key}" has no valid choices.`);
            return undefined;
        }

        definition.choices = choices;
    }

    if (coerceValue(definition, definition.default) === undefined) {
        console.warn(`TacPhone app "${app}" option "${key}" has an invalid default value.`);
        return undefined;
    }

    // Normalise the default itself, e.g. "1" to the matching number choice.
    definition.default = coerceValue(definition, definition.default)!;

    return definition;
}

function normalizePresets(
    raw: unknown,
    app: string,
    definitions: ReadonlyMap<string, AppOptionDefinition>,
): AppOptionPreset[] {
    if (!Array.isArray(raw))
        return [];

    const presets: AppOptionPreset[] = [];
    const seen = new Set<string>();

    for (const entry of raw) {
        if (!isPlainObject(entry))
            continue;

        const { id, label } = entry;
        if (typeof id !== "string" || id.length === 0 || seen.has(id))
            continue;

        if (typeof label !== "string" || label.length === 0)
            continue;

        if (!isPlainObject(entry.values))
            continue;

        const values: Record<string, OptionValue> = {};

        for (const [key, value] of Object.entries(entry.values)) {
            const definition = definitions.get(key);
            if (!definition) {
                console.warn(`TacPhone app "${app}" preset "${id}" references unknown option "${key}".`);
                continue;
            }

            const coerced = coerceValue(definition, value);
            if (coerced === undefined) {
                console.warn(`TacPhone app "${app}" preset "${id}" has an invalid value for "${key}".`);
                continue;
            }

            values[key] = coerced;
        }

        if (Object.keys(values).length === 0)
            continue;

        seen.add(id);
        presets.push({
            id,
            label,
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            values,
        });
    }

    return presets;
}

export class AppOptionsStore implements AppOptionsApi {
    private readonly registrations = new Map<string, RegisteredApp>();
    private values = new Map<string, OptionValues>();
    private readonly listeners = new Set<(change: AppOptionChange) => void>();

    /**
     * Registers or replaces one app's option schema. Values already stored for
     * the app are kept, so an app reload does not reset user choices.
     */
    register(registration: AppOptionsRegistration): () => void {
        if (!isPlainObject(registration) || typeof registration.app !== "string" || registration.app.length === 0) {
            console.warn("TacPhone options registration is missing a valid app name.");
            return NOOP;
        }

        if (!Array.isArray(registration.options)) {
            console.warn(`TacPhone app "${registration.app}" options registration has no options array.`);
            return NOOP;
        }

        const definitions = new Map<string, AppOptionDefinition>();
        const options: AppOptionDefinition[] = [];

        registration.options.forEach((raw, index) => {
            const definition = normalizeDefinition(raw, registration.app, index);
            if (!definition)
                return;

            if (definitions.has(definition.key)) {
                console.warn(`TacPhone app "${registration.app}" defines option "${definition.key}" twice; keeping the first one.`);
                return;
            }

            definitions.set(definition.key, definition);
            options.push(definition);
        });

        if (options.length === 0) {
            console.warn(`TacPhone app "${registration.app}" registered no valid options.`);
            return NOOP;
        }

        const normalized: AppOptionsRegistration = {
            app: registration.app,
            options,
            ...(typeof registration.title === "string" ? { title: registration.title } : {}),
            ...(typeof registration.icon === "string" ? { icon: registration.icon } : {}),
        };

        const presets = normalizePresets(registration.presets, registration.app, definitions);
        if (presets.length > 0)
            normalized.presets = presets;

        this.registrations.set(registration.app, { registration: normalized, definitions });
        this.notify({ app: registration.app });

        let active = true;
        return () => {
            if (!active)
                return;

            active = false;
            const current = this.registrations.get(registration.app);
            if (current?.registration !== normalized)
                return;

            this.registrations.delete(registration.app);
            this.notify({ app: registration.app });
        };
    }

    get<T = unknown>(app: string, key: string): T | undefined {
        const definition = this.registrations.get(app)?.definitions.get(key);
        if (!definition)
            return undefined;

        const override = this.values.get(app)?.get(key);
        if (override === undefined)
            return definition.default as T;

        return (coerceValue(definition, override) ?? definition.default) as T;
    }

    set(app: string, key: string, value: unknown): void {
        const definition = this.registrations.get(app)?.definitions.get(key);
        if (!definition) {
            console.warn(`TacPhone cannot set unknown option "${app}/${key}".`);
            return;
        }

        const coerced = coerceValue(definition, value);
        if (coerced === undefined) {
            console.warn(`TacPhone rejected the value of option "${app}/${key}".`);
            return;
        }

        this.writeValue(app, key, definition, coerced);
        this.notify({ app, key, value: coerced });
    }

    apply(app: string, values: Readonly<Record<string, unknown>>): void {
        const registered = this.registrations.get(app);
        if (!registered || !isPlainObject(values))
            return;

        let changed = false;

        for (const [key, raw] of Object.entries(values)) {
            const definition = registered.definitions.get(key);
            if (!definition) {
                console.warn(`TacPhone preset references unknown option "${app}/${key}".`);
                continue;
            }

            const coerced = coerceValue(definition, raw);
            if (coerced === undefined) {
                console.warn(`TacPhone preset has an invalid value for "${app}/${key}".`);
                continue;
            }

            this.writeValue(app, key, definition, coerced);
            changed = true;
        }

        if (changed)
            this.notify({ app });
    }

    getValues(app: string): Readonly<Record<string, unknown>> {
        const registered = this.registrations.get(app);
        if (!registered)
            return {};

        const values: Record<string, unknown> = {};
        for (const key of registered.definitions.keys())
            values[key] = this.get(app, key);

        return values;
    }

    list(): readonly AppOptionsRegistration[] {
        return [...this.registrations.values()].map(entry => entry.registration);
    }

    reset(app: string, key?: string): void {
        if (key === undefined) {
            if (this.values.delete(app))
                this.notify({ app });
            return;
        }

        const values = this.values.get(app);
        if (!values?.delete(key))
            return;

        if (values.size === 0)
            this.values.delete(app);

        this.notify({ app, key });
    }

    onDidChange(listener: (change: AppOptionChange) => void): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Replaces every stored override from a saved layout. Host-only: values of
     * apps that are not installed are kept as-is so they survive a reload.
     */
    load(raw: unknown): void {
        const next = new Map<string, OptionValues>();

        if (isPlainObject(raw)) {
            for (const [app, appValues] of Object.entries(raw)) {
                if (!isPlainObject(appValues))
                    continue;

                const values: OptionValues = new Map();
                for (const [key, value] of Object.entries(appValues)) {
                    if (isOptionValue(value))
                        values.set(key, value);
                }

                if (values.size > 0)
                    next.set(app, values);
            }
        }

        const affected = new Set([...this.values.keys(), ...next.keys()]);
        this.values = next;

        for (const app of affected)
            this.notify({ app });
    }

    /** Serialises every override for the saved layout envelope. Host-only. */
    toJson(): StoredOptions {
        const json: StoredOptions = {};

        for (const [app, values] of this.values) {
            if (values.size === 0)
                continue;

            json[app] = Object.fromEntries(values);
        }

        return json;
    }

    private writeValue(app: string, key: string, definition: AppOptionDefinition, value: OptionValue): void {
        let values = this.values.get(app);

        if (value === definition.default) {
            if (!values)
                return;

            values.delete(key);
            if (values.size === 0)
                this.values.delete(app);

            return;
        }

        if (!values) {
            values = new Map();
            this.values.set(app, values);
        }

        values.set(key, value);
    }

    private notify(change: AppOptionChange): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(change);
            } catch (error) {
                console.error("TacPhone options listener failed:", error);
            }
        }
    }
}

/** The one options registry of this page. */
export const appOptions = new AppOptionsStore();
