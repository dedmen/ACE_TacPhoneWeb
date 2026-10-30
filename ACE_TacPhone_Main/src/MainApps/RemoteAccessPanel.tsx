import React from "react";
import type { AppProps } from "@ace-tacphone/api";
import { IsArma } from "../Backend/Networking";

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
    { label: "15 min", seconds: 900 },
    { label: "1 hour", seconds: 3600 },
    { label: "4 hours", seconds: 14400 },
    { label: "8 hours", seconds: 28800 },
    { label: "24 hours", seconds: 86400 },
];

async function remoteCall(command: string, extra: object = {}): Promise<RemoteStatus> {
    return await window.TacPhone.networking.Request({
        a: "main",
        c: `RemoteAccess.${command}`,
        ...extra,
    }) as RemoteStatus;
}

function formatTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function remaining(seconds: number): string {
    if (seconds <= 0) return "expired";
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
        const lib = (window as unknown as { QRCode?: any }).QRCode;
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
                <h2 style={styles.title}>Remote Access</h2>
                <p style={styles.hint}>Open this panel in the in-game phone to pair a device.</p>
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

        // Opening the panel is what arms remote access for this session.
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
                setError(result.error ?? "request failed");
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

    const copy = async (text: string): Promise<void> => {
        await run("CopyToClipboard", { text });
    };

    const state = status?.state ?? "idle";
    const stateLabel = state === "online" ? "Connected" : state === "connecting" ? "Connecting…" : state === "error" ? "Error" : "Idle";
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
                <h2 style={styles.title}>Remote Access</h2>
                <span style={{ ...styles.badge, backgroundColor: stateColor }}>{stateLabel}</span>
            </div>

            {status?.hostId ? (
                <p style={styles.hint}>Host ID: <code>{status.hostId}</code></p>
            ) : null}

            {error || status?.error ? (
                <p style={styles.error}>{error || status?.error}</p>
            ) : null}

            {state === "connecting" ? (
                <p style={styles.hint}>Connecting to the relay…</p>
            ) : null}

            {state !== "online" && state !== "connecting" ? (
                <div style={{ marginBottom: 12 }}>
                    <button
                        type="button"
                        style={styles.primary}
                        disabled={busy}
                        onClick={() => void run("Start")}
                    >
                        Start remote access
                    </button>
                </div>
            ) : null}

            <div style={styles.section}>
                <h3 style={styles.title}>This device</h3>
                <p style={styles.hint}>
                    One-time code for your own phone. It expires in about two minutes and can be used once.
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
                            {codeExpiresIn > 0 ? `${codeExpiresIn}s left` : "expired"}
                        </p>
                    </>
                ) : null}

                <div style={styles.row}>
                    <button
                        type="button"
                        style={styles.primary}
                        disabled={busy || state !== "online"}
                        onClick={() => void run("NewCode")}
                    >
                        New code
                    </button>
                    {code ? (
                        <button type="button" style={styles.button} onClick={() => void copy(code)}>
                            Copy code
                        </button>
                    ) : null}
                </div>

                {codeUrl ? <div style={{ marginTop: 10 }}><QrCode text={codeUrl} /></div> : null}
            </div>

            <div style={styles.section}>
                <h3 style={styles.title}>Share link</h3>
                <p style={styles.hint}>
                    Reusable link for other people. Creating a new link invalidates the current one and
                    disconnects everyone using it.
                </p>

                <div style={styles.row}>
                    <select
                        style={styles.select}
                        value={ttl}
                        onChange={(event) => setTtl(Number(event.target.value))}
                        disabled={busy || state !== "online"}
                    >
                        {TTL_OPTIONS.map(option => (
                            <option key={option.seconds} value={option.seconds}>{option.label}</option>
                        ))}
                    </select>
                    <button
                        type="button"
                        style={styles.primary}
                        disabled={busy || state !== "online"}
                        onClick={() => void run("ShareCreate", { ttlSeconds: ttl })}
                    >
                        {share ? "Replace link" : "Create link"}
                    </button>
                    {share ? (
                        <button
                            type="button"
                            style={styles.button}
                            disabled={busy}
                            onClick={() => void run("ShareRevoke")}
                        >
                            Revoke
                        </button>
                    ) : null}
                </div>

                {share ? (
                    <>
                        <input style={styles.link} readOnly value={share.url} onFocus={(event) => event.target.select()} />
                        <div style={styles.row}>
                            <button type="button" style={styles.button} onClick={() => void copy(share.url)}>
                                Copy link
                            </button>
                            <span style={styles.hint}>Expires in {remaining(share.expiresIn)}</span>
                        </div>
                        <div style={{ marginTop: 10 }}><QrCode text={share.url} /></div>
                        <p style={styles.warning}>
                            Anyone with this link can control this phone until it expires or you stop remote access.
                        </p>
                    </>
                ) : null}
            </div>

            <div style={styles.section}>
                <h3 style={styles.title}>Connected devices</h3>

                {(status?.peers ?? []).length === 0 ? (
                    <p style={styles.hint}>No devices connected.</p>
                ) : (
                    (status?.peers ?? []).map(peer => (
                        <div key={peer.id} style={styles.peer}>
                            <div>
                                <div>{peer.label || "Unknown device"} {peer.via === "share" ? "(share)" : ""}</div>
                                <div style={{ color: "#8b949e", fontSize: 11 }}>
                                    first connected {formatTime(peer.firstSeenAt || peer.connectedAt)}
                                </div>
                            </div>
                            <button
                                type="button"
                                style={styles.button}
                                disabled={busy}
                                onClick={() => void run("Kick", { peerId: peer.id })}
                            >
                                Disconnect
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
                    Stop remote access
                </button>
            </div>
        </div>
    );
}

export default RemoteAccessPanel;
