/**
 * Verifies the game-side localization bridge.
 *
 * The host bundles the whole stringtable into the page at build time (HEMTT
 * ships only stringtable.bin, so the XML file is not readable in-game). The
 * game side therefore only reports language/path and answers the on-demand
 * fallback; this checks both.
 */

import { assert, hasKeys, isArray, isObject, isString } from '../lib/assertions.mjs';

export const name = 'localization';
export const description = 'Localization.Info/Get';

export async function run({ client }) {
    const info = await client.request('Localization.Info');

    isObject(info, 'Localization.Info must return an object');
    hasKeys(info, ['language', 'stringtable'], 'Localization.Info is missing fields');
    isString(info.language, 'Localization.Info.language must be a string');
    isString(info.stringtable, 'Localization.Info.stringtable must be a string');
    assert(info.language.length > 0, 'Localization.Info.language is empty');
    assert(info.stringtable.length > 0, 'Localization.Info.stringtable is empty');
    assert(/stringtable\.xml$/i.test(info.stringtable), 'Localization.Info.stringtable must point at a stringtable.xml');

    // The runtime XML file load is disabled while HEMTT ships stringtable.bin;
    // the bundled table covers the host's own keys. Base-game/external keys go
    // through Localization.Get below.
    const keys = ['STR_ACE_Tacphone_tacphoneDisplayName', 'STR_ACE_Tacphone_openPhoneKey'];
    const strings = await client.request('Localization.Get', { keys });

    isObject(strings, 'Localization.Get must return an object');
    for (const key of keys) {
        isString(strings[key], `Localization.Get is missing "${key}"`);
        assert(strings[key].length > 0, `Localization.Get returned an empty string for "${key}"`);
    }

    // The game side must cap a batch at 100 keys; ask for more than it accepts.
    const tooMany = Array.from({ length: 150 }, (_, index) => `STR_ACE_Tacphone_missing_${index}`);
    const capped = await client.request('Localization.Get', { keys: tooMany });

    isObject(capped, 'Localization.Get must return an object even when every key is unknown');
    assert(!Array.isArray(capped), 'Localization.Get returned an array instead of a map');
    assert(Object.keys(capped).length <= 100, 'Localization.Get did not cap the batch at 100 keys');

    // A non-array must not break the handler.
    const malformed = await client.request('Localization.Get', { keys: 'not-an-array' });
    isObject(malformed, 'Localization.Get must tolerate a non-array keys field');
    isArray(Object.keys(malformed), 'malformed Localization.Get result must still be a map');
}
