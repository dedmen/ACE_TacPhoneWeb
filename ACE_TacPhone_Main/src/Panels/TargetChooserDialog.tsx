// Host UI for the "ask" target policy of the inter-app API.
//
// AppApi.resolveAsync() only calls the installed chooser when there are several
// candidate panels for a service (opening a missing app and waiting for its
// registration is resolveAsync's own job, not this dialog's). The chooser returns
// the id of the chosen candidate, or undefined when the user cancels; AppApi then
// reports "no panel was selected" to the calling app.
//
// The dialog is installed once by App.tsx and lives outside the layout, so a
// floating popup or a maximized tab can never cover it.
//
// Cancellation and overlapping requests:
// - Cancel, a backdrop click and Escape all resolve undefined.
// - A second request while one is on screen resolves the first one with undefined
//   and shows the newest, so a stalled caller never blocks the next route. The
//   newest request wins because it is the one the user just triggered.
// - Every request is resolved exactly once; the resolver is dropped before it
//   runs, so a stray click on the closing dialog cannot answer twice.

import React from "react";
import type { AppApiRegistry, TargetChooser } from "../Backend/AppApi";
import type { PanelInfo } from "../Backend/PanelDirectory";
import styles from "./TargetChooserDialog.module.css";

/** One routing request waiting for a user decision. */
interface ChooserRequest {
    /** Service the calling app wants to reach, e.g. "map". */
    service: string;
    /** Open panels that can provide the service; never empty. */
    candidates: PanelInfo[];
    /** Caller-supplied description of the request, used as the heading. */
    reason?: string;
}

interface TargetChooserDialogState {
    /** Request on screen; undefined means "render nothing". */
    request: ChooserRequest | undefined;
}

/** What choosing a row answers with: the mounted instance, else the tab. */
function candidateId(candidate: PanelInfo): string {
    return candidate.instanceId ?? candidate.tabId;
}

/**
 * Secondary line of a row: which app/panel it is, how to address it, and how
 * large it is. Instance ids are runtime-only, so an unmounted tab shows its id.
 */
function describeCandidate(candidate: PanelInfo): string {
    const owner = candidate.panelId ?? "unassigned tab";
    const app = candidate.appName && candidate.appName !== owner ? ` (${candidate.appName})` : "";
    const identity = candidate.instanceId ?? `tab ${candidate.tabId}`;
    const area = `${Math.round(candidate.area)} px²`;

    return `${owner}${app} · ${identity} · ${area}`;
}

/**
 * Modal panel picker for `policy: "ask"`.
 *
 * Renders nothing until AppApi hands it a request. Mount it once; it installs its
 * chooser with `window.AppApi.setTargetChooser()` in componentDidMount and clears
 * it again on unmount, resolving whatever is still pending with undefined.
 */
export class TargetChooserDialog extends React.Component<{}, TargetChooserDialogState> {
    /** True while this component is the installed chooser; avoids clearing someone else's. */
    private installed = false;
    /** Resolver of the request on screen; undefined when nothing is pending. */
    private resolvePending: ((chosen: string | undefined) => void) | undefined;

    constructor(props: {}) {
        super(props);
        this.state = { request: undefined };
    }

    componentDidMount(): void {
        // main.tsx always imports Backend/AppApi, but fail soft instead of taking
        // the host UI down when the registry is somehow missing.
        const api: AppApiRegistry | undefined = window.AppApi;
        if (!api) {
            console.warn("TacPhone TargetChooserDialog: window.AppApi is missing, so policy \"ask\" falls back to \"auto\".");
            return;
        }

        api.setTargetChooser(this.choose);
        this.installed = true;
    }

    componentDidUpdate(previous: TargetChooserDialogState): void {
        if ((previous.request !== undefined) === (this.state.request !== undefined))
            return;

        // Only listen while a dialog is on screen; Escape belongs to the apps otherwise.
        if (this.state.request)
            window.addEventListener("keydown", this.handleKeyDown);
        else
            window.removeEventListener("keydown", this.handleKeyDown);
    }

    componentWillUnmount(): void {
        if (this.installed) {
            window.AppApi?.setTargetChooser(undefined);
            this.installed = false;
        }

        window.removeEventListener("keydown", this.handleKeyDown);

        // Nobody can answer a dialog that is gone, so release the waiting caller.
        const resolve = this.resolvePending;
        this.resolvePending = undefined;
        resolve?.(undefined);
    }

    /** Installed chooser: shows the dialog and waits for a row or a cancel. */
    private choose: TargetChooser = request => {
        // Overlapping request: the newest one wins, the previous caller cancels.
        this.settle(undefined);

        return new Promise<string | undefined>(resolve => {
            // Set the resolver before the render, so an immediate cancel finds it.
            this.resolvePending = resolve;
            this.setState({
                request: {
                    service: request.service,
                    candidates: request.candidates,
                    reason: request.reason
                }
            });
        });
    };

    private handleKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || !this.state.request)
            return;

        event.preventDefault();
        this.settle(undefined);
    };

    /** Answers the request on screen with `chosen` and closes the dialog. */
    private settle(chosen: string | undefined): void {
        const resolve = this.resolvePending;
        if (!resolve)
            return;

        // Drop the resolver first: the answer must never be delivered twice.
        this.resolvePending = undefined;

        if (this.state.request !== undefined)
            this.setState({ request: undefined });

        resolve(chosen);
    }

    private handleBackdropClick = (): void => {
        this.settle(undefined);
    };

    /** Keeps clicks inside the dialog from reaching the backdrop's cancel handler. */
    private handleDialogClick = (event: React.MouseEvent): void => {
        event.stopPropagation();
    };

    render(): React.ReactNode {
        const request = this.state.request;
        if (!request)
            return null;

        // The reason describes the user's action, the service is the fallback.
        const heading = request.reason || request.service;
        const count = request.candidates.length === 1 ? "1 panel" : `${request.candidates.length} panels`;

        return (
            <div className={styles.Backdrop} onClick={this.handleBackdropClick}>
                <div className={styles.Dialog} onClick={this.handleDialogClick}>
                    <h2 className={styles.Heading}>{`Choose a panel for "${heading}"`}</h2>
                    <div className={styles.Subtitle}>{`${request.service} · ${count}`}</div>
                    <div className={styles.List}>
                        {request.candidates.map(candidate => (
                            <button
                                key={candidate.tabId}
                                type="button"
                                className={styles.Row}
                                title={describeCandidate(candidate)}
                                onClick={() => this.settle(candidateId(candidate))}
                            >
                                <span className={styles.RowTitle}>{candidate.title}</span>
                                {candidate.isFloating ? <span className={styles.Badge}>floating</span> : null}
                                <span className={styles.RowMeta}>{describeCandidate(candidate)}</span>
                            </button>
                        ))}
                    </div>
                    <button type="button" className={styles.Cancel} onClick={() => this.settle(undefined)}>Cancel</button>
                </div>
            </div>
        );
    }
}
