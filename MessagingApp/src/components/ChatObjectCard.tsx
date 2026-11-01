import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import type { ChatObject, ChatObjectPreview } from '../api';
import { CHAT_OBJECT_KIND_ROOM_INVITE } from '../protocol';
import type { RoomInviteObjectData } from '../protocol';
import { notify } from '../objectActions';
import { activateChatObject, isObjectInteractive } from '../objectActions';
import { safeColor } from '../format';
import { chatStore } from '../state/ChatStore';
import { useMessengerUi } from '../ui';
import { ChatIcon, ForwardIcon } from './icons';
import { useObjectIcon } from './useObjectIcon';
import { t } from '../i18n';
import styles from './ChatObjectCard.module.css';

interface ChatObjectCardProps {
    object: ChatObject;
    /** Ids of the rooms the local player is already in, for invite cards. */
    joinedRoomIds: ReadonlySet<string>;
}

/** Reads the payload of a room invite object. */
function readInvite(object: ChatObject): RoomInviteObjectData | undefined {
    if (object.kind !== CHAT_OBJECT_KIND_ROOM_INVITE) return undefined;
    if (typeof object.data !== 'object' || object.data === null) return undefined;

    const data = object.data as Partial<RoomInviteObjectData>;
    if (typeof data.roomId !== 'string' || data.roomId === '') return undefined;

    return {
        roomId: data.roomId,
        roomName: typeof data.roomName === 'string' ? data.roomName : '',
        inviteKey: typeof data.inviteKey === 'string' ? data.inviteKey : undefined,
        kind: data.kind,
        inviterName: typeof data.inviterName === 'string' ? data.inviterName : undefined,
    };
}

/** Card of a room invite, with the Join action. */
function RoomInviteCard({ invite, joined }: { invite: RoomInviteObjectData; joined: boolean }): JSX.Element {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const ui = useMessengerUi();

    const join = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);

        try {
            const result = await chatStore.joinRoom(invite.roomId, invite.inviteKey);

            if (result.ok) {
                chatStore.setActiveRoom(result.roomId);
                ui.closeDialogs();

                return;
            }

            setError(result.error ?? t('STR_ACE_Tacphone_Messenger_Invite_JoinFailed'));
            notify(t('STR_ACE_Tacphone_Messenger_Invite_JoinFailedTitle'), result.error);
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            setError(message);
            notify(t('STR_ACE_Tacphone_Messenger_Invite_JoinFailedTitle'), message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={styles.invite}>
            <div className={styles.inviteIcon}>
                <ChatIcon className={styles.glyph} />
            </div>
            <div className={styles.inviteText}>
                <div className={styles.title}>{invite.roomName.trim() || t('STR_ACE_Tacphone_Messenger_Invite_Title')}</div>
                <div className={styles.subtitle}>{t('STR_ACE_Tacphone_Messenger_Invite_Title')}</div>
                {error && <div className={styles.error}>{error}</div>}
            </div>
            <button
                type="button"
                className={styles.joinButton}
                disabled={joined || busy}
                onClick={() => {
                    void join();
                }}
            >
                {joined
                    ? t('STR_ACE_Tacphone_Messenger_Invite_Joined')
                    : busy
                        ? t('STR_ACE_Tacphone_Messenger_Invite_Joining')
                        : t('str_a3_rscdisplaydynamicgroups_button_join')}
            </button>
        </div>
    );
}

/**
 * One generic chat object.
 *
 * The stored preview renders the card immediately; the renderer registered by
 * the app that owns the object kind may refine it asynchronously. Clicking
 * prefers that renderer's `activate()`, then the serialized action routed through
 * the host. Messenger contains no object-kind-specific routing.
 */
export function ChatObjectCard({ object, joinedRoomIds }: ChatObjectCardProps): JSX.Element {
    const ui = useMessengerUi();
    const [asyncPreview, setAsyncPreview] = useState<{ data: unknown; tick: number; value: ChatObjectPreview | undefined } | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    // Renderers that answer synchronously are applied during render; the stored
    // preview is the fallback until an asynchronous renderer replies.
    const syncPreview = chatStore.getObjectPreview(object.kind, object.data, object.preview);
    const preview = asyncPreview !== undefined
        && asyncPreview.data === object.data
        && asyncPreview.tick === ui.rendererTick
        ? asyncPreview.value
        : syncPreview;

    useEffect(() => {
        let active = true;

        void chatStore
            .resolveObjectPreview(object.kind, object.data, object.preview)
            .then(resolved => {
                if (active) setAsyncPreview({ data: object.data, tick: ui.rendererTick, value: resolved });
            })
            .catch(() => {
                // A broken renderer must never blank the card; the stored
                // preview stays visible.
            });

        return () => {
            active = false;
        };
    }, [object.kind, object.data, object.preview, ui.rendererTick]);

    const invite = readInvite(object);
    const iconUrl = useObjectIcon(preview?.icon);

    if (invite) {
        return <RoomInviteCard invite={invite} joined={joinedRoomIds.has(invite.roomId)} />;
    }

    const accent = safeColor(preview?.color);
    const interactive = isObjectInteractive(object);

    const activate = async (): Promise<void> => {
        if (!interactive || busy) return;

        // The host target chooser must be able to appear above our dialogs.
        ui.closeDialogs();
        setBusy(true);
        setError(undefined);

        try {
            const result = await activateChatObject(object);
            if (result.status === 'error') setError(result.error);
        } finally {
            setBusy(false);
        }
    };

    const maskStyle = iconUrl
        ? {
            WebkitMaskImage: `url("${iconUrl}")`,
            maskImage: `url("${iconUrl}")`,
            backgroundColor: accent ?? 'currentColor',
        }
        : undefined;

    return (
        <div className={styles.card} data-interactive={interactive}>
            <button
                type="button"
                className={styles.cardButton}
                disabled={!interactive || busy}
                onClick={() => {
                    void activate();
                }}
            >
                <span
                    className={styles.iconWrap}
                    style={accent ? { borderColor: accent } : undefined}
                >
                    {iconUrl ? (
                        <span className={styles.icon} style={maskStyle} aria-hidden="true" />
                    ) : (
                        <ChatIcon className={styles.glyph} />
                    )}
                </span>
                <span className={styles.text}>
                    <span className={styles.title}>{preview?.title ?? object.kind}</span>
                    {preview?.subtitle && <span className={styles.subtitle}>{preview.subtitle}</span>}
                </span>
                {interactive && <ForwardIcon className={styles.openIcon} />}
            </button>

            {error && <div className={styles.error}>{error}</div>}
        </div>
    );
}
