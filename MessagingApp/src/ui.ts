/**
 * Panel-wide UI actions shared by the chat view, message list and object cards.
 *
 * The dialogs live at the root of the panel so they can be closed as a group
 * before a card routes to another app: the host `TargetChooserDialog` must be
 * the only modal on screen when several Map panels are candidates.
 */

import { createContext, useContext } from 'react';

/** Actions the panel exposes to its children. */
export interface MessengerUi {
    /** Opens the create-room dialog. */
    openCreateRoom(): void;
    /** Opens the add-participants dialog for one room. */
    openAddParticipants(roomId: string): void;
    /** Opens the member list of one room. */
    openMembers(roomId: string): void;
    /** Opens the forward target selector for one message. */
    openForward(roomId: string, messageId: string): void;
    /** Opens the invite selector for one room. */
    openInvite(roomId: string): void;
    /** Closes every Messenger dialog without running its action. */
    closeDialogs(): void;
    /** Bumped when the inter-app registry changes, so object cards re-resolve previews. */
    rendererTick: number;
}

const noop = (): void => {
    // Default context: outside the panel (a stray render) nothing happens.
};

const DEFAULT_UI: MessengerUi = {
    openCreateRoom: noop,
    openAddParticipants: noop,
    openMembers: noop,
    openForward: noop,
    openInvite: noop,
    closeDialogs: noop,
    rendererTick: 0,
};

export const MessengerUiContext = createContext<MessengerUi>(DEFAULT_UI);

/** Access to the dialog actions of the surrounding panel. */
export function useMessengerUi(): MessengerUi {
    return useContext(MessengerUiContext);
}
