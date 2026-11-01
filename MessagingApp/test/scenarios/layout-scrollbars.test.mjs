/**
 * Messenger layout checks that do not need the Map or terrain.
 *
 * The in-game Chromium uses overlay scrollbars, which hide the scrollbar gutter
 * when a panel is too short for the room or message list. `theme.module.css`
 * styles the WebKit scrollbar pseudo-elements; this scenario keeps a short panel
 * from regressing back to an invisible bar.
 */

import { assert, equal } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    launchHostPage,
    openAppThroughChooser,
    requestApp,
} from '../../../ACE_TacPhone_Main/test/lib/host-page.mjs';
import { skip } from '../../../ACE_TacPhone_Main/test/lib/skip.mjs';

export const name = 'layout-scrollbars';
export const kind = 'browser';
export const description = 'Messenger keeps a visible, working scrollbar in short panels';

const MESSAGE_COUNT = 24;

export async function run({ pageUrl, options, log }) {
    const { browser, page, consoleErrors } = await launchHostPage({
        pageUrl,
        headed: options?.headed === true,
        slowMo: options?.slow ?? 0,
    });

    try {
        await openAppThroughChooser(page, 'Messaging', {
            tileTitle: 'Messenger',
            tabsetIndex: 0,
        });
        await page.getByRole('button', { name: 'New chat' }).first().waitFor({ state: 'visible', timeout: 15000 });

        const hasStore = await page.evaluate(() => Boolean(window.__messengerStore));
        if (!hasStore) {
            skip('The Messenger debug store is unavailable; short-panel scrolling needs a debug build.');
        }

        if (await page.getByRole('button', { name: 'Messenger debug tools' }).count() > 0) {
            await page.getByRole('button', { name: 'Messenger debug tools' }).click();
            await page.getByRole('button', { name: 'Add fake players' }).click();
            if (await page.getByRole('button', { name: 'Collapse debug tools' }).count() > 0) {
                await page.getByRole('button', { name: 'Collapse debug tools' }).click();
            }
        } else {
            await requestApp(page, 'Messaging', 'Messaging.Debug.AddFakePlayers', { count: 8 });
        }

        await page.waitForFunction(
            () => (window.__messengerStore?.getSnapshot().players.length ?? 0) > 0,
            null,
            { timeout: 15000 },
        );

        const playerUid = await page.evaluate(() => window.__messengerStore.getSnapshot().players[0]?.uid);
        assert(playerUid, 'The Messenger did not receive a fake player');

        const roomName = `Scrollbar layout ${Date.now()}`;
        await requestApp(page, 'Messaging', 'CreateRoom', {
            room: {
                kind: 'group',
                name: roomName,
                playerUids: [playerUid],
                groupIds: [],
            },
        });
        await page.waitForFunction(
            (name) => window.__messengerStore?.getSnapshot().rooms.some(room => room.name === name) === true,
            roomName,
            { timeout: 15000 },
        );

        const room = await page.evaluate((name) => {
            const state = window.__messengerStore.getSnapshot();
            return state.rooms.find(entry => entry.name === name);
        }, roomName);
        assert(room?.id, 'The Messenger did not receive the room for the scrollbar check');

        await page.getByText(roomName, { exact: true }).first().click();
        await page.getByRole('textbox', { name: 'Message' }).waitFor({ state: 'visible', timeout: 15000 });

        for (let index = 0; index < MESSAGE_COUNT; index += 1) {
            await requestApp(page, 'Messaging', 'Messaging.Debug.InjectMessage', {
                roomId: room.id,
                content: `Scrollbar check ${index}`,
            });
        }

        await page.waitForFunction(
            (roomId) => (window.__messengerStore?.getSnapshot().messages?.[roomId]?.length ?? 0) >= 20,
            room.id,
            { timeout: 15000 },
        );
        await page.waitForFunction(
            () => {
                const element = document.querySelector('[class*="messages"]');
                return element !== null && element.scrollTop > 0;
            },
            null,
            { timeout: 5000 },
        );

        const originalViewport = page.viewportSize() ?? { width: 1280, height: 900 };
        await page.setViewportSize({ width: 480, height: 300 });
        await page.waitForTimeout(300);

        const scrollInfo = await page.evaluate(() => {
            const element = document.querySelector('[class*="messages"]');
            if (!element) return null;
            const style = getComputedStyle(element);
            return {
                overflowY: style.overflowY,
                scrollbarColor: style.scrollbarColor,
                scrollHeight: element.scrollHeight,
                clientHeight: element.clientHeight,
                clientWidth: element.clientWidth,
                offsetWidth: element.offsetWidth,
                scrollTop: element.scrollTop,
            };
        });

        assert(scrollInfo, 'The Messenger message list is missing');
        equal(scrollInfo.overflowY, 'auto', 'The message list must be a scroll container');
        assert(
            scrollInfo.scrollHeight > scrollInfo.clientHeight,
            `The message list does not overflow in a short panel (${scrollInfo.scrollHeight} / ${scrollInfo.clientHeight})`,
        );
        assert(
            /rgba?\(\s*255\s*,\s*255\s*,\s*255/.test(scrollInfo.scrollbarColor),
            `The message list must show a visible scrollbar, got ${scrollInfo.scrollbarColor}`,
        );
        if (options?.headed === true) {
            // Headless Chromium always uses overlay scrollbars, so the gutter is
            // only observable in the headed browser the game also uses.
            assert(
                scrollInfo.offsetWidth > scrollInfo.clientWidth,
                'A visible scrollbar must reserve a gutter in a short panel',
            );
        }

        const messagesBox = await page.locator('[class*="messages"]').boundingBox();
        assert(messagesBox, 'The message list has no layout box');
        await page.mouse.move(messagesBox.x + messagesBox.width / 2, messagesBox.y + messagesBox.height / 2);
        await page.mouse.wheel(0, -600);
        await page.waitForTimeout(200);
        const scrolledTop = await page.locator('[class*="messages"]').evaluate((element) => element.scrollTop);
        assert(
            scrolledTop < scrollInfo.scrollTop,
            `The message list did not scroll with the wheel (${scrollInfo.scrollTop} -> ${scrolledTop})`,
        );

        await page.setViewportSize(originalViewport);
        log?.('Short Messenger panels keep a visible, working message scrollbar');

        if (consoleErrors.length > 0) {
            throw new Error(`The Messenger page raised uncaught errors: ${consoleErrors.join(' | ')}`);
        }
    } finally {
        await requestApp(page, 'Messaging', 'Messaging.Debug.Reset').catch(() => undefined);
        await page.close();
        await browser.close();
    }
}
