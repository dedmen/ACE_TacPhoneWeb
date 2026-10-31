/**
 * Forwarding a message to another room.
 */

import {
    assert,
    equal,
    isNumber,
    notEqual,
    ok,
} from '../lib/assertions.mjs';
import { fakePlayersForSide, uniqueRoomName } from '../lib/fake-players.mjs';

export const name = 'forwarding';
export const description = 'ForwardMessage keeps content/objects and adds forwarded metadata.';

export async function run(context) {
    const { fake, self } = context;

    await fake.reset();
    await fake.addFakePlayers();

    const sameSide = fakePlayersForSide(self.side);
    assert(sameSide.length >= 2, `Need two fake players on the local side (${self.side}).`);

    const sourceName = uniqueRoomName('T7 forward source');
    const targetName = uniqueRoomName('T7 forward target');
    const sourceRoom = await fake.createGroupRoom(sourceName, [sameSide[0].uid]);
    const targetRoom = await fake.createGroupRoom(targetName, [sameSide[1].uid]);

    const content = `T7 forward ${Date.now()}`;
    const original = await fake.sendMessage(sourceRoom.id, content);

    const forwarded = await fake.forwardMessage(sourceRoom.id, original.id, {
        roomId: targetRoom.id,
        expectedContent: content,
    });

    notEqual(forwarded.id, original.id, 'Forwarded message should get a new id');
    equal(forwarded.roomId, targetRoom.id, 'Forwarded message should land in the target room');
    equal(forwarded.content, content, 'Forwarded message should keep the original body');
    equal(forwarded.senderUid, self.uid, 'Forwarder should be the sender of the new message');

    ok(forwarded.forwarded, 'Forwarded message should carry forwarded metadata');

    equal(
        forwarded.forwarded.roomId,
        sourceRoom.id,
        'forwarded.roomId should be the source room',
    );
    equal(
        forwarded.forwarded.roomName,
        sourceName,
        'forwarded.roomName should be the source room name',
    );
    equal(forwarded.forwarded.senderUid, self.uid, 'forwarded.senderUid should be the original sender');
    equal(forwarded.forwarded.senderName, self.name, 'forwarded.senderName should be the original sender');
    isNumber(forwarded.forwarded.timestamp, 'forwarded.timestamp should be a number');
    equal(
        forwarded.forwarded.timestamp,
        original.timestamp,
        'forwarded.timestamp should keep the original send time',
    );
}
