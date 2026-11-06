/**
 * Unit tests for the host CommandRegistry (`window.TacPhone.utils.CommandRegistry`).
 *
 * Every app routes all game pushes through one registry. Pushes without a
 * subscriber used to emit a console.warn per message, which spammed the console
 * at GPS.Update's 10 Hz. The warn now fires once per command and is re-armed
 * when a subscriber registers for the command again.
 */

import { equal, includes } from '../lib/assertions.mjs';
import { CommandRegistry } from '../../src/Backend/MessageRouter.ts';

export const name = 'message-router';
export const description = 'command routing, one warn per unsubscribed command';

export async function run() {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
        const registry = new CommandRegistry();
        const received = [];

        // A registered handler receives the message, no warning.
        const dispose = registry.register('Radio.State', (packet) => received.push(packet));
        const packet = { c: 'Radio.State', radio: 'r1' };
        registry.routeMessage(packet);
        equal(received.length, 1, 'The registered handler should receive the message');
        equal(received[0], packet, 'The handler should receive the original packet');
        equal(warnings.length, 0, 'A routed message should not warn');

        // A high-rate push without subscribers warns exactly once.
        for (let i = 0; i < 50; i += 1) {
            registry.routeMessage({ c: 'GPS.Update' });
        }
        equal(warnings.length, 1, 'Fifty pushes without subscribers should warn once');
        includes(warnings[0], 'GPS.Update', 'The warning should name the command');

        // Each unhandled command warns once.
        registry.routeMessage({ c: 'Marker.Upsert' });
        registry.routeMessage({ c: 'Marker.Upsert' });
        equal(warnings.length, 2, 'A second unhandled command should warn once of its own');

        // Losing the last subscriber arms the warning again for that command.
        dispose();
        registry.routeMessage(packet);
        equal(warnings.length, 3, 'A command that lost its last subscriber should warn again');
        registry.routeMessage(packet);
        equal(warnings.length, 3, '...but still only once');

        // Registering re-arms: subscribed commands must not warn.
        const dispose2 = registry.register('Radio.State', () => {});
        registry.routeMessage(packet);
        equal(warnings.length, 3, 'A subscribed command must not warn');
        dispose2();
        registry.routeMessage(packet);
        equal(warnings.length, 4, 'Losing the last subscriber arms the warning again');

        // clear() resets the report state as well.
        registry.clear();
        registry.routeMessage({ c: 'GPS.Update' });
        equal(warnings.length, 5, 'clear() re-arms warnings for previously reported commands');
    } finally {
        console.warn = originalWarn;
    }
}
