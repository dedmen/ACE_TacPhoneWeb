/**
 * Game-side marker protocol checks for the Map app.
 *
 * Run against a running game with the current TacPhone PBO loaded:
 *
 *   npm run test:map -- --scenario marker-protocol
 *
 * The scenario only uses the public request protocol (`a: "ACE_TacPhone_Map"`);
 * it never imports app or SQF source. Every marker it creates is deleted again.
 */

import { assert, equal, includes, isString, isType } from '../lib/assertions.mjs';
import { skip } from '../lib/skip.mjs';

export const name = 'marker-protocol';
export const kind = 'node';
export const description = 'Marker types/channels, custom RGBA colors, 256-char text clamp';

const MAP_APP = 'ACE_TacPhone_Map';
const MAX_MARKER_TEXT_LENGTH = 256;

/** Parses an Arma `#(r,g,b,a)` custom marker color. */
function parseCustomColor(value) {
    const match = /^#\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/.exec(value);
    if (!match) {
        return null;
    }

    return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] === undefined ? 1 : Number(match[4]),
    };
}

function near(actual, expected, tolerance, message) {
    assert(
        Math.abs(actual - expected) <= tolerance,
        `${message}\n  expected: ${expected} ± ${tolerance}\n  actual:   ${actual}`,
    );
}

