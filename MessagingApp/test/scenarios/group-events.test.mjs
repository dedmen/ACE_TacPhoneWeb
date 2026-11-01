/**
 * In-game group membership events.
 *
 * A debug-only AI unit is spawned into a temporary group and then joined to the
 * local player's group. That triggers the real UnitJoined handler; deleting it
 * triggers UnitLeft. AI units are normally ignored, so this exercises the debug
 * allow-list used only by the test command.
 */

import { assert, ok } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { uniqueRoomName } from '../lib/fake-players.mjs';

export const name = 'group-events';
export const description = 'UnitJoined/UnitLeft add and remove a group member with a system notice.';

export async function run(context) {
    const { client, fake, self } = context;

    await fake.reset();

    const roster = await fake.getPlayerList();
    const ownGroup = roster.groups.find(group => group.memberUids.includes(self.uid));
    assert(ownGroup, 'The player list should include the local player\'s group.');

    const room = await fake.createGroupRoom(
        uniqueRoomName('T7 group events'),
        [],
        [ownGroup.id],
    );

    client.clearPushes(['Message.New', 'Error']);
    await client.request('Messaging.Debug.GroupUnit', { action: 'spawn' });

    const joinedMessage = await client.waitForPush(
        'Message.New',
        data =>
            data.message?.system === true &&
            /joined the group chat \(in-game group change\)/i.test(data.message.content || ''),
    );

    ok(joinedMessage, 'Spawning the AI into the group should post a Join system message.');

    const afterJoin = await fake.getPlayerList();
    const ai = afterJoin.players.find(player => player.uid.startsWith('debug_ai_'));

    ok(ai, 'The spawned AI should appear in the debug player list.');

    const joinedState = await fake.sync();
    const joinedRoom = joinedState.rooms.get(room.id);

    assert(joinedRoom, 'The group room should still exist after the group join.');
    ok(
        joinedRoom.room.participants.some(participant => participant.uid === ai.uid),
        'The signed-in AI should be a room participant.',
    );

    client.clearPushes(['Message.New', 'Error']);
    await client.request('Messaging.Debug.GroupUnit', { action: 'remove', uid: ai.uid });

    const leftMessage = await client.waitForPush(
        'Message.New',
        data =>
            data.message?.system === true &&
            /left the group chat \(in-game group change\)/i.test(data.message.content || ''),
    );

    ok(leftMessage, 'Deleting the AI should post a Leave system message.');

    const leftState = await fake.sync();
    const leftRoom = leftState.rooms.get(room.id);

    assert(leftRoom, 'The group room should still exist after the AI leaves.');
    assert(
        !leftRoom.room.participants.some(participant => participant.uid === ai.uid),
        'The removed AI must no longer be a room participant.',
    );
}
