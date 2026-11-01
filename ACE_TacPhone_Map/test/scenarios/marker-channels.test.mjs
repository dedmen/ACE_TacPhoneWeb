/**
 * Browser checks for multi-channel marker layers.
 *
 * Needs a multiplayer session: markers are created on two chat channels, then
 * the test drives the layer switcher and asserts the channel layers, the active
 * channel, the inactive-channel dimming and custom RGBA marker colors.
 *
 *   $env:TACPHONE_TEST_URL = 'http://localhost:5173/'
 *   npm run test:map -- --scenario marker-channels
 *
 * The rendered canvas cannot be asserted from the DOM, so the debug-only
 * `window.__TACPHONE_MAP_TEST__.getMapState()` hook reports the same channel
 * dimming and resolved colors that the OpenLayers style functions apply.
 */

import { assert, equal } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    colorToHex,
    createMarker,
    deleteMarker,
    findMarker,
    getAllMarkers,
    getMapState,
    getMapView,
    openMapPage,
    parseArmaColor,
    requestMap,
    waitForMapState,
    waitForMarkerGone,
    waitForMarkerInLayer,
} from '../lib/map-page.mjs';

export const name = 'marker-channels';
export const kind = 'browser';
export const description = 'Channel layers: visibility, custom RGBA; multiplayer adds active-channel dimming';

const INACTIVE_CHANNEL_ALPHA = 0.45;
const CUSTOM_COLOR = '#(0.2,0.4,0.6,0.8)';
const CUSTOM_COLOR_ALPHA = 0.8;

function near(actual, expected, tolerance, message) {
    assert(
        Math.abs(actual - expected) <= tolerance,
        `${message}\n  expected: ${expected} ± ${tolerance}\n  actual:   ${actual}`,
    );
}

/** Finds the layer-switcher row for a channel label and its control ids. */
async function findChannelRows(page, labels) {
    return page.evaluate((channelLabels) => {
        const rows = {};

        for (const label of document.querySelectorAll('label[for^="layer-"]')) {
            const text = label.textContent?.trim() ?? '';
            if (!channelLabels.includes(text)) {
                continue;
            }

            const row = label.closest('div');
            const checkbox = document.getElementById(label.getAttribute('for'));
            const radio = row?.querySelector('input[type="radio"]');

            if (checkbox) {
                rows[text] = {
                    checkboxId: label.getAttribute('for'),
                    radioLabel: radio?.getAttribute('aria-label') ?? null,
                };
            }
        }

        return rows;
    }, labels);
}

/** Logs a skipped check even when the suite is not running with --verbose. */
function noteSkip(log, message) {
    if (log) {
        log(message);
    } else {
        console.log(`  ${message}`);
    }
}

/** Shared single-channel checks: layer visibility, custom color, no dimming. */
async function runSingleChannelChecks(page, channel, log, created) {
    const view = await getMapView(page);
    assert(view, 'The Map view is not ready');
    const position = [view.x - view.resolution * 120, view.y - view.resolution * 80];

    const label = `TacPhone single channel ${Date.now()}`;
    const markerName = await createMarker(page, {
        shape: 'ICON',
        type: 'flag_NATO',
        color: CUSTOM_COLOR,
        position,
        label,
        channel: channel.id,
    });
    created.push(markerName);

    await waitForMarkerInLayer(page, markerName);
    const marker = (await getMapState(page)).markers.find((entry) => entry.name === markerName);
    assert(marker, 'The single-channel test marker is not in the Map layer');
    equal(marker.channel, channel.id, 'The single-channel marker used the wrong channel');
    equal(marker.layerVisible, true, 'The marker channel layer should start visible');
    equal(marker.dim, 1, 'Markers in a non-multiplayer or single-channel session must not be dimmed');
    equal(
        marker.resolvedColor,
        await page.evaluate((color) => window.__TACPHONE_MAP_TEST__.markerColorToCss(color), CUSTOM_COLOR),
        'The custom marker color did not resolve',
    );

    await page.getByTitle('Toggle Layers').click();
    const rows = await findChannelRows(page, [channel.label]);
    assert(rows[channel.label], `The layer switcher has no row for ${channel.label}`);
    const checkbox = page.locator(`input[id="${rows[channel.label].checkboxId}"]`);
    assert(await checkbox.isChecked(), `${channel.label} should start visible`);
    await checkbox.uncheck();
    await waitForMapState(
        page,
        (state) => state.markers.find((entry) => entry.name === markerName)?.layerVisible === false,
        `${channel.label} layer hidden`,
    );
    await checkbox.check();
    await waitForMapState(
        page,
        (state) => state.markers.find((entry) => entry.name === markerName)?.layerVisible === true,
        `${channel.label} layer visible again`,
    );

    log?.(`Single-channel layer and custom color checks passed for ${channel.label}.`);
}

