/**
 * Connection, Hello identity and full chat-state sync.
 */

import {
    equal,
    isBoolean,
    isNumber,
    isString,
    ok,
    oneOf,
} from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import { collectChatState } from '../../../ACE_TacPhone_Main/test/lib/ws-client.mjs';

export const name = 'connection';
export const description = 'Hello returns identity/time/setting and RequestChatState ends with Done.';

export async function run(context) {
    const { client } = context;

    client.clearPushes();

    const hello = await client.request('Hello', { visible: true });

    ok(hello?.ok, 'Hello should succeed');
    ok(hello.self, 'Hello should return the local participant');
    isString(hello.self.uid, 'Hello self.uid should be a string');
    ok(hello.self.uid.length > 0, 'Hello self.uid should not be empty');
    isString(hello.self.name, 'Hello self.name should be a string');
    ok(hello.self.name.length > 0, 'Hello self.name should not be empty');
    oneOf(hello.self.presence, ['available', 'minimized', 'offline'], 'Unexpected self presence');
    isNumber(hello.serverTime, 'Hello serverTime should be a number');
    ok(hello.serverTime >= 0, 'Hello serverTime should not be negative');
    isBoolean(hello.allowEnemyChat, 'Hello allowEnemyChat should be a boolean');

    // Clear sync pushes from any earlier scenario, then ask for a fresh sync.
    client.clearPushes(['ChatState.Room', 'ChatState.Done']);
    await client.request('RequestChatState', {});

    const { done, rooms } = await collectChatState(client, { clearBefore: false });

    ok(done, 'RequestChatState should finish with ChatState.Done');
    isNumber(done.rooms, 'ChatState.Done rooms should be a number');
    equal(rooms.size, done.rooms, 'ChatState.Done should count every synced room');
}
