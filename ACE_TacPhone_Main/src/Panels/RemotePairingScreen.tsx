import React from "react";
import { remoteSession, type RemoteState } from "../Backend/Networking";
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
                <h1 className={styles.title}>TacPhone Remote Access</h1>

                {state === "attaching" && (
                    <p className={styles.status}>Connecting to the game…</p>
                )}

                {state === "need-pairing" && (
                    <p className={styles.status}>
                        Open the <strong>Remote Access</strong> panel in the in-game phone and
                        enter the code it shows, or scan its QR code.
                    </p>
                )}

                {state === "host-offline" && (
                    <p className={styles.status}>
                        The game is not connected. Open the <strong>Remote Access</strong> panel
                        in-game and leave it armed; this page reconnects automatically.
                    </p>
                )}

                {state === "rejected" && (
                    <p className={styles.status}>
                        That code or link is no longer valid. Get a fresh one from the in-game
                        panel.
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
                            Connect
                        </button>
                    </form>
                )}

                {state === "host-offline" && (
                    <button
                        className={styles.secondary}
                        type="button"
                        onClick={() => session.retry()}
                    >
                        Retry now
                    </button>
                )}

                {error && state !== "attaching" && (
                    <p className={styles.error}>{error}</p>
                )}

                <p className={styles.footer}>
                    This project is paid for by the supporters at{" "}
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
