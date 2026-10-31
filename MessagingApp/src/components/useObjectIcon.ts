import { useEffect, useState } from 'react';

/**
 * Texture loading for chat object icons.
 *
 * `data:` and `http(s):` icons are used as-is; anything else is a game VFS path
 * and goes through `LoadGameFileTexture` once. Results (including failures) are
 * cached per path, so a long chat history does not re-request the same texture.
 */

const cache = new Map<string, string | undefined>();
const pending = new Map<string, Promise<string | undefined>>();

function isDirectUrl(icon: string): boolean {
    return icon.startsWith('data:') || /^https?:/i.test(icon);
}

/** Loads one icon URL; resolves undefined when the texture is unavailable. */
export function loadObjectIcon(icon: string | undefined): Promise<string | undefined> {
    if (!icon) return Promise.resolve(undefined);
    if (isDirectUrl(icon)) return Promise.resolve(icon);
    if (cache.has(icon)) return Promise.resolve(cache.get(icon));

    const inFlight = pending.get(icon);
    if (inFlight) return inFlight;

    const request = window.TacPhone.networking
        .LoadGameFileTexture(icon, 64)
        .then(url => {
            cache.set(icon, url);

            return url;
        })
        .catch(error => {
            console.warn(`Messaging: could not load the icon "${icon}":`, error);
            cache.set(icon, undefined);

            return undefined;
        })
        .finally(() => {
            pending.delete(icon);
        });

    pending.set(icon, request);

    return request;
}

/** Memoised async result of one icon path. */
interface LoadedIcon {
    icon: string;
    url: string | undefined;
}

/** Resolves a chat object icon to a displayable URL. */
export function useObjectIcon(icon: string | undefined): string | undefined {
    const [loaded, setLoaded] = useState<LoadedIcon | undefined>(undefined);

    useEffect(() => {
        if (!icon || isDirectUrl(icon) || cache.has(icon)) return;

        let active = true;
        void loadObjectIcon(icon).then(url => {
            if (active) setLoaded({ icon, url });
        });

        return () => {
            active = false;
        };
    }, [icon]);

    if (!icon) return undefined;
    if (isDirectUrl(icon)) return icon;

    // The cache is checked during render so a previously loaded texture never
    // flashes empty when a card remounts.
    const cached = cache.get(icon);
    if (cached !== undefined || cache.has(icon)) return cached;

    return loaded !== undefined && loaded.icon === icon ? loaded.url : undefined;
}
