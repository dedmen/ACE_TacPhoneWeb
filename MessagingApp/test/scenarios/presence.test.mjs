/**
 * Presence transitions for the local phone, external pages and fake players.
 *
 * The in-game client id is `local` and follows the TacPhone display mode. A
 * WebSocket connection is an external page client and reports its own
 * visibility through `SetClientPresence`.
 */

import {
    assert,
    equal,
    ok,
} from '../lib/assertions.mjs';
import {
    delay,
    fakePlayersForSide,
    uniqueRoomName,
} from '../lib/fake-players.mjs';
import { collectChatState } from '../lib/ws-client.mjs';

export const name = 'presence';
export const description = 'Local display modes, external visibility and fake player presence.';

async function requestSync(client) {
    client.clearPushes(['ChatState.Room', 'ChatState.Done']);
    await client.request('RequestChatState', {});
    return collectChatState(client, { clearBefore: false });
}

async function selfPresence(client, roomId, selfUid) {
    const state = await requestSync(client);
    const room = state.rooms.get(roomId);

    return room?.room.participants.find(participant => participant.uid === selfUid)?.presence;
}

async function participantPresence(client, roomId, uid) {
    const state = await requestSync(client);
    const room = state.rooms.get(roomId);

    return room?.room.participants.find(participant => participant.uid === uid)?.presence;
}

async function expectPresence(read, expected, label, timeout = 6000) {
    const deadline = Date.now() + timeout;
    let last;

    while (Date.now() < deadline) {
        last = await read();

        if (last === expected) {
            return;
        }

        await delay(120);
    }

    equal(last, expected, `${label}: expected presence "${expected}", got "${last}"`);
}

export async function run(context) {
    const { client, fake, self, openClient } = context;

    await fake.reset();
    await fake.addFakePlayers();

    const sameSide = fakePlayersForSide(self.side);
    assert(sameSide.length >= 1, `No fake player on the local side (${self.side}).`);

    const roommate = sameSide[0];
    const roomName = uniqueRoomName('T7 presence');
    const room = await fake.createGroupRoom(roomName, [roommate.uid]);

    const readSelf = () => selfPresence(client, room.id, self.uid);
    let second;

    try {
        // Only the in-game phone is visible for this part. The debug setter
        // now really opens/closes the phone, so this works even if the user
        // started with the phone open in HUD or dialog mode.
        await client.request('SetClientPresence', { visible: false });

        // Other remote phones/tablets/dev pages are independent clients. If one
        // is visible, the player is legitimately "available" even with the
        // in-game phone closed, so the minimized branch cannot be deterministic.
        const status = await client.request('Messaging.Debug.Status', {});
        const visibility = status?.clientVisibility;

        if (visibility && typeof visibility === 'object') {
            const extraVisible = Object.entries(visibility)
                .filter(([id, visible]) => id !== 'local' && visible === true)
                .map(([id]) => id);

            if (extraVisible.length > 0) {
                throw new Error(
                    'Close every other remote phone/tablet/dev page before running the presence scenario. ' +
                        `Visible external clients: ${extraVisible.join(', ')}`,
                );
            }
        }

        await fake.setLocalDisplayMode('HUD');
        await expectPresence(readSelf, 'available', 'HUD should make the local phone available');

        await fake.setLocalDisplayMode('DIALOG');
        await expectPresence(readSelf, 'available', 'DIALOG should make the local phone available');

        await fake.setLocalDisplayMode('CLOSED');
        await expectPresence(readSelf, 'minimized', 'CLOSED should minimize the local phone');

        // HIDDEN is transient while the phone is actually usable; the real
        // openDisplay PFH may promote it back to HUD. Only assert it if the
        // mode survived the tick.
        await fake.setLocalDisplayMode('HIDDEN');

        const hiddenStatus = await client.request('Messaging.Debug.Status', {});
        if (hiddenStatus?.currentShowMode === 3) {
            await expectPresence(readSelf, 'minimized', 'HIDDEN should minimize the local phone');
        }

        // A second external page becomes visible, so the player is available again.
        second = await openClient({ name: 'presence-second' });
        await second.request('Hello', { visible: true });

        await fake.setLocalDisplayMode('CLOSED');
        await expectPresence(
            readSelf,
            'available',
            'A visible external page should make the player available',
        );

        await second.request('SetClientPresence', { visible: false });
        await expectPresence(
            readSelf,
            'minimized',
            'Hiding the external page should minimize the player again',
        );

        await second.close();
        second = undefined;

        await expectPresence(
            readSelf,
            'minimized',
            'Closing the external page should leave the local phone minimized',
        );

        // Fake player presence is visible in the roster and in room sync.
        await fake.setPresence(roommate.uid, 'available');

        const roster = await fake.getPlayerList();
        const rosterEntry = roster.players.find(player => player.uid === roommate.uid);

        ok(rosterEntry, `Player list should contain ${roommate.uid}`);
        equal(rosterEntry.presence, 'available', 'Fake player presence should be available');

        await expectPresence(
            () => participantPresence(client, room.id, roommate.uid),
            'available',
            'Room sync should report the fake player as available',
        );

        await fake.setPresence(roommate.uid, 'offline');

        const offlineRoster = await fake.getPlayerList();
        const offlineEntry = offlineRoster.players.find(player => player.uid === roommate.uid);

        ok(offlineEntry, `Player list should still contain ${roommate.uid}`);
        equal(offlineEntry.presence, 'offline', 'Fake player presence should be offline');

        await expectPresence(
            () => participantPresence(client, room.id, roommate.uid),
            'offline',
            'Room sync should report the fake player as offline',
        );
    } finally {
        if (second) {
            await second.close().catch(() => {});
        }

        // Do not leave the simulated display mode behind.
        await fake.setLocalDisplayMode('HUD').catch(() => {});
        await client.request('SetClientPresence', { visible: true }).catch(() => {});
    }
}
