/**
 * Protocol-level marker chat object test.
 *
 * This only verifies the wire/storage shape. The live Map panel checks (context
 * menu, focusMarker, deleted marker and flyTo) are in
 * `test/browser/ui-checklist.md`, because they need the Map UI and a real
 * marker in the running mission.
 */

import {
    assert,
    deepEqual,
    equal,
    isArray,
    isNumber,
    ok,
} from '../lib/assertions.mjs';
import { fakePlayersForSide, uniqueRoomName } from '../lib/fake-players.mjs';

export const name = 'map-marker';
export const description = 'map.marker chat object round-trips with data.position intact.';

export async function run(context) {
    const { fake, self } = context;

    await fake.reset();
    await fake.addFakePlayers();

    const sameSide = fakePlayersForSide(self.side);
    assert(sameSide.length >= 1, `No fake player on the local side (${self.side}).`);

    const roomName = uniqueRoomName('T7 map marker');
    const room = await fake.createGroupRoom(roomName, [sameSide[0].uid]);

    const markerName = `t7_marker_${Date.now()}`;
    const marker = {
        kind: 'map.marker',
        version: 1,
        data: {
            name: markerName,
            type: 'hd_dot',
            color: '#ff5500',
            text: 'T7 marker text',
            label: 'T7 marker label',
            position: [1234.5, 5678.25],
        },
        preview: {
            title: 'T7 marker text',
            subtitle: 'Map marker',
            icon: '\\a3\\ui_f\\data\\mil_symbol_inf.paa',
            color: '#ff5500',
        },
        action: {
            service: 'map',
            panelId: 'ACE_TacPhone_Map',
            method: 'focusMarker',
            args: [markerName],
        },
    };

    const message = await fake.sendMessage(room.id, '', [marker]);

    ok(message.objects, 'Message echo should carry the marker object');
    deepEqual(message.objects[0], marker, 'Message echo should preserve the full marker object');

    const state = await fake.sync();
    const syncedRoom = state.rooms.get(room.id);

    ok(syncedRoom, 'Chat state should contain the marker message room');

    const syncedMessage = syncedRoom.messages.find(entry => entry.id === message.id);

    ok(syncedMessage, 'Chat state should contain the marker message');

    const stored = syncedMessage.objects?.[0];

    ok(stored, 'Stored message should still carry an object');
    equal(stored.kind, 'map.marker', 'Stored object kind should be map.marker');
    equal(stored.version, 1, 'Stored object version should be 1');
    equal(stored.data.name, markerName, 'Stored marker should keep its name');
    isArray(stored.data.position, 'Stored marker position should be an array');
    equal(stored.data.position.length, 2, 'Stored marker position should have two components');
    isNumber(stored.data.position[0], 'Stored position x should be a number');
    isNumber(stored.data.position[1], 'Stored position y should be a number');
    deepEqual(
        stored.data.position,
        [1234.5, 5678.25],
        'Stored data.position should round-trip unchanged',
    );
    equal(stored.preview?.subtitle, 'Map marker', 'Stored preview subtitle should say Map marker');
    equal(stored.action?.method, 'focusMarker', 'Stored action should target focusMarker');
    equal(stored.action?.service, 'map', 'Stored action service should be map');
    deepEqual(stored.action?.args, [markerName], 'Stored action should carry the marker name');
}
