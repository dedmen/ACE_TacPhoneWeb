/**
 * Leaving rooms.
 *
 * A player may leave a normal group room or a direct room. A member whose whole
 * in-game group was invited cannot leave individually.
 */

import { assert, equal, includes, ok } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { fakePlayersForSide, uniqueRoomName } from '../lib/fake-players.mjs';

export const name = 'leave';
export const description = 'Self-leave works; group-invited members are blocked.';

async function leave(client, roomId, selfUid) {
    client.clearPushes(['Room.Upsert', 'Error']);
    await client.request('RemoveParticipants', {
        roomId,
        playerUids: [selfUid],
    });

    return client.waitForPush(
        null,
        data =>
            (data?.c === 'Room.Upsert' && data.removed === true && data.room?.id === roomId) ||
            (data?.c === 'Error' && data.request === 'RemoveParticipants'),
    );
}

export async function run(context) {
    const { client, fake, self } = context;

    await fake.reset();
    await fake.addFakePlayers();

    const sameSide = fakePlayersForSide(self.side);
    assert(sameSide.length >= 1, 'Need a same-side fake player.');

    // Normal group room: self-leave succeeds.
    const groupRoom = await fake.createGroupRoom(
        uniqueRoomName('T7 leave'),
        [sameSide[0].uid],
    );
    const groupLeft = await leave(client, groupRoom.id, self.uid);

    equal(groupLeft.c, 'Room.Upsert', 'Leaving a normal group room should remove it');
    equal(groupLeft.removed, true, 'The group room removal push should be flagged removed');

    const afterGroup = await fake.sync();
    assert(!afterGroup.rooms.has(groupRoom.id), 'The left group room should be gone after sync.');

    // Direct room: self-leave ends the direct room for both sides.
    const direct = await fake.createDirectRoom(sameSide[0].uid);
    const directLeft = await leave(client, direct.id, self.uid);

    equal(directLeft.c, 'Room.Upsert', 'Leaving a direct room should remove it from the leaver');
    equal(directLeft.removed, true, 'The direct room removal push should be flagged removed');

    // The room itself stays on the server for the remaining participant. There
    // is no fake-page client to observe that side from this single-connection
    // suite; the browser checklist covers the visible one-person room/revive
    // flow with a real second player.
    const afterDirect = await fake.sync();
    assert(!afterDirect.rooms.has(direct.id), 'The left direct room should be gone for the leaver after sync.');

    // Group-invited room: cannot leave individually.
    const roster = await fake.getPlayerList();
    const ownGroup = roster.groups.find(group => group.memberUids.includes(self.uid));
    assert(ownGroup, 'The player list should include the local player\'s group.');

    const locked = await fake.createGroupRoom(
        uniqueRoomName('T7 group lock'),
        [],
        [ownGroup.id],
    );
    const lockedSelf = (locked.participants || []).find(participant => participant.uid === self.uid);
    equal(lockedSelf?.groupInvited, true, 'The locked room should expose groupInvited on the local member.');
    equal(lockedSelf?.groupId, ownGroup.id, 'The stored participant group id should match the group list id.');

    const lockedLeave = await leave(client, locked.id, self.uid);

    equal(lockedLeave.c, 'Error', 'Group-invited members must not be able to leave');
    includes(
        (lockedLeave.message || '').toLowerCase(),
        'cannot leave',
        'The error should explain that a whole-group invite blocks leaving',
    );

    const lockedState = await fake.sync();
    ok(lockedState.rooms.has(locked.id), 'The group-invited room should still exist after the rejected leave.');
}
