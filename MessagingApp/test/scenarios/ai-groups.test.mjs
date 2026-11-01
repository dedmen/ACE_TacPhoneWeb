/**
 * AI-only groups: inter-group chat and group deletion.
 *
 * Debug AI groups have synthetic PlayerUIDs and are allowed through the group
 * event/track paths only in the A3 debug build.
 */

import { assert, equal, ok } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { uniqueRoomName } from '../lib/fake-players.mjs';

async function createAIGroup(client, fake, name, count = 2) {
    client.clearPushes('PlayerList.State');
    await client.request('Messaging.Debug.AIGroup', { action: 'create', count, name });
    await client.waitForPush('PlayerList.State', data => (data.players || []).some(player => player.name.startsWith(name)));

    const roster = await fake.getPlayerList();
    const group = roster.groups.find(entry => entry.name === name);

    assert(group, `AI group ${name} should appear in the player list.`);

    const members = roster.players.filter(player => group.memberUids.includes(player.uid));
    assert(members.length === count, `AI group ${name} should have ${count} members.`);

    return { group, members };
}

async function roomInfo(client, roomId) {
    client.clearPushes('Debug.RoomInfo');
    await client.request('Messaging.Debug.RoomInfo', { roomId });

    return client.waitForPush('Debug.RoomInfo', data => data.roomId === roomId);
}

export const name = 'ai-groups';
export const description = 'AI group inter-chat and group deletion, including deletion of a group-only room.';

export async function run(context) {
    const { client, fake, self } = context;

    await fake.reset();

    const alpha = await createAIGroup(client, fake, 'T7 AI Alpha', 2);
    const bravo = await createAIGroup(client, fake, 'T7 AI Bravo', 2);

    const room = await fake.createGroupRoom(
        uniqueRoomName('T7 AI groups'),
        [],
        [alpha.group.id, bravo.group.id],
    );

    const participants = room.participants || [];

    assert(
        participants.some(participant => participant.uid === self.uid),
        'The local creator should be in the inter-group room.',
    );
    ok(
        alpha.members.every(member => participants.some(participant => participant.uid === member.uid)),
        'Alpha AI members should be room participants.',
    );
    ok(
        bravo.members.every(member => participants.some(participant => participant.uid === member.uid)),
        'Bravo AI members should be room participants.',
    );

    client.clearPushes('Message.New');
    await client.request('Messaging.Debug.InjectMessage', {
        roomId: room.id,
        content: 'Message from Alpha AI',
        senderUid: alpha.members[0].uid,
    });
    const alphaMessage = await client.waitForPush(
        'Message.New',
        data =>
            data.message?.content === 'Message from Alpha AI' &&
            data.message?.senderUid === alpha.members[0].uid,
    );

    equal(alphaMessage.message.senderGroupName, 'T7 AI Alpha', 'Alpha message should carry its group name.');

    client.clearPushes('Message.New');
    await client.request('Messaging.Debug.InjectMessage', {
        roomId: room.id,
        content: 'Message from Bravo AI',
        senderUid: bravo.members[0].uid,
    });
    const bravoMessage = await client.waitForPush(
        'Message.New',
        data =>
            data.message?.content === 'Message from Bravo AI' &&
            data.message?.senderUid === bravo.members[0].uid,
    );

    equal(bravoMessage.message.senderGroupName, 'T7 AI Bravo', 'Bravo message should carry its group name.');

    // Delete Alpha while the room still has local + Bravo.
    client.clearPushes(['Message.New', 'Room.Upsert']);
    await client.request('Messaging.Debug.AIGroup', { action: 'delete', groupId: alpha.group.id });
    await client.waitForPush(
        'Message.New',
        data => data.message?.system === true && /group was deleted/i.test(data.message.content || ''),
    );

    const afterAlpha = (await fake.sync()).rooms.get(room.id);
    assert(afterAlpha, 'The room should survive deleting one of two groups.');
    assert(
        !afterAlpha.room.participants.some(participant => participant.uid === alpha.members[0].uid),
        'Alpha members should be removed after group deletion.',
    );
    ok(
        afterAlpha.room.participants.some(participant => participant.uid === bravo.members[0].uid),
        'Bravo members should remain.',
    );

    // Group-only room: create with local + Alpha2, make local leave, then delete
    // the group. The room must disappear entirely.
    const charlie = await createAIGroup(client, fake, 'T7 AI Charlie', 1);
    const soloRoom = await fake.createGroupRoom(
        uniqueRoomName('T7 AI only'),
        [],
        [charlie.group.id],
    );

    client.clearPushes(['Room.Upsert', 'Error']);
    await client.request('RemoveParticipants', { roomId: soloRoom.id, playerUids: [self.uid] });
    await client.waitForPush(
        'Room.Upsert',
        data => data.removed === true && data.room?.id === soloRoom.id,
    );

    await client.request('Messaging.Debug.AIGroup', { action: 'delete', groupId: charlie.group.id });

    const gone = await roomInfo(client, soloRoom.id);
    equal(gone.exists, false, 'Deleting the only group in a room should delete the room.');
}
