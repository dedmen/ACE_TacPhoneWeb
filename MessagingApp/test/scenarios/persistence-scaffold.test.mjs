/**
 * Persistence scaffolding: debug save/load works, but nothing auto-saves or
 * auto-loads, and the server flag stays disabled.
 *
 * The wire protocol has no persistence-status field, so the meaningful
 * behavioural checks are: a reset loses the in-memory rooms (save did not make
 * them permanent automatically), and only an explicit Debug.LoadState brings
 * them back. The saved state is cleared at the end of the scenario.
 */

import {
    assert,
    equal,
    ok,
} from '../lib/assertions.mjs';
import { fakePlayersForSide, uniqueRoomName } from '../lib/fake-players.mjs';

export const name = 'persistence-scaffold';
export const description = 'Debug.SaveState/LoadState are explicit only; persistence stays disabled.';

export async function run(context) {
    const { fake, self } = context;

    await fake.reset();
    await fake.addFakePlayers();

    const sameSide = fakePlayersForSide(self.side);
    assert(sameSide.length >= 1, `No fake player on the local side (${self.side}).`);

    const roomName = uniqueRoomName('T7 persistence');
    const room = await fake.createGroupRoom(roomName, [sameSide[0].uid]);
    const content = `T7 persistence ${Date.now()}`;
    const message = await fake.sendMessage(room.id, content);

    try {
        await fake.saveState();

        const status = await fake.status();
        equal(status.debug, true, 'Debug support should still be enabled');

        if (Object.prototype.hasOwnProperty.call(status, 'persistenceEnabled')) {
            equal(
                status.persistenceEnabled,
                false,
                'Persistence must stay disabled even if a future status reports it',
            );
        }

        // Reset intentionally clears the in-memory database. If persistence were
        // automatic, the saved room would come back without asking.
        await fake.reset();

        const afterReset = await fake.sync();
        equal(
            afterReset.rooms.has(room.id),
            false,
            'Reset should clear the room; nothing should auto-load saved state',
        );
        equal(afterReset.done.rooms, 0, 'No rooms should remain after a debug reset');

        // Explicit load is the only way back.
        await fake.loadState();

        const restored = await fake.sync();
        const restoredRoom = restored.rooms.get(room.id);

        ok(restoredRoom, 'Debug.LoadState should restore the saved room');
        equal(restoredRoom.room.name, roomName, 'Restored room should keep its name');

        const restoredMessage = restoredRoom.messages.find(entry => entry.id === message.id);

        ok(restoredMessage, 'Debug.LoadState should restore the saved message');
        equal(restoredMessage.content, content, 'Restored message should keep its content');
    } finally {
        // Leave an empty saved state so a later mission does not load test rooms.
        try {
            await fake.reset();
            await fake.saveState();
        } catch {
            // Preserve the scenario failure.
        }
    }
}
