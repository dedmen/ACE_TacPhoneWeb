/**
 * Browser checks for the Map marker dialog and the portaled SelectMenu.
 *
 * Needs the TacPhone host page (dev server or the in-game page) and Arma with
 * the current TacPhone PBO. The assertions use DOM state, attributes, geometry
 * and `getComputedStyle()` only: no screenshots and no image analysis.
 *
 *   $env:TACPHONE_TEST_URL = 'http://localhost:5173/'
 *   npm run test:map -- --scenario marker-ui
 */

import { assert, deepEqual, equal, isType } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { openMapPage, parseArmaColor } from '../lib/map-page.mjs';

export const name = 'marker-ui';
export const kind = 'browser';
export const description = 'Marker dialog placement/scrollbar, SelectMenu portal/search, colors, text clamp';

const DIALOG = '[data-testid="marker-create-dialog"]';
const TYPE_TRIGGER = '[data-testid="marker-type-select"]';
const TYPE_MENU = '[data-testid="marker-type-select-menu"]';
const CHANNEL_TRIGGER = '[data-testid="marker-channel-select"]';
const CHANNEL_MENU = '[data-testid="marker-channel-select-menu"]';
const COLOR_PICKER = '[data-testid="marker-color-picker"]';
const COLOR_SWATCH = '[data-testid="marker-color-swatch"]';
const CUSTOM_SWATCH = '[data-testid="marker-color-custom"]';
const CUSTOM_INPUT = '[data-testid="marker-color-custom-input"]';
const CUSTOM_ALPHA = '[data-testid="marker-color-custom-alpha"]';
const CUSTOM_POPOVER = '[data-testid="marker-color-custom-popover"]';
const SEARCH_INPUT = '[data-testid="select-menu-search"]';
const POLYLINE_PICKER = '[data-testid="polyline-color-picker"]';
const MAX_MARKER_TEXT_LENGTH = 256;

/** Sets a native input value through the prototype setter so React sees it. */
async function setNativeInputValue(page, selector, value) {
    await page.evaluate(({ target, next }) => {
        const input = document.querySelector(target);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!input || !setter) {
            throw new Error(`Input ${target} is missing`);
        }

        setter.call(input, next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { target: selector, next: value });
}

async function measureDialog(page) {
    return page.locator(DIALOG).evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollTop: element.scrollTop,
        rect: element.getBoundingClientRect().toJSON(),
    }));
}

async function getAllGameMarkers(page) {
    const reply = await page.evaluate(() => window.TacPhone.networking.Request({
        a: 'ACE_TacPhone_Map',
        c: 'GetAllMarkers',
    }));

    return reply?.markers ?? [];
}

/** Waits until GetAllMarkers contains an icon marker with this label. */
async function waitForGameMarker(page, label, timeout = 15000) {    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
        const reply = await page.evaluate(() => window.TacPhone.networking.Request({
            a: 'ACE_TacPhone_Map',
            c: 'GetAllMarkers',
        }));
        const marker = reply?.markers?.find((entry) => Array.isArray(entry) && entry[5] === label);
        if (marker) {
            return marker;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`The game did not store the UI marker "${label}" within ${timeout} ms`);
}

async function openCreateDialog(page, log, at = { x: 0.4, y: 0.4 }) {
    const viewport = page.locator('.ol-viewport').first();
    const box = await viewport.boundingBox();
    assert(box, 'The OpenLayers viewport has no layout box');

    // A point away from the centre avoids most existing markers.
    await viewport.dblclick({
        position: { x: Math.round(box.width * at.x), y: Math.round(box.height * at.y) },
    });
    await page.locator(DIALOG).waitFor({ state: 'visible', timeout: 10000 });
    // Marker types/colors arrive asynchronously; the trigger is disabled until then.
    await page.waitForFunction(
        (selector) => {
            const button = document.querySelector(selector);
            return Boolean(button) && button.disabled === false;
        },
        TYPE_TRIGGER,
        { timeout: 15000 },
    );

    log?.('create dialog open');
    await assertNoDialogScrollbar(page, 'create dialog');
}

