/**
 * React binding for the module-level store.
 *
 * `chatStore` is a class instance, so its methods must be called through the
 * object; passing the unbound `chatStore.getSnapshot` to `useSyncExternalStore`
 * would lose `this`. The wrappers below keep the receiver and give every panel
 * one stable subscribe/getSnapshot pair.
 */

import { useSyncExternalStore } from 'react';

import type { ChatStoreState } from './state/ChatStore';
import { chatStore } from './state/ChatStore';

const subscribe = (listener: () => void): (() => void) => chatStore.subscribe(listener);
const getSnapshot = (): ChatStoreState => chatStore.getSnapshot();

/** Current store snapshot; re-renders on every store change. */
export function useChatStore(): ChatStoreState {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
