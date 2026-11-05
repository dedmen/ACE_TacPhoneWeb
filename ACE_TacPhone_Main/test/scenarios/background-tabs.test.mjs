/**
 * Verifies that every tab of a tabset is mounted, including tabs in the
 * background and tabs that were never selected.
 *
 * flexlayout's render-on-demand default does not mount a tab until it is
 * selected, so an app restored in a background tab (a Map, for example) is
 * built only on the first click and can be rebuilt on later switches. The host
 * disables that instead, so a background tab must be mounted (only
 * `display: none`) and keep the same instance id across a switch.
 *
 *   $env:TACPHONE_TEST_URL = 'http://localhost:5173/'
 *   npm run test:host-ui -- --scenario background-tabs --slow
 */

import { assert, equal } from '../lib/assertions.mjs';
import { launchHostPage } from '../lib/host-page.mjs';
import { skip } from '../lib/skip.mjs';

export const name = 'background-tabs';
export const kind = 'browser';
export const description = 'Background tabs stay mounted and keep their panel instance';

/** Host panel that exists in both the dev and release builds. */
const PANEL_ID = 'ACE_TacPhone_Options';

/** Opens one host panel as a docked tab in the given tabset. */
function openPanelTab(page, tabsetId, select = true) {
    return page.evaluate(({ panelId, targetTabSet, selected }) => {
        const opened = window.TacPhone.panels.open(panelId, {
            placement: 'tab',
            tabsetId: targetTabSet,
            select: selected,
        });
        return opened ?? null;
    }, { panelId: PANEL_ID, targetTabSet: tabsetId, selected: select });
}

/** Panels of the tested id, in directory order. */
function readPanels(page) {
    return page.evaluate((panelId) => (
        window.TacPhone.panels.list()
            .filter((panel) => panel.panelId === panelId)
            .map((panel) => ({
                tabId: panel.tabId,
                tabSetId: panel.tabSetId,
                instanceId: panel.instanceId,
                mounted: panel.mounted,
                isSelected: panel.isSelected,
            }))
    ), PANEL_ID);
}

export async function run({ pageUrl, options, log }) {
    const { browser, page, consoleErrors } = await launchHostPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
    });

    try {
        const available = await page
            .waitForFunction(
                (panelId) => window.TacPhone?.apps?.knownPanels?.has?.(panelId) === true,
                PANEL_ID,
                { timeout: 30000 },
            )
            .then(() => true)
            .catch(() => false);

        if (!available) {
            skip(`The host page does not provide the ${PANEL_ID} panel.`);
        }

        // The default layout has one tabset per chooser tab; put both test tabs
        // in the first one so one of them is always in the background.
        const tabsetId = await page.evaluate(() => window.TacPhone.panels.list()[0]?.tabSetId ?? null);
        assert(tabsetId, 'The host page has no tabset to open a panel in');

        const first = await openPanelTab(page, tabsetId, false);
        assert(first, `Opening ${PANEL_ID} as a tab failed`);
        log?.(`Opened the first tab ${first.tabId} in the background`);

        const second = await openPanelTab(page, tabsetId);
        assert(second, `Opening the second ${PANEL_ID} tab failed`);
        equal(second.tabSetId, first.tabSetId ?? tabsetId, 'The two tabs must share a tabset');

        // Both tabs must have mounted before the background check is meaningful.
        await page.waitForFunction(
            ({ panelId, tabId }) => window.TacPhone.panels
                .list()
                .some((panel) => panel.panelId === panelId && panel.tabId === tabId && panel.mounted),
            { panelId: PANEL_ID, tabId: second.tabId },
            { timeout: 15000 },
        );

        // The second tab is selected now, so the first one is in the background.
        const before = await readPanels(page);
        equal(before.length, 2, 'Both test tabs must be open');

        const background = before.find((panel) => panel.tabId === first.tabId);
        const foreground = before.find((panel) => panel.tabId === second.tabId);

        assert(background, 'The first tab disappeared from the panel directory');
        assert(foreground, 'The second tab disappeared from the panel directory');
        equal(background.isSelected, false, 'The first tab should be in the background');
        equal(foreground.isSelected, true, 'The second tab should be selected');

        // This is the regression: with render-on-demand, a tab that was never
        // selected is not mounted at all, which leaves it without an instance.
        equal(background.mounted, true, 'A tab that has never been selected must still be mounted');
        assert(
            typeof background.instanceId === 'string' && background.instanceId.length > 0,
            'A background tab must keep a live panel instance',
        );

        const backgroundInstance = background.instanceId;
        const foregroundInstance = foreground.instanceId;

        // Switch back and verify neither tab was recreated.
        const activated = await page.evaluate(
            (instanceId) => window.TacPhone.panels.activate(instanceId),
            backgroundInstance,
        );
        equal(activated, true, 'Activating the background panel failed');

        await page.waitForFunction(
            ({ panelId, tabId }) => window.TacPhone.panels
                .list()
                .some((panel) => panel.panelId === panelId && panel.tabId === tabId && panel.isSelected),
            { panelId: PANEL_ID, tabId: first.tabId },
            { timeout: 15000 },
        );

        const after = await readPanels(page);
        const switched = after.find((panel) => panel.tabId === first.tabId);
        const other = after.find((panel) => panel.tabId === second.tabId);

        assert(switched && other, 'A test tab disappeared after switching back');
        equal(switched.instanceId, backgroundInstance, 'Switching a tab must not recreate its panel instance');
        equal(other.instanceId, foregroundInstance, 'The new background tab must keep its panel instance');
        equal(other.mounted, true, 'The tab left in the background must stay mounted');
        log?.('Both tabs kept their panel instance across the switch');

        if (consoleErrors.length > 0) {
            throw new Error(`The host page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        await page.close();
        await browser.close();
    }
}
