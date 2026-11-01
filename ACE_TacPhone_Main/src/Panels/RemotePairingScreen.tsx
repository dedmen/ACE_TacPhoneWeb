import React from "react";
import { remoteSession, type RemoteState } from "../Backend/Networking";
import { t } from "../Backend/i18n";
import styles from "./RemotePairingScreen.module.css";

/**
 * Full-page gate for the publicly hosted UI. It covers the loading/layout
 * underneath until the relay session is attached.
 *
 * Renders nothing in-game, in dev, and on the direct LAN page, where
 * `remoteSession` is null.
 */
export function RemotePairingScreen(): React.ReactElement | null {
    const session = remoteSession;

    const [state, setState] = React.useState<RemoteState>(session?.getState() ?? "connected");
    const [error, setError] = React.useState<string>(session?.getError() ?? "");
    const [code, setCode] = React.useState("");

    React.useEffect(() => {
        if (!session) return;
        setState(session.getState());
        setError(session.getError());

        return session.subscribe(() => {
            setState(session.getState());
            setError(session.getError());
        });
    }, [session]);

    if (!session || state === "connected") return null;

    const submit = (event: React.FormEvent): void => {
        event.preventDefault();
        session.attachCode(code.trim());
    };

    const canEnterCode = state === "need-pairing" || state === "rejected" || state === "host-offline";

    return (
        <div className={styles.backdrop}>
            <div className={styles.card}>
                <h1 className={styles.title}>{t('STR_ACE_Tacphone_RemoteAccess_PairingTitle')}</h1>

                {state === "attaching" && (
                    <p className={styles.status}>{t('STR_ACE_Tacphone_RemoteAccess_PairingConnecting')}</p>
                )}

                {state === "need-pairing" && (
                    <p className={styles.status}>
                        {t('STR_ACE_Tacphone_RemoteAccess_PairingNeedCode')}
                    </p>
                )}

                {state === "host-offline" && (
                    <p className={styles.status}>
                        {t('STR_ACE_Tacphone_RemoteAccess_PairingHostOffline')}
                    </p>
                )}

                {state === "rejected" && (
                    <p className={styles.status}>
                        {t('STR_ACE_Tacphone_RemoteAccess_PairingRejected')}
                    </p>
                )}

                {(canEnterCode || state === "attaching") && (
                    <form className={styles.form} onSubmit={submit}>
                        <input
                            className={styles.input}
                            value={code}
                            onChange={(event) => setCode(event.target.value)}
                            placeholder="XXXX-XXXX-XX"
                            autoComplete="off"
                            autoCapitalize="characters"
                            spellCheck={false}
                            inputMode="text"
                        />
                        <button className={styles.button} type="submit" disabled={!code.trim()}>
                            {t('STR_ACE_Tacphone_RemoteAccess_PairingConnect')}
                        </button>
                    </form>
                )}

                {state === "host-offline" && (
                    <button
                        className={styles.secondary}
                        type="button"
                        onClick={() => session.retry()}
                    >
                        {t('STR_ACE_Tacphone_RemoteAccess_PairingRetryNow')}
                    </button>
                )}

                {error && state !== "attaching" && (
                    <p className={styles.error}>{error}</p>
                )}

                <p className={styles.footer}>
                    {t('STR_ACE_Tacphone_RemoteAccess_PairingFooter')}{" "}
                    <a
                        href="https://www.patreon.com/c/dedmen"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        patreon.com/c/dedmen
                    </a>
                </p>
            </div>
        </div>
    );
}

export default RemotePairingScreen;
