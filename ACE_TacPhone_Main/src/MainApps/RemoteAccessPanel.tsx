import React from "react";
import type { AppProps } from "@ace-tacphone/api";
import { IsArma } from "../Backend/Networking";
import { appDirectory } from "../Backend/AppDirectory";
import { sharedModules } from "../Backend/SharedModules";
import { t } from "../Backend/i18n";

type RemotePeer = {
    id: string;
    label: string;
    via: string;
    connectedAt: string;
    firstSeenAt: string;
};

type RemoteShare = {
    url: string;
    key: string;
    expiresIn: number;
};

type RemoteStatus = {
    ok: boolean;
    state?: "idle" | "connecting" | "online" | "error";
    hostId?: string;
    webBase?: string;
    error?: string;
    code?: string;
    codeExpiresIn?: number;
    codeTtl?: number;
    share?: RemoteShare | null;
    peers?: RemotePeer[];
};

const TTL_OPTIONS = [
    { key: 'str_3den_attributes_preferencessavegame_min15_text', seconds: 900 },
    { key: 'str_3den_attributes_preferencessavegame_min60_text', seconds: 3600 },
    { key: 'STR_ACE_Tacphone_RemoteAccess_Ttl_4hours', seconds: 14400 },
    { key: 'STR_ACE_Tacphone_RemoteAccess_Ttl_8hours', seconds: 28800 },
    { key: 'STR_ACE_Tacphone_RemoteAccess_Ttl_24hours', seconds: 86400 },
];

async function remoteCall(command: string, extra: object = {}): Promise<RemoteStatus> {
    // Start initializes the relay connection, so the file manifest is pulled at
    // that moment and travels with the request. No extra game round-trip.
    const payload = command === "Start"
        ? { ...extra, files: appDirectory.getFileManifest() }
        : extra;

    return await window.TacPhone.networking.Request({
        a: "main",
        c: `RemoteAccess.${command}`,
        ...payload,
    }) as RemoteStatus;
}

function formatTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function remaining(seconds: number): string {
    if (seconds <= 0) return t('STR_ACE_Tacphone_Common_Expired');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 1) return `${seconds}s`;
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

const styles = {
    panel: {
        height: "100%",
        overflow: "auto",
        padding: 12,
        boxSizing: "border-box",
        backgroundColor: "#161b22",
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
    } as React.CSSProperties,
    section: {
        marginBottom: 16,
        padding: 12,
        border: "1px solid #2d333b",
        borderRadius: 8,
        backgroundColor: "#0d1117",
    } as React.CSSProperties,
    header: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        marginBottom: 10,
    } as React.CSSProperties,
    title: { margin: 0, fontSize: 15 } as React.CSSProperties,
    badge: { padding: "2px 8px", borderRadius: 999, fontSize: 11 } as React.CSSProperties,
    code: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 26,
        letterSpacing: 2,
        padding: "10px 0",
    } as React.CSSProperties,
    link: {
        width: "100%",
        padding: "8px 10px",
        marginBottom: 8,
        border: "1px solid #30363d",
        borderRadius: 6,
        backgroundColor: "#010409",
        color: "#c9d1d9",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
        boxSizing: "border-box",
    } as React.CSSProperties,
    row: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } as React.CSSProperties,
    button: {
        padding: "7px 12px",
        border: "1px solid #30363d",
        borderRadius: 6,
        backgroundColor: "#21262d",
        color: "#e6edf3",
        cursor: "pointer",
        fontSize: 12,
    } as React.CSSProperties,
    primary: {
        padding: "7px 12px",
        border: "1px solid #1f6feb",
        borderRadius: 6,
        backgroundColor: "#1f6feb",
        color: "#ffffff",
        cursor: "pointer",
        fontSize: 12,
    } as React.CSSProperties,
    select: {
        padding: "7px 8px",
        border: "1px solid #30363d",
        borderRadius: 6,
        backgroundColor: "#0d1117",
        color: "#e6edf3",
        fontSize: 12,
    } as React.CSSProperties,
    copied: { borderColor: "#2ea043", color: "#3fb950" } as React.CSSProperties,
    hint: { margin: "8px 0 0", color: "#8b949e", lineHeight: 1.45 } as React.CSSProperties,
    warning: { margin: "8px 0 0", color: "#d29922", lineHeight: 1.45 } as React.CSSProperties,
    error: { margin: "8px 0 0", color: "#f85149", lineHeight: 1.45 } as React.CSSProperties,
    peer: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
        padding: "6px 0",
        borderBottom: "1px solid #21262d",
    } as React.CSSProperties,
    qr: {
        backgroundColor: "#fff",
        padding: 8,
        borderRadius: 6,
        width: 240,
        maxWidth: "100%",
        aspectRatio: "1 / 1",
        boxSizing: "border-box",
        marginTop: 10,
    } as React.CSSProperties,
    progressTrack: {
        height: 8,
        marginTop: 8,
        backgroundColor: "#21262d",
        borderRadius: 4,
        overflow: "hidden",
    } as React.CSSProperties,
    progressFill: {
        height: "100%",
        borderRadius: 4,
        transition: "width 1s linear, background-color 0.3s",
    } as React.CSSProperties,
    countdown: { margin: "4px 0 0", color: "#8b949e", fontSize: 11 } as React.CSSProperties,
};