/** Opens the type menu, searches for one class and selects it. */
async function selectMarkerType(page, className) {
    await page.locator(TYPE_TRIGGER).click();
    await page.locator(TYPE_MENU).waitFor({ state: 'visible', timeout: 5000 });
    await page.locator(SEARCH_INPUT).fill(className);
    const option = page.locator(`[data-testid="select-menu-option-${className}"]`);
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click();
    await page.locator(TYPE_MENU).waitFor({ state: 'detached', timeout: 5000 });
}

/** Shared assertions for a portaled menu. */
async function assertPortaledMenu(page, menuSelector, before, label) {
    const menu = page.locator(menuSelector);
    await menu.waitFor({ state: 'visible', timeout: 5000 });

    const info = await menu.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
            parentIsBody: element.parentElement === document.body,
            insideDialog: Boolean(element.closest('[data-testid="marker-create-dialog"]')),
            position: style.position,
            zIndex: Number(style.zIndex) || 0,
            dropdownAttribute: element.hasAttribute('data-dropdown-menu'),
        };
    });

    assert(info.parentIsBody, `${label}: the menu must be a child of document.body`);
    assert(!info.insideDialog, `${label}: the menu must not live inside the marker dialog`);
    equal(info.position, 'fixed', `${label}: the menu must use position: fixed`);
    assert(info.dropdownAttribute, `${label}: the menu must carry data-dropdown-menu`);

    const after = await measureDialog(page);
    const dialogZ = await page.locator(DIALOG).evaluate((element) => Number(getComputedStyle(element).zIndex) || 0);

    equal(after.scrollHeight, before.scrollHeight, `${label}: opening the menu changed the dialog scrollHeight`);
    equal(after.clientHeight, before.clientHeight, `${label}: opening the menu changed the dialog clientHeight`);
    equal(after.scrollTop, 0, `${label}: opening the menu scrolled the dialog`);
    assert(info.zIndex > dialogZ, `${label}: menu z-index ${info.zIndex} must be above the dialog z-index ${dialogZ}`);

    return menu;
}

async function assertNoDialogScrollbar(page, label) {
    const measured = await measureDialog(page);
    if (measured.clientHeight < 400) {
        // Small phone-height panels legitimately scroll.
        return;
    }

    assert(
        measured.scrollHeight <= measured.clientHeight + 1,
        `${label}: the dialog has a scrollbar (scrollHeight ${measured.scrollHeight} > clientHeight ${measured.clientHeight})`,
    );
}

/**
 * Regression guard for the old inline select: the Options panel must not grow
 * or push its following rows down when a select menu opens.
 */
async function checkOptionsPanelSelect(page, log) {
    const opened = await page.evaluate(() => Boolean(window.TacPhone.panels.open('ACE_TacPhone_Options', {
        placement: 'tab',
        select: true,
    })));

    if (!opened) {
        log?.('Options panel is not available; skipping the Options select check');
        return;
    }

    const mapEntry = page
        .getByRole('navigation', { name: 'Apps' })
        .getByRole('button', { name: 'Map', exact: true })
        .first();
    if (await mapEntry.count() > 0) {
        await mapEntry.click();
    }

    const trigger = page.locator('#option-terrainQuality');
    if (await trigger.count() === 0) {
        log?.('Map options are not registered; skipping the Options select check');
        return;
    }

    await trigger.waitFor({ state: 'visible', timeout: 5000 });

    // Every option control's viewport geometry: opening the menu must not move them.
    const snapshot = () => page.evaluate(() => (
        [...document.querySelectorAll('[id^="option-"]:not([role="listbox"])')].map((element) => {
            const rect = element.getBoundingClientRect();
            return [element.id, Math.round(rect.top * 100) / 100, Math.round(rect.height * 100) / 100];
        })
    ));

    const before = await snapshot();
    await trigger.click();

    const menu = page.locator('#option-terrainQuality-menu');
    await menu.waitFor({ state: 'visible', timeout: 5000 });

    const info = await menu.evaluate((element) => ({
        parentIsBody: element.parentElement === document.body,
        position: getComputedStyle(element).position,
        zIndex: Number(getComputedStyle(element).zIndex) || 0,
    }));

    assert(info.parentIsBody, 'Options: the select menu must be a child of document.body');
    equal(info.position, 'fixed', 'Options: the select menu must use position: fixed');
    assert(info.zIndex >= 4000, `Options: the select menu z-index must be above the panels, got ${info.zIndex}`);

    const after = await snapshot();
    deepEqual(after, before, 'Options: opening a select menu moved the option rows');

    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached', timeout: 5000 });
}