/** rgb[4] from GetMarkerTypes as a CSS hex string (same conversion as the app). */
function colorToHex(rgba) {
    const [r, g, b, a] = rgba;
    const toHex = (value) => Math.round(Number(value) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}`;
}

async function getMarkers(client) {
    const reply = await client.request('GetAllMarkers', {}, { app: MAP_APP });
    isType(reply, 'object', 'GetAllMarkers must return an object');
    assert(Array.isArray(reply.markers), 'GetAllMarkers reply is missing the markers array');
    return reply.markers;
}

function findMarker(markers, markerName) {
    return markers.find((marker) => Array.isArray(marker) && marker[0] === markerName);
}

export async function run({ client, log }) {
    // A mission without the Map app cannot answer the marker requests.
    const available = await client.request('GetAvailableApps', {}, { app: 'main' }).catch(() => undefined);
    if (!available || !available[MAP_APP]) {
        skip(`The running mission does not serve the ${MAP_APP} app (old PBO?).`);
    }

    log?.('GetMarkerTypes');
    const config = await client.request('GetMarkerTypes', {}, { app: MAP_APP });
    isType(config, 'object', 'GetMarkerTypes must return an object');
    assert(Array.isArray(config.types), 'GetMarkerTypes reply is missing the types array');

    const flagNato = config.types.find((type) => Array.isArray(type) && type[0] === 'flag_NATO');
    assert(flagNato, 'CfgMarkers.flag_NATO is missing from GetMarkerTypes');

    const natoColor = flagNato[2];
    assert(Array.isArray(natoColor) && natoColor.length >= 3, 'flag_NATO must report a color[]');
    equal(colorToHex(natoColor), '#ffffffff', 'flag_NATO must default to white');
    log?.(`flag_NATO color ${JSON.stringify(natoColor)} -> ${colorToHex(natoColor)}`);

    const created = [];

    try {
        log?.('CreateMarker with the type default color');
        const createdReply = await client.request('CreateMarker', {
            marker: {
                shape: 'ICON',
                type: 'flag_NATO',
                color: 'Default',
                position: [0, 0],
                label: 'Test flag',
            },
        }, { app: MAP_APP });

        isType(createdReply, 'object', 'CreateMarker must return an object');
        isString(createdReply.name, 'CreateMarker did not return a marker name');
        assert(createdReply.name.length > 0, 'CreateMarker returned an empty marker name');
        created.push(createdReply.name);

        const markers = await getMarkers(client);
        const stored = findMarker(markers, createdReply.name);
        assert(stored, `GetAllMarkers does not contain the created marker ${createdReply.name}`);
        equal(stored[5], 'Test flag', 'The stored marker text does not match the request');

        log?.('CreateMarker with a 300-character label');
        const longLabel = 'x'.repeat(300);
        const longReply = await client.request('CreateMarker', {
            marker: {
                shape: 'ICON',
                type: 'flag_NATO',
                color: 'Default',
                position: [0, 0],
                label: longLabel,
            },
        }, { app: MAP_APP });
        isString(longReply.name, 'CreateMarker did not return a name for the long label');
        created.push(longReply.name);

        const afterLong = await getMarkers(client);
        const longStored = findMarker(afterLong, longReply.name);
        assert(longStored, 'GetAllMarkers does not contain the long-label marker');
        const storedText = longStored[5];
        isString(storedText, 'The stored marker text must be a string');
        assert(
            storedText.length <= MAX_MARKER_TEXT_LENGTH,
            `Marker text is not clamped to ${MAX_MARKER_TEXT_LENGTH} characters: got ${storedText.length}. ` +
                'Rebuild the PBO to pick up the fnc_createMarker.sqf clamp.',
        );
        equal(storedText.length, MAX_MARKER_TEXT_LENGTH, 'A 300-character label must be cut to exactly 256 characters');
        includes(storedText, longLabel.slice(0, 32), 'The clamped text must keep the original prefix');

        log?.('GetMarkerChannels');
        const channels = await client.request('GetMarkerChannels', {}, { app: MAP_APP });
        isType(channels, 'object', 'GetMarkerChannels must return an array');
        assert(Array.isArray(channels), 'GetMarkerChannels reply must be an array');
        for (const id of [0, 1, 3, 5]) {
            assert(
                channels.some((channel) => Array.isArray(channel) && channel[0] === id),
                `GetMarkerChannels is missing standard channel ${id}: ${JSON.stringify(channels)}`,
            );
        }
        assert(
            channels.every((channel) => Array.isArray(channel) && channel.length >= 4),
            'Every channel entry must be [id, label, custom, mapMarkersEnabled]',
        );

        // ---- custom RGBA colors (Arma 3 2.20+) -------------------------
        log?.('CreateMarker with a custom #(r,g,b,a) color');
        const customColor = '#(0.2,0.4,0.6,0.8)';
        const customReply = await client.request('CreateMarker', {
            marker: {
                shape: 'ICON',
                type: 'flag_NATO',
                color: customColor,
                position: [0, 0],
                label: 'Test custom color',
            },
        }, { app: MAP_APP });
        isString(customReply.name, 'CreateMarker did not return a name for the custom color');
        created.push(customReply.name);

        const customStored = findMarker(await getMarkers(client), customReply.name);
        assert(customStored, 'GetAllMarkers does not contain the custom-color marker');
        const storedCustom = parseCustomColor(customStored[2]);
        assert(storedCustom, `The game did not store the custom color as #(r,g,b,a): ${customStored[2]}`);
        near(storedCustom.r, 0.2, 0.01, 'Custom red component is wrong');
        near(storedCustom.g, 0.4, 0.01, 'Custom green component is wrong');
        near(storedCustom.b, 0.6, 0.01, 'Custom blue component is wrong');
        near(storedCustom.a, 0.8, 0.01, 'Custom alpha component is wrong');

        log?.('UpdateMarker with another custom color');
        const updatedColor = '#(1,0,1,0.35)';
        await client.request('CreateMarker', {
            marker: {
                name: customReply.name,
                color: updatedColor,
            },
        }, { app: MAP_APP });

        const updatedStored = findMarker(await getMarkers(client), customReply.name);
        assert(updatedStored, 'GetAllMarkers lost the marker after the color update');
        const parsedUpdated = parseCustomColor(updatedStored[2]);
        assert(parsedUpdated, `The updated color is not #(r,g,b,a): ${updatedStored[2]}`);
        near(parsedUpdated.r, 1, 0.01, 'Updated red component is wrong');
        near(parsedUpdated.g, 0, 0.01, 'Updated green component is wrong');
        near(parsedUpdated.b, 1, 0.01, 'Updated blue component is wrong');
        near(parsedUpdated.a, 0.35, 0.01, 'Updated alpha component is wrong');

        // ---- marker channels -------------------------------------------
        const gameInfo = await client.request('GetGameInfo', {}, { app: 'main' });
        if (gameInfo?.multiplayer === true) {
            log?.('CreateMarker on a non-default marker channel');
            const channelReply = await client.request('CreateMarker', {
                marker: {
                    shape: 'ICON',
                    type: 'flag_NATO',
                    color: 'Default',
                    position: [0, 0],
                    label: 'Test channel marker',
                    channel: 1,
                },
            }, { app: MAP_APP });
            isString(channelReply.name, 'CreateMarker did not return a name for the channel marker');
            created.push(channelReply.name);

            const channelStored = findMarker(await getMarkers(client), channelReply.name);
            assert(channelStored, 'GetAllMarkers does not contain the channel marker');
            equal(channelStored[10], 1, 'The marker was stored on the wrong chat channel');
        } else {
            console.log('  Skipping the marker channel round trip: the session is singleplayer');
        }
    } finally {
        for (const markerName of created) {
            await client.request('DeleteMarker', { marker: markerName }, { app: MAP_APP }).catch((error) => {
                log?.(`Could not delete test marker ${markerName}: ${error.message}`);
            });
        }
    }
}
