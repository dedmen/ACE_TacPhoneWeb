import React from "react";
import styles from './AppErrorBoundary.module.css'

type AppErrorBoundaryProps = {
    appName: string;
    children?: React.ReactNode;
};

type AppErrorBoundaryState = {
    error: Error | undefined;
};

// Keeps a crash inside one app from taking down the whole phone UI.
export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { error: undefined };

    static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }

    componentDidCatch(error: unknown, info: React.ErrorInfo): void {
        console.error(`TacPhone app "${this.props.appName}" crashed while rendering:`, error, info);
    }

    render(): React.ReactNode {
        if (this.state.error) {
            return (
                <div className={styles.ErrorPanel} role="alert">
                    <div className={styles.ErrorTitle}>{this.props.appName} failed to start</div>
                    <div className={styles.ErrorMessage}>{this.state.error.message}</div>
                    <button
                        type="button"
                        className={styles.RetryButton}
                        onClick={() => this.setState({ error: undefined })}
                    >
                        Retry
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