/**
 * Regression guard for menus opened near the viewport bottom: the fixed menu
 * must flip above the trigger instead of overflowing off-screen.
 */
async function checkSelectMenuOpensUpwards(page, log) {
    await page.evaluate(async () => {
        const React = await import('react').catch(() => window.TacPhone.modules?.get('react'));
        const client = await import('react-dom/client').catch(() => window.TacPhone.modules?.get('react-dom/client'));

        if (!React || !client) {
            throw new Error('Could not load the host React modules for the SelectMenu test');
        }

        document.getElementById('select-up-test')?.remove();
        const host = document.createElement('div');
        host.id = 'select-up-test';
        host.style.cssText = 'position:fixed;left:20px;bottom:12px;width:200px;padding:4px;background:#222;z-index:5000';
        document.body.appendChild(host);

        const root = client.createRoot(host);
        window.__selectUpTestRoot = root;
        root.render(React.createElement(window.TacPhone.components.SelectMenu, {
            id: 'select-up-test-trigger',
            value: 0,
            options: [{ value: 0, label: 'One' }, { value: 1, label: 'Two' }],
            onChange: () => {},
        }));

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });

    const trigger = page.locator('#select-up-test-trigger');
    await trigger.click();
    const menu = page.locator('#select-up-test-trigger-menu');
    await menu.waitFor({ state: 'visible', timeout: 5000 });

    const geometry = await page.evaluate(() => {
        const triggerRect = document.getElementById('select-up-test-trigger').getBoundingClientRect();
        const menuRect = document.querySelector('#select-up-test-trigger-menu').getBoundingClientRect();
        return {
            triggerTop: triggerRect.top,
            triggerBottom: triggerRect.bottom,
            menuTop: menuRect.top,
            menuBottom: menuRect.bottom,
        };
    });

    assert(
        geometry.menuBottom <= geometry.triggerTop + 2,
        `A SelectMenu near the viewport bottom did not open upwards: menu bottom ${geometry.menuBottom}, trigger top ${geometry.triggerTop}`,
    );
    assert(
        geometry.menuTop < geometry.triggerTop,
        `A SelectMenu near the viewport bottom opened below the trigger: menu top ${geometry.menuTop}, trigger top ${geometry.triggerTop}`,
    );

    await page.keyboard.press('Escape');
    await page.evaluate(() => {
        window.__selectUpTestRoot?.unmount();
        document.getElementById('select-up-test')?.remove();
    });
    log?.('SelectMenu opened upwards near the viewport bottom');
}

