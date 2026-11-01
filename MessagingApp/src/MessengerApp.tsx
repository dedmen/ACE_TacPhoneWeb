import type { JSX, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AppProps, PanelInfo } from '@ace-tacphone/api';

import { isDebugEnabled } from './debug';
import { cancelShareRequest, getPendingShare, settleShare, subscribeShareRequests } from './dialogBus';
import { useServerNow } from './format';
import { registerMessengerService } from './service';
import { chatStore } from './state/ChatStore';
import { roomDisplayName } from './state/roomUtils';
import type { MessengerUi } from './ui';
import { MessengerUiContext } from './ui';
import { useChatStore } from './useChatStore';
import { AddParticipantsDialog } from './components/AddParticipantsDialog';
import { ChatView } from './components/ChatView';
import { CreateRoomDialog } from './components/CreateRoomDialog';
import { DebugToolbar } from './components/DebugToolbar';
import { MemberListDialog } from './components/MemberListDialog';
import { RoomList } from './components/RoomList';
import { TargetSelectorDialog } from './components/TargetSelectorDialog';
import { ChatIcon } from './components/icons';
import { EmptyState } from './components/Ui';
import { t } from './i18n';
import theme from './styles/theme.module.css';
import styles from './MessengerApp.module.css';

/** Which dialog is open. Dialogs are modal and mutually exclusive. */
type DialogState =
    | { type: 'create' }
    | { type: 'add'; roomId: string }
    | { type: 'members'; roomId: string }
    | { type: 'forward'; roomId: string; messageId: string }
    | { type: 'invite'; roomId: string };

/** Width below which the panel shows one pane at a time. */
const NARROW_WIDTH = 560;

// Stable wrappers for `useSyncExternalStore`; the dialog bus is module state.
const subscribeShareStore = (listener: () => void): (() => void) => subscribeShareRequests(listener);
const getShareSnapshot = () => getPendingShare();

/** Observes the width of the panel content; flexlayout resizes it freely. */
function useElementWidth(ref: RefObject<HTMLElement | null>): number {
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        setWidth(element.clientWidth);

        const observer = new ResizeObserver(entries => {
            const entry = entries[0];
            if (entry) setWidth(entry.contentRect.width);
        });
        observer.observe(element);

        return () => {
            observer.disconnect();
        };
    }, [ref]);

    return width;
}

/**
 * The Messenger panel.
 *
 * Two-pane on a wide panel (room list + conversation), one pane at a time on a
 * narrow one. All state comes from the module-level `chatStore`; this component
 * only owns which room is being viewed on a small panel and which dialog (if
 * any) is open.
 */