export async function run({ pageUrl, options, log }) {
    const { browser, context, page, gameInfo, consoleErrors } = await openMapPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
        log,
    });    const created = [];

    try {
        if (!gameInfo.multiplayer) {
            // The channel split, the active-channel radio and inactive dimming
            // only exist in multiplayer. Still exercise the shared marker/color
            // path and the singleplayer Group layer.
            noteSkip(log, 'Singleplayer session: skipping the multiplayer-only checks (second channel, active-channel radio and inactive-channel dimming).');

            const singleState = await waitForMapState(
                page,
                (state) => state.channels.length > 0,
                'the singleplayer marker channel',
            );
            await runSingleChannelChecks(page, singleState.channels[0], log, created);
            equal(
                await page.getByRole('radio', { name: /active marker channel/ }).count(),
                0,
                'Singleplayer must not show the active-channel radio',
            );
            return;
        }

        const initialState = await waitForMapState(
            page,
            (state) => state.multiplayer && state.channels.length >= 2,
            'multiplayer marker channels',
        );

        const available = initialState.channels.filter((channel) => channel.available);
        if (available.length < 2) {
            noteSkip(
                log,
                `Skipping the multiplayer-only channel checks: only ${available.length} map-enabled channel(s) are available.`,
            );
            await runSingleChannelChecks(page, available[0] ?? initialState.channels[0], log, created);
            return;
        }

        const [channelA, channelB] = available;
        const view = await getMapView(page);
        assert(view, 'The Map view is not ready');
        const offsetX = view.resolution * 130;
        const offsetY = view.resolution * 90;
        const positionA = [view.x - offsetX, view.y - offsetY];
        const positionB = [view.x + offsetX, view.y + offsetY];
        const config = await requestMap(page, 'GetMarkerTypes');
        assert(Array.isArray(config?.colors), 'GetMarkerTypes did not return marker colors');

        const colorEntry = config.colors.find((color) => color[0] === 'ColorRed')
            ?? config.colors.find((color) => color[0] !== 'Default');
        assert(colorEntry, 'GetMarkerTypes returned no usable CfgMarkerColors entries');
        const classColor = colorToHex(colorEntry[2]);

        log?.(`Using channels ${channelA.id} (${channelA.label}) and ${channelB.id} (${channelB.label})`);

        // ---- create one marker per channel -----------------------------
        const stamp = Date.now();
        const labelA = `TacPhone channel A ${stamp}`;
        const labelB = `TacPhone channel B ${stamp}`;
        const nameA = await createMarker(page, {
            shape: 'ICON',
            type: 'flag_NATO',
            color: colorEntry[0],
            position: positionA,
            label: labelA,
            channel: channelA.id,
        });
        created.push(nameA);

        const nameB = await createMarker(page, {
            shape: 'ICON',
            type: 'flag_NATO',
            color: CUSTOM_COLOR,
            position: positionB,
            label: labelB,
            channel: channelB.id,
        });
        created.push(nameB);

        await waitForMarkerInLayer(page, nameA);
        await waitForMarkerInLayer(page, nameB);

        const createdState = await waitForMapState(
            page,
            (state) => (
                state.markers.some((marker) => marker.name === nameA)
                && state.markers.some((marker) => marker.name === nameB)
            ),
            'both channel markers in the Map layer',
        );

        const markerA = createdState.markers.find((marker) => marker.name === nameA);
        const markerB = createdState.markers.find((marker) => marker.name === nameB);

        equal(markerA.channel, channelA.id, 'The first marker was placed on the wrong channel');
        equal(markerB.channel, channelB.id, 'The second marker was placed on the wrong channel');
        equal(markerA.resolvedColor, classColor, 'The CfgMarkerColors class color did not resolve to its hex color');
        equal(
            markerA.labelColor,
            await page.evaluate((color) => window.__TACPHONE_MAP_TEST__.markerLabelColor(color), classColor),
            'The marker label did not use the resolved marker color',
        );

        // Custom RGBA colors arrive from the game as `#(r,g,b,a)` and must not be
        // mistaken for a CfgMarkerColors class name.
        const storedMarkers = await getAllMarkers(page);
        const storedB = findMarker(storedMarkers, nameB);
        assert(storedB, 'GetAllMarkers does not contain the custom-color marker');
        const storedCustom = parseArmaColor(storedB[2]);
        assert(storedCustom, `The game did not store the custom color as #(r,g,b,a): ${storedB[2]}`);
        near(storedCustom.r, 0.2, 0.01, 'Stored custom red component is wrong');
        near(storedCustom.g, 0.4, 0.01, 'Stored custom green component is wrong');
        near(storedCustom.b, 0.6, 0.01, 'Stored custom blue component is wrong');
        near(storedCustom.a, 0.8, 0.01, 'Stored custom alpha component is wrong');

        equal(
            markerB.resolvedColor,
            await page.evaluate((color) => window.__TACPHONE_MAP_TEST__.markerColorToCss(color), CUSTOM_COLOR),
            'The custom marker color did not resolve to the expected CSS rgba color',
        );
        equal(
            markerB.labelColor,
            await page.evaluate((color) => window.__TACPHONE_MAP_TEST__.markerLabelColor(color), markerB.resolvedColor),
            'The custom-color marker label did not use the resolved marker color',
        );

        // The custom alpha must fade the icon itself (and therefore its cloned
        // shadow), not be baked into the tint color where it would wash it out.
        await page.waitForFunction(
            (name) => {
                const marker = window.__TACPHONE_MAP_TEST__?.getMapState?.().markers
                    .find((entry) => entry.name === name);
                return marker !== undefined && Math.abs(marker.iconOpacity - marker.opacity) <= 1e-6;
            },
            nameB,
            { timeout: 5000 },
        );
        const renderedB = (await getMapState(page)).markers.find((marker) => marker.name === nameB);
        near(
            renderedB.iconOpacity,
            renderedB.alpha * renderedB.dim * storedCustom.a,
            1e-6,
            'The custom marker color alpha was not applied as icon opacity',
        );

        // ---- layer switcher: channel rows ------------------------------
        await page.getByTitle('Toggle Layers').click();
        const rows = await findChannelRows(page, [channelA.label, channelB.label]);
        assert(rows[channelA.label], `The layer switcher has no row for ${channelA.label}`);
        assert(rows[channelB.label], `The layer switcher has no row for ${channelB.label}`);

        const checkboxA = page.locator(`input[id="${rows[channelA.label].checkboxId}"]`);
        const checkboxB = page.locator(`input[id="${rows[channelB.label].checkboxId}"]`);
        assert(await checkboxA.isChecked(), `${channelA.label} should start visible`);
        assert(await checkboxB.isChecked(), `${channelB.label} should start visible`);

        // ---- hiding a channel layer ------------------------------------
        log?.(`Hiding ${channelB.label}`);
        await checkboxB.uncheck();
        await waitForMapState(
            page,
            (state) => state.markers.find((marker) => marker.name === nameB)?.layerVisible === false,
            `${channelB.label} layer hidden`,
        );
        const afterHide = await getMapState(page);
        equal(
            afterHide.markers.find((marker) => marker.name === nameA).layerVisible,
            true,
            `Hiding ${channelB.label} also hid ${channelA.label}`,
        );

        await checkboxB.check();
        await waitForMapState(
            page,
            (state) => state.markers.find((marker) => marker.name === nameB)?.layerVisible === true,
            `${channelB.label} layer visible again`,
        );

        await checkboxA.uncheck();
        await waitForMapState(
            page,
            (state) => state.markers.find((marker) => marker.name === nameA)?.layerVisible === false,
            `${channelA.label} layer hidden`,
        );
        await checkboxA.check();
        await waitForMapState(
            page,
            (state) => state.markers.find((marker) => marker.name === nameA)?.layerVisible === true,
            `${channelA.label} layer visible again`,
        );

        // ---- active channel dimming ------------------------------------
        log?.(`Making ${channelB.label} the active channel`);
        assert(rows[channelB.label].radioLabel, 'The active-channel radio has no accessible label');
        await page.getByRole('radio', { name: rows[channelB.label].radioLabel }).check();
        await waitForMapState(
            page,
            (state) => state.activeChannel === channelB.id,
            `${channelB.label} active channel`,
        );

        // A radio click closes the layer switcher through the map's mousedown
        // handler in some layouts; reopen it for the label assertion.
        if (await page.locator('input[id^="layer-"]').count() === 0) {
            await page.getByTitle('Toggle Layers').click();
        }
        await page.getByText(`Active: ${channelB.label}`, { exact: true }).waitFor({ state: 'visible', timeout: 5000 });

        const activeState = await getMapState(page);
        const activeA = activeState.markers.find((marker) => marker.name === nameA);
        const activeB = activeState.markers.find((marker) => marker.name === nameB);
        equal(activeB.dim, 1, 'The active channel must not be dimmed');
        equal(activeA.dim, INACTIVE_CHANNEL_ALPHA, 'An inactive channel must be dimmed to 45%');
        equal(activeA.layerVisible, true, 'Dimming must not hide the inactive channel layer');
        near(activeA.opacity, activeA.alpha * INACTIVE_CHANNEL_ALPHA, 1e-6, 'Inactive marker opacity is wrong');
        near(
            activeB.opacity,
            activeB.alpha * CUSTOM_COLOR_ALPHA,
            1e-6,
            'The active custom-color marker opacity is wrong',
        );

        // Switching back restores full opacity on A and dims the custom marker.
        await page.getByRole('radio', { name: rows[channelA.label].radioLabel }).check();
        await waitForMapState(page, (state) => state.activeChannel === channelA.id, `${channelA.label} active channel again`);
        const switchedBack = await getMapState(page);
        equal(
            switchedBack.markers.find((marker) => marker.name === nameA).dim,
            1,
            'Switching the active channel back did not restore the marker opacity',
        );
        const dimmedB = switchedBack.markers.find((marker) => marker.name === nameB);
        equal(dimmedB.dim, INACTIVE_CHANNEL_ALPHA, 'The custom marker channel should be dimmed while inactive');
        near(
            dimmedB.opacity,
            dimmedB.alpha * INACTIVE_CHANNEL_ALPHA * CUSTOM_COLOR_ALPHA,
            1e-6,
            'Dimming did not multiply the custom color alpha',
        );

        log?.('Channel layer visibility and dimming are correct');

        if (consoleErrors.length > 0) {
            throw new Error(`The Map page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        for (const markerName of created) {
            await deleteMarker(page, markerName);
            await waitForMarkerGone(page, markerName).catch(() => {});
        }

        await page.close();
        await context.close();
        await browser.close();
    }
}
