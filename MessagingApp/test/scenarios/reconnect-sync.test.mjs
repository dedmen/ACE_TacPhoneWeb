/**
 * Reconnect: close the WebSocket, open a new one, Hello and resync.
 */

import {
    assert,
    equal,
    includes,
    ok,
} from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { fakePlayersForSide, uniqueRoomName } from '../lib/fake-players.mjs';

export const name = 'reconnect-sync';
export const description = 'Room and message history survive a WebSocket reconnect and full resync.';

export async function run(context) {
    const { client, fake, self } = context;

    await fake.reset();
    await fake.addFakePlayers();

    const sameSide = fakePlayersForSide(self.side);
    assert(sameSide.length >= 1, `No fake player on the local side (${self.side}).`);

    const roomName = uniqueRoomName('T7 reconnect');
    const room = await fake.createGroupRoom(roomName, [sameSide[0].uid]);
    const content = `T7 reconnect ${Date.now()}`;
    const message = await fake.sendMessage(room.id, content);

    await client.reconnect();

    const hello = await client.request('Hello', { visible: true });

    ok(hello?.ok, 'Hello should succeed after reconnecting');
    equal(hello.self.uid, self.uid, 'Reconnect should return the same player UID');

    const state = await fake.sync();
    const restoredRoom = state.rooms.get(room.id);

    ok(restoredRoom, `Reconnect sync should contain room ${room.id}`);
    equal(restoredRoom.room.name, roomName, 'Room name should survive a reconnect');

    includes(
        restoredRoom.room.participants.map(participant => participant.uid),
        self.uid,
        'Reconnected room should still contain the local player',
    );

    const restoredMessage = restoredRoom.messages.find(entry => entry.id === message.id);

    ok(restoredMessage, 'Message history should survive a reconnect');
    equal(restoredMessage.content, content, 'Restored message should keep its content');
    equal(
        restoredMessage.clientMessageId,
        message.clientMessageId,
        'Restored message should keep the client message id',
    );
}
