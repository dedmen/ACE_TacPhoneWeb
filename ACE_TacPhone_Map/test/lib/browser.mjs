/**
 * Playwright bootstrap for the Map browser scenario.
 *
 * Uses an installed browser channel (`chrome` by default) instead of
 * downloading a Playwright browser build:
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
 *   npx playwright install chrome   # only when Chrome is not present yet
 *
 * Override the channel with `TACPHONE_TEST_BROWSER` (or `PLAYWRIGHT_CHANNEL`).
 * A missing package or browser is a skip, not a failure: the Node marker
 * protocol scenario and the manual checklist stay usable without it.
 */

import { SkipError } from './skip.mjs';

export const DEFAULT_PAGE_URL = 'http://localhost:5173/';

export function browserChannel() {
    return process.env.TACPHONE_TEST_BROWSER || process.env.PLAYWRIGHT_CHANNEL || 'chrome';
}

async function loadPlaywright() {
    const packages = ['playwright', 'playwright-core'];

    for (const name of packages) {
        try {
            return await import(name);
        } catch {
            // Try the next package name.
        }
    }

    throw new SkipError(
        'Playwright is not installed. Install it with ' +
            '`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -D playwright` and rerun, ' +
            'or use the manual checklist in ACE_TacPhone_Map/test/browser/.',
    );
}

/**
 * Launches the installed Chromium-based browser.
 * @param {{ headed?: boolean, channel?: string, slowMo?: number }} [options]
 */
export async function launchBrowser(options = {}) {
    const playwright = await loadPlaywright();
    const channel = options.channel || browserChannel();
    const slowMo = Number(options.slowMo);
    const launchOptions = {
        channel,
        headless: options.headed !== true,
        ...(Number.isFinite(slowMo) && slowMo > 0 ? { slowMo } : {}),
    };

    try {
        return await playwright.chromium.launch(launchOptions);
    } catch (error) {
        throw new SkipError(
            `Could not launch the "${channel}" browser: ${error?.message || String(error)}. ` +
                'Set TACPHONE_TEST_BROWSER to an installed channel (for example chrome or msedge), ' +
                'or run the manual checklist in ACE_TacPhone_Map/test/browser/.',
        );
    }
}
