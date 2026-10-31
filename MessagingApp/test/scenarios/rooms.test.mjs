/**
 * Roster lookup, group-room creation and direct-room creation.
 */

import {
    assert,
    equal,
    includes,
    isArray,
    isBoolean,
    isString,
    ok,
} from '../lib/assertions.mjs';
import { fakePlayersForSide, uniqueRoomName } from '../lib/fake-players.mjs';

export const name = 'rooms';
export const description = 'Fake players, player list, group room and direct room creation.';

export async function run(context) {
    const { fake, self } = context;

    await fake.reset();
    await fake.addFakePlayers();

    const sameSide = fakePlayersForSide(self.side);

    assert(
        sameSide.length >= 2,
        `Need at least two fake players on the local side (${self.side || '<unknown>'}); ` +
            `available: ${sameSide.map(player => player.uid).join(', ') || 'none'}. ` +
            'Run the suite on a mission where the player has a WEST or EAST side.',
    );

    const [first, second] = sameSide;

    const roster = await fake.getPlayerList();

    isArray(roster.players, 'PlayerList.State players should be an array');
    isArray(roster.groups, 'PlayerList.State groups should be an array');
    isBoolean(roster.allowEnemyChat, 'PlayerList.State allowEnemyChat should be a boolean');

    const firstEntry = roster.players.find(player => player.uid === first.uid);
    ok(firstEntry, `Player list should contain ${first.uid}`);
    equal(firstEntry.name, first.name, 'Fake player name should match the generator');
    equal(firstEntry.side, first.side, 'Fake player side should match the generator');
    equal(firstEntry.groupId, first.groupId, 'Fake player group id should match the generator');
    equal(firstEntry.presence, first.presence, 'Fake player presence should match the generator');

    const groupName = uniqueRoomName('T7 rooms group');
    const groupRoom = await fake.createGroupRoom(groupName, [first.uid, second.uid]);

    equal(groupRoom.kind, 'group', 'Created room should be a group room');
    ok(groupRoom.id.startsWith('grp:'), `Group room id should start with grp:, got ${groupRoom.id}`);
    equal(groupRoom.name, groupName, 'Group room should keep its name');
    isString(groupRoom.createdBy, 'Group room should have a creator UID');
    equal(groupRoom.createdBy, self.uid, 'The local player should be the group room creator');

    const groupUids = groupRoom.participants.map(participant => participant.uid);

    includes(groupUids, self.uid, 'Group room should include the local player');
    includes(groupUids, first.uid, `Group room should include ${first.uid}`);
    includes(groupUids, second.uid, `Group room should include ${second.uid}`);

    const selfParticipant = groupRoom.participants.find(participant => participant.uid === self.uid);
    equal(selfParticipant?.creator, true, 'The local player should be marked as creator');

    const directRoom = await fake.createDirectRoom(second.uid);
    const expectedDirectId = `dm:${[self.uid, second.uid].sort().join(':')}`;

    equal(directRoom.kind, 'direct', 'Created room should be a direct room');
    equal(directRoom.id, expectedDirectId, 'Direct room id should be deterministic');
    equal(directRoom.participants.length, 2, 'Direct room should contain exactly two participants');

    const directUids = directRoom.participants.map(participant => participant.uid);

    includes(directUids, self.uid, 'Direct room should include the local player');
    includes(directUids, second.uid, 'Direct room should include the other player');
}
