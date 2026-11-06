/**
 * Unit tests for the in-game Notify.Show request mapping
 * (`src/Backend/notifyRequest.ts`).
 *
 * `NotificationCenter.show()` sends one fire-and-forget `Notify.Show` request
 * when `options.inGame` is set. The mapping is pure (no transport, no DOM), so
 * it is unit-tested here; the live game tier covers the game side.
 */

import path from 'node:path';

import { assert, deepEqual, equal } from '../lib/assertions.mjs';

export const name = 'notify-request';
export const description = 'Notify.Show request mapping for in-game notifications';

export async function run({ root, loadAppModule }) {
    const mod = await loadAppModule(path.join(root, 'src', 'Backend', 'notifyRequest.ts'));
    const { buildInGameNotifyRequest } = mod;

    // No inGame option: no request is built, so nothing leaves the phone.
    equal(
        buildInGameNotifyRequest({ title: 'Hello' }),
        undefined,
        'Options without inGame must not build a request',
    );

    // Empty inGame option: the info style and no chat line are the defaults.
    deepEqual(
        buildInGameNotifyRequest({ title: 'Hello', inGame: {} }),
        { a: 'main', c: 'Notify.Show', title: 'Hello', style: 'info', chat: false },
        'An empty inGame option must default to style info and chat false',
    );

    // A known style and chat: true pass through unchanged.
    const success = buildInGameNotifyRequest({
        title: 'Hello',
        inGame: { style: 'success', chat: true },
    });
    equal(success.style, 'success', 'A known style must pass through');
    equal(success.chat, true, 'chat: true must pass through');

    // An unknown style falls back to 'info'.
    equal(
        buildInGameNotifyRequest({ title: 'Hello', inGame: { style: 'bogus' } }).style,
        'info',
        'An unknown style must fall back to info',
    );

    // title, body and app are forwarded verbatim.
    deepEqual(
        buildInGameNotifyRequest({
            title: 'Hi',
            body: 'There',
            app: 'MyApp',
            inGame: {},
        }),
        { a: 'main', c: 'Notify.Show', title: 'Hi', body: 'There', app: 'MyApp', style: 'info', chat: false },
        'title, body and app must be forwarded verbatim',
    );

    // Empty strings are still forwarded...
    const emptyStrings = buildInGameNotifyRequest({ title: '', body: '', inGame: {} });
    equal(emptyStrings.title, '', 'An empty-string title must be forwarded');
    equal(emptyStrings.body, '', 'An empty-string body must be forwarded');

    // ...while absent body/app are omitted from the request.
    assert('app' in emptyStrings === false, 'app must be omitted when absent');
    assert('body' in buildInGameNotifyRequest({ title: 'Hi', inGame: {} }) === false,
        'body must be omitted when absent');
}
