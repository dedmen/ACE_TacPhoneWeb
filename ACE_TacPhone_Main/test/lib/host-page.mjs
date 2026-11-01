/**
 * Generic Playwright helpers for the TacPhone host page.
 *
 * The host test harness is shared by every browser suite: the host, the Map and
 * the Messenger import these helpers instead of keeping copies. They do not
 * import app source; every game interaction goes through the real
 * `window.TacPhone` contract.
 *
 * App-specific helpers stay in the app's own test lib (for example
 * `ACE_TacPhone_Map/test/lib/map-page.mjs`).
 */

import { launchBrowser } from './browser.mjs';
import { skip } from './skip.mjs';

/**
 * Launches the installed Chrome channel and opens the TacPhone host page.
 * Waits for the transport to be ready; app opening is left to the caller.
 * @param {{ pageUrl: string, headed?: boolean, slowMo?: number, hasTouch?: boolean, viewport?: { width: number, height: number } }} options
 */
export async function launchHostPage({
    pageUrl,
    headed = false,
    slowMo = 0,
    hasTouch = false,
    viewport = { width: 1280, height: 900 },
}) {
    const browser = await launchBrowser({ headed, slowMo });
    const context = await browser.newContext({ viewport, hasTouch });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    try {
        await page.bringToFront();
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForFunction(() => Boolean(window.TacPhone?.networking), null, { timeout: 20000 });
        await page.evaluate(() => window.TacPhone.networking.WhenReady());

        return { browser, context, page, consoleErrors };
    } catch (error) {
        await browser.close().catch(() => {});
        throw error;
    }
}

/**
 * Creates a new tab in the given tabset with the flexlayout "Add" button and
 * selects an app tile in the app chooser. Only the selected tab's chooser is
 * visible; the hidden chooser grids of other tabs must not be clicked.
 */
export async function openAppThroughChooser(page, appName, options = {}) {
    const { tileTitle = appName, tabsetIndex = 0 } = options;

    await page.waitForFunction(
        (app) => Boolean(window.TacPhone?.apps?.knownPanels?.has?.(app)),
        appName,
        { timeout: 30000 },
    ).catch(() => {});

    const appLoaded = await page.evaluate(
        (app) => window.TacPhone?.apps?.knownPanels?.has(app) === true,
        appName,
    ).catch(() => false);
    if (!appLoaded) {
        skip(`The host page did not load ${appName}; the app is not available in this build.`);
    }

    const addButton = page.getByTitle('Add').nth(tabsetIndex);
    await addButton.waitFor({ state: 'visible', timeout: 10000 });

    const tabsBefore = await page.locator('.flexlayout__tab_button').count();
    await addButton.click();
    await page.waitForFunction(
        (before) => document.querySelectorAll('.flexlayout__tab_button').length > before,
        tabsBefore,
        { timeout: 10000 },
    );

    const tile = page
        .getByTitle(`${tileTitle} · ${appName}`)
        .filter({ visible: true })
        .first();
    await tile.waitFor({ state: 'visible', timeout: 10000 });
    await tile.click();
}

/** Activates the tab of a mounted panel by panel id. */
export async function activatePanelTab(page, panelId) {
    const tabId = await page.evaluate((id) => {
        const panel = window.TacPhone.panels.list().find((entry) => entry.panelId === id && entry.mounted);
        return panel?.tabId ?? null;
    }, panelId);

    if (!tabId) {
        return false;
    }

    await page.evaluate((id) => window.TacPhone.panels.activate(id), tabId);
    return true;
}

/** Sends one request for any app from the page. */
export function requestApp(page, app, command, payload = {}) {
    return page.evaluate(
        ({ appName, cmd, data }) => window.TacPhone.networking.Request({ a: appName, c: cmd, ...data }),
        { appName: app, cmd: command, data: payload },
    );
}
