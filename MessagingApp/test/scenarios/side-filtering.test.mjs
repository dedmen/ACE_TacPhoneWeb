/**
 * Side restriction: players follow the enemy-chat setting, groups never do.
 */

import {
    assert,
    equal,
    includes,
    ok,
} from '../lib/assertions.mjs';
import {
    FAKE_GROUPS,
    FAKE_UIDS,
    fakePlayersForSide,
    isFakeUid,
} from '../lib/fake-players.mjs';

export const name = 'side-filtering';
export const description = 'Enemy players hidden by default, shown when enabled; groups stay same-side.';

function fakeGroupsForSide(side) {
    return Object.values(FAKE_GROUPS).filter(group => group.side === side);
}

export async function run(context) {
    const { fake, self } = context;

    await fake.reset();
    await fake.addFakePlayers();

    const sameSide = fakePlayersForSide(self.side);

    assert(
        sameSide.length >= 1,
        `No fake player on the local side (${self.side}). ` +
            'Run the suite on a mission where the player has a WEST or EAST side.',
    );

    try {
        await fake.setAllowEnemyChat(false);
        const off = await fake.getPlayerList();

        equal(off.allowEnemyChat, false, 'Enemy chat should report disabled');
        equal(
            off.players.some(player => isFakeUid(player.uid) && player.side !== self.side),
            false,
            `Player list must not contain fake players from another side (${self.side})`,
        );
        equal(
            off.players.every(player => !player.side || player.side === self.side),
            true,
            'Default player list should only contain same-side players',
        );
        ok(
            off.players.some(player => isFakeUid(player.uid) && player.side === self.side),
            'Default player list should still contain same-side fake players',
        );

        if (self.side === 'WEST') {
            equal(
                off.players.some(player => player.uid === 'fake_3' || player.uid === 'fake_6'),
                false,
                'EAST fake players (fake_3, fake_6) must be hidden when enemy chat is off',
            );
        }

        for (const group of off.groups) {
            if (group.side) {
                equal(group.side, self.side, 'Default group list should only contain same-side groups');
            }
        }

        equal(
            off.groups.some(group => group.id === FAKE_GROUPS.fake_grp_3.id) &&
                self.side !== 'EAST',
            false,
            'EAST fake group must not appear for a non-EAST player',
        );

        await fake.setAllowEnemyChat(true);
        const on = await fake.getPlayerList();

        equal(on.allowEnemyChat, true, 'Enemy chat should report enabled');

        const listedFakeUids = on.players
            .filter(player => isFakeUid(player.uid))
            .map(player => player.uid);

        for (const uid of FAKE_UIDS) {
            includes(listedFakeUids, uid, `Enemy chat enabled should list ${uid}`);
        }

        for (const group of on.groups) {
            equal(
                group.side,
                self.side,
                'Groups must stay same-side even when enemy chat is enabled',
            );
        }

        const visibleFakeGroups = on.groups
            .filter(group => group.id.startsWith('fake_grp_'))
            .map(group => group.id);

        for (const group of fakeGroupsForSide(self.side)) {
            includes(
                visibleFakeGroups,
                group.id,
                `Same-side fake group ${group.id} should be listed`,
            );
        }

        for (const group of fakeGroupsForSide(self.side === 'WEST' ? 'EAST' : 'WEST')) {
            equal(
                visibleFakeGroups.includes(group.id),
                false,
                `Opposite-side fake group ${group.id} must never be listed`,
            );
        }
    } finally {
        // Never leave the debug override enabled for later scenarios.
        try {
            await fake.setAllowEnemyChat(false);
        } catch {
            // The scenario failure is more useful than a cleanup failure.
        }
    }
}