function QrCode({ text }: { text: string }): React.ReactElement | null {
    const svg = React.useMemo(() => {
        const lib = sharedModules.get("qrcode-generator") as
            | ((typeNumber: number, errorCorrectionLevel: string) => any)
            | undefined;
        if (!lib || !text) return "";

        try {
            const qr = lib(0, "M");
            qr.addData(text);
            qr.make();
            return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        } catch (error) {
            console.error("Could not render the pairing QR code:", error);
            return "";
        }
    }, [text]);

    if (!svg) return null;

    return (
        <div
            style={styles.qr}
            dangerouslySetInnerHTML={{
                __html: svg.replace("<svg ", '<svg style="display:block;width:100%;height:100%" '),
            }}
        />
    );
}

export function RemoteAccessPanel(props: AppProps): React.ReactElement {
    if (!IsArma()) {
        return (
            <div style={styles.panel}>
                <h2 style={styles.title}>{t('STR_ACE_Tacphone_RemoteAccess_PanelTitle')}</h2>
                <p style={styles.hint}>{t('STR_ACE_Tacphone_RemoteAccess_OpenInGameHint')}</p>
            </div>
        );
    }

    return <RemoteAccessPanelInner {...props} />;
}

function RemoteAccessPanelInner(_props: AppProps): React.ReactElement {
    const [status, setStatus] = React.useState<RemoteStatus | null>(null);
    const [ttl, setTtl] = React.useState(3600);
    const [error, setError] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [copied, setCopied] = React.useState<string | null>(null);
    const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => () => {
        if (copyTimer.current) clearTimeout(copyTimer.current);
    }, []);

    const refresh = React.useCallback(async () => {
        try {
            const next = await remoteCall("Status");
            setStatus(next);
            if (next.ok !== false) setError("");
        } catch (requestError) {
            setError(String(requestError));
        }
    }, []);

    React.useEffect(() => {
        let mounted = true;

        // Opening the panel starts the relay connection for this session.
        void (async () => {
            try {
                const started = await remoteCall("Start");
                if (mounted) setStatus(started);
            } catch (startError) {
                if (mounted) setError(String(startError));
            }
        })();

        const timer = setInterval(() => {
            if (mounted) void refresh();
        }, 1000);

        return () => {
            mounted = false;
            clearInterval(timer);
        };
    }, [refresh]);

    const run = async (command: string, extra: object = {}): Promise<void> => {
        setBusy(true);
        setError("");

        try {
            const result = await remoteCall(command, extra);
            if (result.ok === false) {
                setError(result.error ?? t('STR_ACE_Tacphone_RemoteAccess_RequestFailed'));
            } else if (result.state) {
                setStatus(result);
            }

            await refresh();
        } catch (requestError) {
            setError(String(requestError));
        } finally {
            setBusy(false);
        }
    };

    const copy = async (text: string, key: string): Promise<void> => {
        // Show success immediately; the clipboard call itself is fire-and-forget
        // from the user's point of view (errors still surface in the panel).
        setCopied(key);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(null), 2000);
        await run("CopyToClipboard", { text });
    };

    const state = status?.state ?? "idle";
    const stateLabel = state === "online"
        ? t('STR_ACE_Tacphone_RemoteAccess_State_Connected')
        : state === "connecting"
            ? t('str_3den_tutorials_editing_sections_connecting_text')
            : state === "error"
                ? t('str_mis_state_error')
                : t('STR_ACE_Tacphone_RemoteAccess_State_Idle');
    const stateColor = state === "online" ? "#238636" : state === "connecting" ? "#9e6a03" : state === "error" ? "#b62324" : "#30363d";

    const code = status?.code ?? "";
    const codeUrl = code && status?.webBase ? `${status.webBase}/#p=${code}` : "";
    const share = status?.share ?? null;
    const codeTtl = status?.codeTtl || (code ? 120 : 0);
    const codeExpiresIn = status?.codeExpiresIn ?? 0;
    const codePercent = codeTtl > 0
        ? Math.max(0, Math.min(100, (codeExpiresIn / codeTtl) * 100))
        : 0;
    const codeDanger = codeTtl > 0 && codeExpiresIn <= Math.max(10, codeTtl * 0.2);

    return (
        <div style={styles.panel}>
            <div style={styles.header}>
                <h2 style={styles.title}>{t('STR_ACE_Tacphone_RemoteAccess_PanelTitle')}</h2>
                <span style={{ ...styles.badge, backgroundColor: stateColor }}>{stateLabel}</span>
            </div>

            {status?.hostId ? (
                <p style={styles.hint}>{t('STR_ACE_Tacphone_RemoteAccess_HostId')} <code>{status.hostId}</code></p>
            ) : null}

            {error || status?.error ? (
                <p style={styles.error}>{error || status?.error}</p>
            ) : null}

            {state === "connecting" ? (
                <p style={styles.hint}>{t('STR_ACE_Tacphone_RemoteAccess_ConnectingRelay')}</p>
            ) : null}

            {state !== "online" && state !== "connecting" ? (
                <div style={{ marginBottom: 12 }}>
                    <button
                        type="button"
                        style={styles.primary}
                        disabled={busy}
                        onClick={() => void run("Start")}
                    >
                        {t('STR_ACE_Tacphone_RemoteAccess_Start')}
                    </button>
                </div>
            ) : null}

            <div style={styles.section}>
                <h3 style={styles.title}>{t('STR_ACE_Tacphone_RemoteAccess_ThisDevice')}</h3>
                <p style={styles.hint}>
                    {t('STR_ACE_Tacphone_RemoteAccess_CodeHint')}
                </p>

                <div style={styles.code}>{code || "------"}</div>

                {code ? (
                    <>
                        <div style={styles.progressTrack}>
                            <div
                                style={{
                                    ...styles.progressFill,
                                    width: `${codePercent}%`,
                                    backgroundColor: codeDanger ? "#f85149" : "#2ea043",
                                }}
                            />
                        </div>
                        <p style={styles.countdown}>
                            {codeExpiresIn > 0
                                ? t('STR_ACE_Tacphone_RemoteAccess_SecondsLeft', codeExpiresIn)
                                : t('STR_ACE_Tacphone_Common_Expired')}
                        </p>
                    </>
                ) : null}

                <div style={styles.row}>
                    {!code ? (
                        <button
                            type="button"
                            style={styles.primary}
                            disabled={busy || state !== "online"}
                            onClick={() => void run("NewCode")}
                        >
                            {t('STR_ACE_Tacphone_RemoteAccess_NewCode')}
                        </button>
                    ) : (
                        <button
                            type="button"
                            style={{ ...styles.button, ...(copied === "code" ? styles.copied : null) }}
                            disabled={busy}
                            onClick={() => void copy(code, "code")}
                        >
                            {copied === "code" ? t('STR_ACE_Tacphone_Common_Copied') : t('STR_ACE_Tacphone_RemoteAccess_CopyCode')}
                        </button>
                    )}
                </div>

                {codeUrl ? <div style={{ marginTop: 10 }}><QrCode text={codeUrl} /></div> : null}
            </div>

            <div style={styles.section}>
                <h3 style={styles.title}>{t('STR_ACE_Tacphone_RemoteAccess_ShareLink')}</h3>
                <p style={styles.hint}>
                    {t('STR_ACE_Tacphone_RemoteAccess_ShareHint')}
                </p>

                <div style={styles.row}>
                    <select
                        style={styles.select}
                        value={ttl}
                        onChange={(event) => setTtl(Number(event.target.value))}
                        disabled={busy || state !== "online"}
                    >
                        {TTL_OPTIONS.map(option => (
                            <option key={option.seconds} value={option.seconds}>{t(option.key)}</option>
                        ))}
                    </select>
                    <button
                        type="button"
                        style={styles.primary}
                        disabled={busy || state !== "online"}
                        onClick={() => void run("ShareCreate", { ttlSeconds: ttl })}
                    >
                        {share ? t('STR_ACE_Tacphone_RemoteAccess_ReplaceLink') : t('STR_ACE_Tacphone_RemoteAccess_CreateLink')}
                    </button>
                    {share ? (
                        <button
                            type="button"
                            style={styles.button}
                            disabled={busy}
                            onClick={() => void run("ShareRevoke")}
                        >
                            {t('STR_ACE_Tacphone_RemoteAccess_Revoke')}
                        </button>
                    ) : null}
                </div>

                {share ? (
                    <>
                        <input style={styles.link} readOnly value={share.url} onFocus={(event) => event.target.select()} />
                        <div style={styles.row}>
                            <button
                                type="button"
                                style={{ ...styles.button, ...(copied === "share" ? styles.copied : null) }}
                                disabled={busy}
                                onClick={() => void copy(share.url, "share")}
                            >
                                {copied === "share" ? t('STR_ACE_Tacphone_Common_Copied') : t('STR_ACE_Tacphone_RemoteAccess_CopyLink')}
                            </button>
                            <span style={styles.hint}>{t('STR_ACE_Tacphone_RemoteAccess_ExpiresIn', remaining(share.expiresIn))}</span>
                        </div>
                        <div style={{ marginTop: 10 }}><QrCode text={share.url} /></div>
                        <p style={styles.warning}>
                            {t('STR_ACE_Tacphone_RemoteAccess_ShareWarning')}
                        </p>
                    </>
                ) : null}
            </div>

            <div style={styles.section}>
                <h3 style={styles.title}>{t('STR_ACE_Tacphone_RemoteAccess_ConnectedDevices')}</h3>

                {(status?.peers ?? []).length === 0 ? (
                    <p style={styles.hint}>{t('STR_ACE_Tacphone_RemoteAccess_NoDevices')}</p>
                ) : (
                    (status?.peers ?? []).map(peer => (
                        <div key={peer.id} style={styles.peer}>
                            <div>
                                <div>{peer.label || t('STR_ACE_Tacphone_RemoteAccess_UnknownDevice')} {peer.via === "share" ? t('STR_ACE_Tacphone_RemoteAccess_ViaShare') : ""}</div>
                                <div style={{ color: "#8b949e", fontSize: 11 }}>
                                    {t('STR_ACE_Tacphone_RemoteAccess_FirstConnected', formatTime(peer.firstSeenAt || peer.connectedAt))}
                                </div>
                            </div>
                            <button
                                type="button"
                                style={styles.button}
                                disabled={busy}
                                onClick={() => void run("Kick", { peerId: peer.id })}
                            >
                                {t('STR_3DEN_Display3DEN_ControlsHint_Disconnect')}
                            </button>
                        </div>
                    ))
                )}
            </div>

            <div style={styles.row}>
                <button
                    type="button"
                    style={styles.button}
                    disabled={busy}
                    onClick={() => void run("Stop")}
                >
                    {t('STR_ACE_Tacphone_RemoteAccess_Stop')}
                </button>
            </div>
        </div>
    );
}

export default RemoteAccessPanel;
