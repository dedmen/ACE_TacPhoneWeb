import React from 'react';
import type { AppProps } from '@ace-tacphone/api';

import {
    SAMPLEAPP_SERVICE,
    SAMPLEAPP_SERVICE_VERSION,
    type SampleAppApi,
} from './api';

/** Message text used by both the phone notification and the game-side hint. */
function incrementText(count: number): string {
    return `Counter incremented to ${count}`;
}

export function SampleApp(props: AppProps): React.JSX.Element {
    // The host is one global object; props.panel is the live handle of the tab
    // this content is rendered in.
    const host = window.TacPhone;
    const { panel } = props;

    const [count, setCount] = React.useState(0);
    // Mirrors `count` for the inter-app service, whose closures outlive renders.
    const countRef = React.useRef(0);
    // Id of the last notification, so pressing the button again replaces it.
    const lastNotificationId = React.useRef<string | undefined>(undefined);

    // Expose the app service for the lifetime of this panel. The host keeps the
    // registration per panel, so StrictMode's double mount is safe: the cleanup
    // unregisters before the effect runs again.
    React.useEffect(() => {
        const api: SampleAppApi = {
            getCount: () => countRef.current,
        };

        return window.TacPhone.interApp.register(panel, {
            service: SAMPLEAPP_SERVICE,
            version: SAMPLEAPP_SERVICE_VERSION,
            api,
        });
    }, [panel]);

    const increment = () => {
        const nextCount = count + 1;
        const text = incrementText(nextCount);
        countRef.current = nextCount;
        setCount(nextCount);

        // Replace the previous notification instead of stacking banners.
        if (lastNotificationId.current !== undefined) {
            host.notifications.dismiss(lastNotificationId.current);
        }
        lastNotificationId.current = host.notifications.show({
            title: 'SampleApp',
            body: text,
            app: 'SampleApp',
        });

        // The game shows the same text as a hint and a systemChat message.
        void host.networking.Request({
            a: 'SampleApp',
            c: 'Increment',
            count: nextCount,
            text,
        }).catch((error: unknown) => {
            console.warn('SampleApp: game request failed:', error);
        });
    };

    return (
        <div style={styles.container}>
            <div style={styles.counter}>{count}</div>
            <button type="button" style={styles.button} onClick={increment}>
                Increment
            </button>
        </div>
    );
}

const styles = {
    container: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        height: '100%',
        padding: '1rem',
        boxSizing: 'border-box',
    },
    counter: {
        fontSize: '3rem',
        fontWeight: 700,
    },
    button: {
        padding: '0.75rem 1.5rem',
        fontSize: '1rem',
        cursor: 'pointer',
    },
} satisfies Record<string, React.CSSProperties>;
