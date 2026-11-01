/**
 * In-game group rooms.
 *
 * The server stores only PlayerUIDs, but the leader carries the groupInvited
 * flag and the room follows UnitJoined / UnitLeft / Deleted. This scenario
 * verifies the flag and that AI members are not added.
 */

import { assert, equal, ok } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { uniqueRoomName } from '../lib/fake-players.mjs';

export const name = 'groups';
export const description = 'Group invite flag, grouped participants and AI exclusion.';

export async function run(context) {
    const { fake, self } = context;

    await fake.reset();

    const roster = await fake.getPlayerList();
    const ownGroup = roster.groups.find(group => group.memberUids.includes(self.uid));

    assert(ownGroup, 'The player list should include the local player\'s group.');

    const room = await fake.createGroupRoom(uniqueRoomName('T7 groups'), [], [ownGroup.id]);
    const participants = room.participants || [];

    ok(
        participants.some(participant => participant.uid === self.uid),
        'Creating a room from a group should include the local player.',
    );

    const selfParticipant = participants.find(participant => participant.uid === self.uid);
    equal(
        selfParticipant.groupInvited,
        true,
        'The group leader should carry the groupInvited flag.',
    );

    equal(
        participants.length,
        ownGroup.memberUids.length,
        'Only the group\'s human members should become participants (AI members are ignored).',
    );
}
