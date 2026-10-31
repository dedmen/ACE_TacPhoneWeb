/**
 * Room invites and the JoinRoom flow.
 *
 * The suite has one real player, so it exercises joining by first leaving the
 * group room (`RemoveParticipants` supports removing yourself), then joining
 * with the invite key from the invite card. That also makes the invalid-key
 * branch reachable.
 */

import {
    assert,
    equal,
    includes,
    isString,
    matchString,
    ok,
} from '../lib/assertions.mjs';
import { fakePlayersForSide, uniqueRoomName } from '../lib/fake-players.mjs';
import { collectChatState } from '../lib/ws-client.mjs';

export const name = 'invites';
export const description = 'Invite card object, invalid key rejection and JoinRoom resync.';

export async function run(context) {
    const { client, fake, self } = context;

    await fake.reset();
    await fake.addFakePlayers();

    const sameSide = fakePlayersForSide(self.side);
    assert(
        sameSide.length >= 2,
        `Need two fake players on the local side (${self.side}) for the invite flow.`,
    );

    const [roommate, invitee] = sameSide;
    const roomName = uniqueRoomName('T7 invites');
    const room = await fake.createGroupRoom(roomName, [roommate.uid]);

    client.clearPushes(['Message.New', 'Error']);
    await client.request('InviteToRoom', {
        roomId: room.id,
        playerUids: [invitee.uid],
        groupIds: [],
    });

    const invitePush = await client.waitForPush(
        'Message.New',
        data =>
            (data.message?.objects || []).some(
                object => object.kind === 'messaging.room_invite',
            ),
    );

    const inviteMessage = invitePush.message;
    const inviteObject = inviteMessage.objects.find(
        object => object.kind === 'messaging.room_invite',
    );

    ok(inviteObject, 'Invite message should carry a messaging.room_invite object');
    equal(inviteObject.version, 1, 'Invite object version should be 1');
    equal(inviteObject.data?.roomId, room.id, 'Invite should point at the room');
    equal(inviteObject.data?.roomName, roomName, 'Invite should carry the room name');
    isString(inviteObject.data?.inviteKey, 'Invite should carry an invite key');
    ok(inviteObject.data.inviteKey.length > 0, 'Invite key should not be empty');
    equal(inviteMessage.roomId, room.id, 'Invite message should be stored in the room');

    const inviteKey = inviteObject.data.inviteKey;

    // Leave the group room so the JoinRoom branch for non-members is reachable.
    client.clearPushes(['Room.Upsert', 'Error']);
    await client.request('RemoveParticipants', {
        roomId: room.id,
        playerUids: [self.uid],
    });

    const removed = await client.waitForPush(
        'Room.Upsert',
        data => data.removed === true && data.room?.id === room.id,
    );

    ok(removed, 'Removing yourself should push Room.Upsert with removed: true');

    // Wrong key must be rejected by the server.
    client.clearPushes('Error');
    await client.request('JoinRoom', {
        roomId: room.id,
        inviteKey: 'definitely-not-the-key',
    });

    const invalidKeyError = await client.waitForPush(
        'Error',
        data => data.request === 'JoinRoom',
    );

    matchString(
        invalidKeyError.message,
        /invalid invite key/i,
        'Invalid invite key should be rejected with a clear error',
    );

    // Correct key joins and resyncs the full room history.
    client.clearPushes(['ChatState.Room', 'ChatState.Done', 'Error']);
    await client.request('JoinRoom', {
        roomId: room.id,
        inviteKey,
    });

    const { rooms, done } = await collectChatState(client, { clearBefore: false });
    const joined = rooms.get(room.id);

    ok(joined, `JoinRoom sync should contain room ${room.id}`);
    includes(
        joined.room.participants.map(participant => participant.uid),
        self.uid,
        'Joined room should contain the local player again',
    );
    ok(done.rooms >= 1, 'JoinRoom should end with ChatState.Done');
    ok(
        joined.messages.some(message => message.id === inviteMessage.id),
        'Joined room history should still contain the invite message',
    );
}
