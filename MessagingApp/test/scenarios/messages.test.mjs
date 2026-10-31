/**
 * Sending a message: optimistic echo and chat-state persistence.
 */

import {
    assert,
    equal,
    isNumber,
    isString,
    ok,
} from '../lib/assertions.mjs';
import { fakePlayersForSide, uniqueRoomName } from '../lib/fake-players.mjs';

export const name = 'messages';
export const description = 'SendMessage echoes Message.New with clientMessageId and syncs it back.';

export async function run(context) {
    const { fake, self } = context;

    await fake.reset();
    await fake.addFakePlayers();

    const sameSide = fakePlayersForSide(self.side);
    assert(sameSide.length >= 1, `No fake player on the local side (${self.side}).`);

    const roomName = uniqueRoomName('T7 messages');
    const room = await fake.createGroupRoom(roomName, [sameSide[0].uid]);
    const content = `T7 message ${Date.now()}`;

    const message = await fake.sendMessage(room.id, content);

    ok(message, 'SendMessage should produce a Message.New echo');
    isString(message.id, 'Echoed message id should be a string');
    ok(message.id.startsWith('msg:'), `Message id should start with msg:, got ${message.id}`);
    equal(message.roomId, room.id, 'Echoed message should target the source room');
    equal(message.senderUid, self.uid, 'Echoed message should be sent by the local player');
    equal(message.senderName, self.name, 'Echoed message should keep the sender name');
    equal(message.content, content, 'Echoed message should keep its content');
    isString(message.clientMessageId, 'Echoed message should carry the client message id');
    ok(message.clientMessageId.length > 0, 'clientMessageId should not be empty');
    isNumber(message.timestamp, 'Echoed message should have a numeric server timestamp');

    const state = await fake.sync();
    const syncedRoom = state.rooms.get(room.id);

    ok(syncedRoom, `Chat state should contain room ${room.id}`);

    const syncedMessage = syncedRoom.messages.find(entry => entry.id === message.id);

    ok(syncedMessage, 'Chat state should contain the sent message by id');
    equal(syncedMessage.content, content, 'Synced message should keep its content');
    equal(
        syncedMessage.clientMessageId,
        message.clientMessageId,
        'Synced message should keep the client message id',
    );
    equal(syncedMessage.senderUid, self.uid, 'Synced message should keep the sender UID');
}