export async function run({ pageUrl, options, log }) {
    const { browser, page, consoleErrors } = await openMapPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
        log,
    });

    try {
        // ---- dropdown scrollbar / portal --------------------------------
        await openCreateDialog(page, log);
        const before = await measureDialog(page);

        await page.locator(TYPE_TRIGGER).click();
        await assertPortaledMenu(page, TYPE_MENU, before, 'type menu');

        // ---- search focus, border and scrolling -----------------------
        await page.waitForFunction(
            (selector) => document.activeElement === document.querySelector(selector),
            SEARCH_INPUT,
            { timeout: 5000 },
        );
        const searchStyle = await page.locator(SEARCH_INPUT).evaluate((element) => {
            const style = getComputedStyle(element);
            return { border: parseFloat(style.borderTopWidth), background: style.backgroundColor };
        });
        assert(searchStyle.border >= 1, 'The SelectMenu search field must have a visible border');
        assert(
            searchStyle.background !== 'rgba(0, 0, 0, 0)',
            'The SelectMenu search field must be visually separated from the list',
        );

        const optionsInfo = await page.locator('[data-testid="select-menu-options"]').evaluate((element) => ({
            overflowY: getComputedStyle(element).overflowY,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        }));
        equal(optionsInfo.overflowY, 'auto', 'The marker type list must scroll inside the menu');
        assert(
            optionsInfo.scrollHeight > optionsInfo.clientHeight,
            `The marker type list does not overflow its menu (${optionsInfo.scrollHeight} / ${optionsInfo.clientHeight})`,
        );

        // ---- search ----------------------------------------------------
        await page.locator(SEARCH_INPUT).fill('flag');
        const flagOption = page.locator('[data-testid="select-menu-option-flag_NATO"]');
        await flagOption.waitFor({ state: 'visible', timeout: 5000 });
        await flagOption.locator('[class*="icon_image"]').waitFor({ state: 'visible', timeout: 5000 });

        const previewInfo = await flagOption
            .locator('[class*="icon_preview"]')
            .first()
            .evaluate((element) => {
                const image = element.querySelector('img[class*="icon_image"]');
                return {
                    width: element.getBoundingClientRect().width,
                    chip: getComputedStyle(element).backgroundColor,
                    src: image ? image.getAttribute('src') ?? '' : '',
                    loaded: image ? image.naturalWidth : 0,
                };
            });
        assert(previewInfo.width >= 20, `The marker type icon preview is too small: ${previewInfo.width}px`);
        assert(
            previewInfo.src.startsWith('data:image/png'),
            'The marker type preview must be a tinted image, not a mask/background box',
        );
        assert(previewInfo.loaded > 0, 'The marker type preview image did not decode');
        assert(
            !/^rgba?\(255,\s*255,\s*255/.test(previewInfo.chip),
            'The marker icon preview needs a contrasting backdrop for white icons',
        );

        const cornerAlpha = await page.evaluate(async (src) => {
            const image = new Image();
            image.src = src;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const cornerAlphaAt = (x, y) => pixels[(y * canvas.width + x) * 4 + 3];
            return Math.min(
                cornerAlphaAt(0, 0),
                cornerAlphaAt(canvas.width - 1, 0),
                cornerAlphaAt(0, canvas.height - 1),
                cornerAlphaAt(canvas.width - 1, canvas.height - 1),
            );
        }, previewInfo.src);
        assert(
            cornerAlpha < 250,
            `flag_NATO's preview looks like a solid box (all corners opaque: ${cornerAlpha})`,
        );

        const nonMatching = await page.locator('[data-testid="select-menu-option-mil_dot"]').count();
        equal(nonMatching, 0, 'The type search did not filter out non-matching types');
        await flagOption.click();
        await page.locator(TYPE_MENU).waitFor({ state: 'detached', timeout: 5000 });

        // ---- default color ---------------------------------------------
        const colorInfo = await page.locator(COLOR_SWATCH).first().evaluate((element) => ({
            colorClass: element.getAttribute('data-color-class'),
            isDefault: element.getAttribute('data-color-default'),
            background: getComputedStyle(element).backgroundColor,
        }));
        equal(colorInfo.colorClass, 'Default', 'The marker color picker must start on the type default');
        equal(colorInfo.isDefault, 'true', 'The first color swatch must be the virtual type default');
        assert(
            /^rgba?\(255,\s*255,\s*255/.test(colorInfo.background),
            `flag_NATO's default color swatch must be white, got ${colorInfo.background}`,
        );

        const defaultSwatches = await page.locator(`${COLOR_PICKER} [data-color-class="Default"]`).count();
        equal(defaultSwatches, 1, 'The marker color picker must show exactly one Default swatch');

        const customSwatch = page.locator(CUSTOM_SWATCH);
        equal(await customSwatch.count(), 1, 'The marker color picker must offer the Custom swatch');
        equal(await customSwatch.getAttribute('title'), 'Custom', 'The Custom swatch must use the Custom tooltip');
        equal(
            await page.locator(CUSTOM_INPUT).count(),
            0,
            'The custom color controls must live inside the Custom popover',
        );

        // ---- black type default ----------------------------------------
        const markerInfo = await page.evaluate(() => window.TacPhone.networking.Request({
            a: 'ACE_TacPhone_Map',
            c: 'GetMarkerTypes',
        }));
        const blackType = markerInfo?.types?.find((entry) => Array.isArray(entry)
            && Array.isArray(entry[2])
            && entry[2][0] === 0
            && entry[2][1] === 0
            && entry[2][2] === 0);

        if (blackType) {
            await selectMarkerType(page, blackType[0]);
            equal(
                await page.locator(`${COLOR_PICKER} [data-color-default="true"]`).count(),
                0,
                'A black type default must not duplicate the real black swatch',
            );
            const blackSwatches = await page
                .locator(`${COLOR_PICKER} [data-color-class]`)
                .evaluateAll((elements) => elements.filter((element) => {
                    const color = getComputedStyle(element).backgroundColor;
                    return color === 'rgb(0, 0, 0)' || color.startsWith('rgba(0, 0, 0');
                }).length);
            assert(blackSwatches > 0, 'The black type still needs a real black color swatch');
        } else {
            log?.('No black-default marker type is available; skipping the duplicate default check');
        }

        await page.locator(COLOR_SWATCH).first().click();

        // The color grid is not a menu; picking a swatch must not resize the dialog.
        const beforeColor = await measureDialog(page);
        await page.locator(`${COLOR_PICKER} [data-color-class="ColorBlack"]`).first().click();
        const afterColor = await measureDialog(page);
        equal(afterColor.scrollHeight, beforeColor.scrollHeight, 'Selecting a color changed the dialog scrollHeight');
        equal(afterColor.clientHeight, beforeColor.clientHeight, 'Selecting a color changed the dialog height');

        // ---- custom color popover (alpha lives inside it) --------------
        await customSwatch.click();
        await page.locator(CUSTOM_POPOVER).waitFor({ state: 'visible', timeout: 5000 });
        equal(
            await page.locator(CUSTOM_INPUT).count(),
            1,
            'The Custom popover must own the native color input',
        );
        const alphaMin = await page.locator(CUSTOM_ALPHA).getAttribute('min');
        equal(Number(alphaMin), 0.2, 'The custom color alpha must not go below 20%');

        // ---- preview must not blank while the color changes rapidly ----
        await setNativeInputValue(page, CUSTOM_INPUT, '#ff0000');
        await page.waitForFunction(
            () => window.__TACPHONE_MAP_TEST__?.getMapState()?.preview.color === '#(1,0,0,1)',
            null,
            { timeout: 5000 },
        );
        await page.waitForFunction(
            () => window.__TACPHONE_MAP_TEST__?.getMapState()?.preview.iconLoaded === true,
            null,
            { timeout: 5000 },
        );

        await page.evaluate((selector) => {
            const input = document.querySelector(selector);
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            for (const value of ['#00ff00', '#0000ff', '#ffff00']) {
                setter.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, CUSTOM_INPUT);

        const rapidPreview = await page.evaluate(() => window.__TACPHONE_MAP_TEST__?.getMapState()?.preview);
        equal(
            rapidPreview?.iconLoaded,
            true,
            'The marker preview icon blanked while the custom color changed rapidly',
        );

        await page.waitForFunction(
            () => window.__TACPHONE_MAP_TEST__?.getMapState()?.preview.color === '#(1,1,0,1)',
            null,
            { timeout: 5000 },
        );
        await page.waitForFunction(
            () => window.__TACPHONE_MAP_TEST__?.getMapState()?.preview.iconLoaded === true,
            null,
            { timeout: 5000 },
        );

        // ---- apply the custom RGBA color used for the created marker ---
        await setNativeInputValue(page, CUSTOM_INPUT, '#00ff00');
        await page.waitForFunction(
            () => window.__TACPHONE_MAP_TEST__?.getMapState()?.preview.color === '#(0,1,0,1)',
            null,
            { timeout: 5000 },
        );
        await setNativeInputValue(page, CUSTOM_ALPHA, '0');
        await page.waitForFunction(
            () => window.__TACPHONE_MAP_TEST__?.getMapState()?.preview.color === '#(0,1,0,0.2)',
            null,
            { timeout: 5000 },
        );
        await page.waitForFunction(
            () => {
                const preview = window.__TACPHONE_MAP_TEST__?.getMapState()?.preview;
                return preview !== undefined && Math.abs(preview.iconOpacity - 0.2) <= 1e-6;
            },
            null,
            { timeout: 5000 },
        );
        await setNativeInputValue(page, CUSTOM_ALPHA, '0.5');
        await page.waitForFunction(
            () => window.__TACPHONE_MAP_TEST__?.getMapState()?.preview.color === '#(0,1,0,0.5)',
            null,
            { timeout: 5000 },
        );
        await page.waitForFunction(
            () => {
                const preview = window.__TACPHONE_MAP_TEST__?.getMapState()?.preview;
                return preview !== undefined && Math.abs(preview.iconOpacity - 0.5) <= 1e-6;
            },
            null,
            { timeout: 5000 },
        );
        const customPressed = await page.locator(CUSTOM_SWATCH).getAttribute('aria-pressed');
        equal(customPressed, 'true', 'Applying a custom color did not mark the Custom swatch as selected');

        // The popover stays open after choosing the color and can cover the
        // create button; Escape closes only the popover, not the dialog.
        if (await page.locator(CUSTOM_POPOVER).count() > 0) {
            await page.keyboard.press('Escape');
            await page.locator(CUSTOM_POPOVER).waitFor({ state: 'detached', timeout: 5000 })
                .catch(() => {});
        }

        // ---- channel menu (multiplayer only) ---------------------------
        if (await page.locator(CHANNEL_TRIGGER).count() > 0) {
            const beforeChannel = await measureDialog(page);
            await page.locator(CHANNEL_TRIGGER).click();
            await assertPortaledMenu(page, CHANNEL_MENU, beforeChannel, 'channel menu');
            await page.keyboard.press('Escape');
            await page.locator(CHANNEL_MENU).waitFor({ state: 'detached', timeout: 5000 });
            // Escape closes only the menu; the dialog must still be open.
            assert(await page.locator(DIALOG).count() === 1, 'Escape closed the whole dialog instead of only the channel menu');
        }

        // ---- text length ----------------------------------------------
        const nameInput = page.locator(`${DIALOG} input[type="text"]`).first();
        await nameInput.fill('y'.repeat(300));
        const inputLength = (await nameInput.inputValue()).length;
        equal(inputLength, MAX_MARKER_TEXT_LENGTH, 'The marker name input must cap at 256 characters');

        // ---- debug helper (label text color) --------------------------
        const hookResult = await page.evaluate(() => {
            const hooks = window.__TACPHONE_MAP_TEST__;
            if (!hooks) {
                return null;
            }

            return {
                red: hooks.markerLabelColor(hooks.resolveMarkerColor('red', '#ff0000ff', '#ffffffff')),
                black: hooks.markerLabelColor(hooks.resolveMarkerColor('black', '#000000ff', '#ffffffff')),
                nato: hooks.markerLabelColor(hooks.resolveMarkerColor('Default', '#000000ff', '#ffffffff')),
                customCss: hooks.markerColorToCss('#(0,1,0,0.5)'),
                customRoundTrip: hooks.hexToMarkerColor('#00ff00', 0.5),
                opaqueCss: hooks.markerColorToOpaqueCss('rgba(0, 255, 0, 0.2)'),
                opaqueHex: hooks.markerColorToOpaqueCss('#00ff0080'),
                opaqueCustom: hooks.markerColorToOpaqueCss('#(0,1,0,0.2)'),
                alphaFloor: hooks.rgbToMarkerColor(0, 255, 0, 0),
                minAlpha: hooks.MIN_MARKER_COLOR_ALPHA,
                blackHex: hooks.isBlackMarkerColor('#000000ff'),
                blackRgb: hooks.isBlackMarkerColor('rgb(0, 0, 0)'),
                white: hooks.isBlackMarkerColor('#ffffffff'),
                clamped: hooks.clampMarkerText('z'.repeat(300)).length,
            };
        });

        if (hookResult === null) {
            log?.('debug hook __TACPHONE_MAP_TEST__ is not installed (release page without debug); skipping the label color assertions');
        } else {
            equal(hookResult.red, '#ff0000ff', 'A red marker must keep its own label text color');
            equal(hookResult.black, '#000000ff', 'A black marker must keep its own label text color');
            equal(hookResult.nato, '#ffffffff', 'Default + flag_NATO must resolve to white');
            equal(hookResult.customCss, 'rgba(0, 255, 0, 0.5)', 'The custom #(r,g,b,a) color must parse to CSS rgba');
            equal(hookResult.customRoundTrip, '#(0,1,0,0.5)', 'RGB + alpha must round-trip to the Arma custom color format');
            equal(hookResult.opaqueCss, 'rgb(0, 255, 0)', 'The icon tint must drop the custom color alpha');
            equal(hookResult.opaqueHex, '#00ff00', 'The icon tint must drop an 8-digit hex alpha');
            equal(hookResult.opaqueCustom, 'rgb(0, 255, 0)', 'The icon tint must drop the Arma custom color alpha');
            equal(hookResult.alphaFloor, '#(0,1,0,0.2)', 'A transparent custom color must be clamped to 20% alpha');
            equal(hookResult.minAlpha, 0.2, 'MIN_MARKER_COLOR_ALPHA must be 20%');
            equal(hookResult.blackHex, true, 'A black hex color must be recognized');
            equal(hookResult.blackRgb, true, 'A black rgb() color must be recognized');
            equal(hookResult.white, false, 'White must not be treated as black');
            equal(hookResult.clamped, MAX_MARKER_TEXT_LENGTH, 'clampMarkerText must cut at 256 characters');
        }

        // ---- create with the custom color -------------------------------
        const uniqueLabel = `TacPhone UI ${Date.now()}`;
        await nameInput.fill(uniqueLabel);
        await page.locator('[data-testid="marker-submit"]').click();
        await page.locator(DIALOG).waitFor({ state: 'detached', timeout: 10000 });

        const storedUiMarker = await waitForGameMarker(page, uniqueLabel);
        const storedCustom = parseArmaColor(storedUiMarker[2]);
        assert(
            storedCustom,
            `The UI did not send the custom color as #(r,g,b,a): ${storedUiMarker[2]}`,
        );
        assert(storedCustom.g > 0.99, `The custom green component is wrong: ${storedCustom.g}`);
        assert(
            Math.abs(storedCustom.a - 0.5) <= 0.01,
            `The custom alpha was not applied: expected 0.5, got ${storedCustom.a}`,
        );

        // The app must receive and resolve the custom color again.
        await page.waitForFunction(
            (name) => window.__TACPHONE_MAP_TEST__?.getMapState?.().markers
                .some((marker) => marker.name === name && marker.resolvedColor === 'rgba(0, 255, 0, 0.5)'),
            storedUiMarker[0],
            { timeout: 15000 },
        );

        await page.evaluate((name) => window.TacPhone.networking.Request({
            a: 'ACE_TacPhone_Map',
            c: 'DeleteMarker',
            marker: name,
        }), storedUiMarker[0]);
        await page.waitForFunction(
            (name) => !window.__TACPHONE_MAP_TEST__?.getMapState?.().markers
                .some((marker) => marker.name === name),
            storedUiMarker[0],
            { timeout: 10000 },
        ).catch(() => {});

        // ---- marker text is optional -----------------------------------
        const markersBeforeEmpty = new Set((await getAllGameMarkers(page)).map((marker) => marker[0]));
        await openCreateDialog(page, log, { x: 0.62, y: 0.62 });
        const emptyNameInput = page.locator(`${DIALOG} input[type="text"]`).first();
        await emptyNameInput.fill('');
        const emptySubmit = page.locator('[data-testid="marker-submit"]');
        assert(
            await emptySubmit.isEnabled(),
            'The marker dialog must allow submitting without a marker name',
        );
        await emptySubmit.click();
        await page.locator(DIALOG).waitFor({ state: 'detached', timeout: 10000 });

        let emptyMarker = null;
        const emptyDeadline = Date.now() + 15000;
        while (Date.now() < emptyDeadline && emptyMarker === null) {
            const markers = await getAllGameMarkers(page);
            emptyMarker = markers.find((marker) => !markersBeforeEmpty.has(marker[0]) && marker[5] === '') ?? null;
            if (emptyMarker === null) {
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }
        assert(emptyMarker, 'Creating a marker without a name did not store an empty marker text');
        log?.(`Created the unnamed marker ${emptyMarker[0]}`);
        await page.evaluate((name) => window.TacPhone.networking.Request({
            a: 'ACE_TacPhone_Map',
            c: 'DeleteMarker',
            marker: name,
        }), emptyMarker[0]);
        await page.waitForFunction(
            (name) => !window.__TACPHONE_MAP_TEST__?.getMapState?.().markers
                .some((marker) => marker.name === name),
            emptyMarker[0],
            { timeout: 10000 },
        ).catch(() => {});

        // ---- polyline color picker ------------------------------------
        await page.getByRole('button', { name: 'Draw polyline marker' }).click();
        await page.locator(POLYLINE_PICKER).waitFor({ state: 'visible', timeout: 5000 });
        const polylineLayout = await page.locator(POLYLINE_PICKER).evaluate((element) => {
            const grid = element.parentElement;
            const panel = grid?.parentElement;
            return {
                gridOverflow: grid ? getComputedStyle(grid).overflowY : '',
                gridScroll: grid ? grid.scrollHeight - grid.clientHeight : 0,
                panelOverflow: panel ? getComputedStyle(panel).overflowY : '',
                panelScroll: panel ? panel.scrollHeight - panel.clientHeight : 0,
            };
        });
        assert(
            polylineLayout.gridOverflow !== 'auto' && polylineLayout.gridOverflow !== 'scroll',
            'The polyline color grid must not scroll inside the panel',
        );
        assert(
            polylineLayout.gridScroll <= 1,
            `The polyline color grid overflows by ${polylineLayout.gridScroll}px`,
        );
        assert(
            polylineLayout.panelOverflow !== 'auto' && polylineLayout.panelOverflow !== 'scroll',
            'The polyline panel must not need its own scrollbar',
        );
        assert(
            polylineLayout.panelScroll <= 1,
            `The polyline panel overflows by ${polylineLayout.panelScroll}px`,
        );
        const polylineClasses = await page.locator(`${POLYLINE_PICKER} [data-color-class]`).evaluateAll(
            (elements) => elements.map((element) => element.getAttribute('data-color-class')),
        );
        assert(polylineClasses.includes('ColorBlack'), `The polyline picker must offer ColorBlack, got ${polylineClasses.join(', ')}`);
        assert(
            !polylineClasses.includes('Default'),
            'The polyline picker must not offer the duplicate Default class next to Black',
        );
        await page.getByRole('button', { name: 'Draw polyline marker' }).click();

        // ---- Options panel (inline-select regression guard) ------------
        await checkOptionsPanelSelect(page, log);

        // ---- menu opens upwards near the bottom ------------------------
        await checkSelectMenuOpensUpwards(page, log);

        // ---- cleanup ---------------------------------------------------
        equal(await page.locator('[data-dropdown-menu]').count(), 0, 'An open select menu was left in document.body');
        equal(await page.locator(DIALOG).count(), 0, 'The marker dialog was left open');

        if (consoleErrors.length > 0) {
            isType(consoleErrors[0], 'string');
            throw new Error(`The Map page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }

        await page.close();
    } finally {
        await browser.close();
    }
}
