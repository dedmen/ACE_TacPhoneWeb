import { t } from '../i18n';
/**
 * Marker channel model shared by the Map's marker layers, dialog and layer
 * switcher.
 *
 * Channel IDs are Arma's chat channel IDs. Standard channels are 0..5; custom
 * channels are the radio-channel IDs 6..15 and 26..65. Only custom channels
 * that are actually in use are returned by the game.
 */

export const SINGLEPLAYER_CHANNEL = 3;
export const DEFAULT_MULTIPLAYER_CHANNEL = 0;

/** Global, Side, Group and Direct stay listed even when they have no markers. */
export const ALWAYS_VISIBLE_CHANNELS: ReadonlySet<number> = new Set([0, 1, 3, 5]);

export const INACTIVE_CHANNEL_ALPHA = 0.45;

export interface MarkerChannel {
    id: number;
    label: string;
    custom: boolean;
    mapMarkersEnabled: boolean;
}

/** Built-in channel labels 0..5, in channel order. */
function standardLabels(): readonly string[] {
    return [
        t('str_channel_global'),
        t('str_channel_side'),
        t('str_channel_command'),
        t('str_channel_group'),
        t('str_channel_vehicle'),
        t('str_channel_direct'),
    ];
}

/** Built-in channels 0..5. */
export function standardMarkerChannels(): readonly MarkerChannel[] {
    return standardLabels().map(
        (label, id) => ({
            id,
            label,
            custom: false,
            mapMarkersEnabled: true,
        }),
    );
}

/** Fallback used when the game channel request fails or returns invalid data. */
export function fallbackMarkerChannels(): MarkerChannel[] {
    return standardMarkerChannels().map((channel) => ({ ...channel }));
}

/**
 * Parses the `GetMarkerChannels` reply:
 * `[[id, label, custom, mapMarkersEnabled], ...]`.
 *
 * Invalid entries are ignored, duplicate IDs keep the first entry, and empty or
 * malformed replies fall back to the standard channels.
 */
export function parseMarkerChannels(value: unknown): MarkerChannel[] {
    if (!Array.isArray(value)) {
        return fallbackMarkerChannels();
    }

    const seen = new Set<number>();
    const channels: MarkerChannel[] = [];

    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length < 2) {
            continue;
        }

        const id = Number(entry[0]);
        if (!Number.isInteger(id) || id < 0 || seen.has(id)) {
            continue;
        }

        const label = typeof entry[1] === 'string' && entry[1].trim() !== ''
            ? entry[1]
            : t('STR_ACE_Tacphone_Map_Channel_Number', id);
        const custom = entry[2] === true || (typeof entry[2] === 'number' && entry[2] !== 0);
        const mapMarkersEnabled = entry[3] !== false;

        seen.add(id);
        channels.push({ id, label, custom, mapMarkersEnabled });
    }

    if (channels.length === 0) {
        return fallbackMarkerChannels();
    }

    channels.sort((left, right) => left.id - right.id);
    return channels;
}

export function getChannelLabel(channels: readonly MarkerChannel[], id: number): string {
    return channels.find((channel) => channel.id === id)?.label ?? t('STR_ACE_Tacphone_Map_Channel_Number', id);
}

export function isChannelAvailable(channel: MarkerChannel | undefined): channel is MarkerChannel {
    return channel !== undefined && channel.mapMarkersEnabled;
}

/** Convert a game marker direction (usually 0..360) to the slider range. */
export function normalizeDirectionForDialog(degrees: number): number {
    if (!Number.isFinite(degrees)) {
        return 0;
    }

    let normalized = ((degrees % 360) + 360) % 360;
    if (normalized > 180) {
        normalized -= 360;
    }

    return normalized;
}

/** Convert the -180..180 slider value to the 0..360 value sent to the game. */
export function normalizeDirectionForGame(degrees: number): number {
    if (!Number.isFinite(degrees)) {
        return 0;
    }

    return ((degrees % 360) + 360) % 360;
}