export function MessengerApp(props: AppProps): JSX.Element {
    const state = useChatStore();
    const now = useServerNow(state);
    const pendingShare = useSyncExternalStore(subscribeShareStore, getShareSnapshot, getShareSnapshot);
    const { panel } = props;

    const rootRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(rootRef);
    const narrow = width > 0 && width < NARROW_WIDTH;

    const [dialog, setDialog] = useState<DialogState | null>(null);
    const [mobileView, setMobileView] = useState<'list' | 'chat'>('list');
    const [rendererTick, setRendererTick] = useState(0);

    const selfUid = state.self?.uid;
    const activeRoom = state.rooms.find(room => room.id === state.activeRoomId);

    // -- lifecycle ----------------------------------------------------------

    useEffect(() => {
        void chatStore.initialize();
    }, []);

    // Report panel visibility/focus for notification suppression.
    useEffect(() => {
        const update = (): void => {
            let info: PanelInfo | undefined;
            try {
                info = panel.getInfo();
            } catch {
                info = undefined;
            }

            const documentVisible = typeof document === 'undefined'
                || document.visibilityState === 'visible';
            const windowFocused = typeof document === 'undefined' || document.hasFocus();
            const visible = documentVisible && info?.isVisible === true;
            const active = visible && info?.isActive === true && windowFocused;

            chatStore.setPanelState({ visible, active });
        };

        update();

        const unsubscribePanels = window.TacPhone.panels.onDidChange(update);
        document.addEventListener('visibilitychange', update);
        window.addEventListener('focus', update);
        window.addEventListener('blur', update);

        return () => {
            unsubscribePanels();
            document.removeEventListener('visibilitychange', update);
            window.removeEventListener('focus', update);
            window.removeEventListener('blur', update);
            chatStore.setPanelState({ visible: false, active: false });
        };
    }, [panel]);

    // The panel is the provider of the `messenger` inter-app service. The host
    // keys the registration by panel instance, so StrictMode's double mount only
    // unregisters and registers again.
    useEffect(() => registerMessengerService(panel), [panel]);

    // Object renderers (for example the Map) may register after this panel
    // mounted; re-resolve previews when the registry changes.
    useEffect(() => {
        try {
            return window.TacPhone.interApp.onDidChange(() => {
                setRendererTick(tick => tick + 1);
            });
        } catch (error) {
            console.warn('Messaging: could not watch the inter-app registry:', error);

            return undefined;
        }
    }, []);

    // A share request from another app needs the target selector, so any other
    // dialog is closed as soon as one arrives; unmounting settles it as
    // cancelled.
    useEffect(() => subscribeShareRequests(() => {
        if (getPendingShare()) setDialog(null);
    }), []);

    useEffect(() => () => {
        cancelShareRequest();
    }, []);

    // Open dialogs need a current roster and group list.
    useEffect(() => {
        if (dialog === null && !pendingShare) return;

        void chatStore.requestPlayerList();
    }, [dialog, pendingShare]);

    // -- actions ------------------------------------------------------------

    const ui = useMemo<MessengerUi>(() => ({
        openCreateRoom: () => {
            setDialog({ type: 'create' });
        },
        openAddParticipants: roomId => {
            setDialog({ type: 'add', roomId });
        },
        openMembers: roomId => {
            setDialog({ type: 'members', roomId });
        },
        openForward: (roomId, messageId) => {
            setDialog({ type: 'forward', roomId, messageId });
        },
        openInvite: roomId => {
            setDialog({ type: 'invite', roomId });
        },
        closeDialogs: () => {
            setDialog(null);
        },
        rendererTick,
    }), [rendererTick]);

    const openRoom = (roomId: string): void => {
        chatStore.setActiveRoom(roomId);
        setMobileView('chat');
    };

    const closeDialog = (): void => {
        setDialog(null);
    };

    const showChat = narrow && activeRoom !== undefined && mobileView === 'chat';
    const showListPane = !narrow || !showChat;
    const showChatPane = !narrow || showChat;

    const dialogRoom = dialog !== null && 'roomId' in dialog
        ? state.rooms.find(room => room.id === dialog.roomId)
        : undefined;

    const forwardMessage = dialog?.type === 'forward'
        ? state.messages[dialog.roomId]?.find(message => message.id === dialog.messageId)
        : undefined;

    return (
        <MessengerUiContext.Provider value={ui}>
            <div ref={rootRef} className={`${theme.theme} ${styles.root}`} data-narrow={narrow}>
                {showListPane && (
                    <div className={styles.listPane}>
                        <RoomList
                            rooms={state.rooms}
                            activeRoomId={state.activeRoomId}
                            selfUid={selfUid}
                            selfPresence={state.selfPresence}
                            connected={state.connected}
                            syncing={state.syncing}
                            now={now}
                            onSelect={openRoom}
                            onCreate={() => {
                                setDialog({ type: 'create' });
                            }}
                        />
                    </div>
                )}

                {showChatPane && (
                    <div className={styles.chatPane}>
                        {activeRoom ? (
                            <ChatView
                                room={activeRoom}
                                state={state}
                                now={now}
                                narrow={narrow}
                                onBack={() => {
                                    setMobileView('list');
                                }}
                            />
                        ) : (
                            <EmptyState
                                title={narrow ? t('STR_ACE_Tacphone_Messenger_App_NoConversation') : t('STR_ACE_Tacphone_Messenger_Title')}
                                hint={t('STR_ACE_Tacphone_Messenger_App_PickRoom')}
                                icon={<ChatIcon />}
                            />
                        )}
                    </div>
                )}

                {isDebugEnabled() && <DebugToolbar />}

                {dialog?.type === 'create' && (
                    <CreateRoomDialog
                        players={state.players}
                        groups={state.groups}
                        selfUid={selfUid}
                        onClose={closeDialog}
                        onCreated={roomId => {
                            closeDialog();
                            openRoom(roomId);
                        }}
                    />
                )}

                {dialog?.type === 'add' && dialogRoom && (
                    <AddParticipantsDialog
                        room={dialogRoom}
                        players={state.players}
                        groups={state.groups}
                        selfUid={selfUid}
                        onClose={closeDialog}
                    />
                )}

                {dialog?.type === 'members' && dialogRoom && (
                    <MemberListDialog room={dialogRoom} selfUid={selfUid} onClose={closeDialog} />
                )}

                {dialog?.type === 'forward' && forwardMessage && (
                    <TargetSelectorDialog
                        mode="forward"
                        rooms={state.rooms}
                        players={state.players}
                        groups={state.groups}
                        selfUid={selfUid}
                        sourceRoomId={dialog.roomId}
                        message={forwardMessage}
                        onClose={closeDialog}
                    />
                )}

                {dialog?.type === 'invite' && dialogRoom && (
                    <TargetSelectorDialog
                        mode="invite"
                        rooms={state.rooms}
                        players={state.players}
                        groups={state.groups}
                        selfUid={selfUid}
                        sourceRoomId={dialog.roomId}
                        onClose={closeDialog}
                    />
                )}

                {pendingShare && (
                    <TargetSelectorDialog
                        mode="share"
                        rooms={state.rooms}
                        players={state.players}
                        groups={state.groups}
                        selfUid={selfUid}
                        sourceRoomId=""
                        objects={pendingShare.objects}
                        onClose={() => {
                            settleShare({ ok: false, cancelled: true });
                        }}
                        onShareResult={result => {
                            settleShare(result);
                        }}
                    />
                )}

                {/*
                 * Keeps the selected room title available to assistive tech even
                 * when the chat pane is not rendered in the narrow layout.
                 */}
                <span className={styles.liveTitle} aria-live="polite">
                    {activeRoom ? roomDisplayName(activeRoom, selfUid) : ''}
                </span>
            </div>
        </MessengerUiContext.Provider>
    );
}
