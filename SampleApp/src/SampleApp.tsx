import React from 'react';

/** Message text used by both the phone notification and the game-side hint. */
function incrementText(count: number): string {
    return `Counter incremented to ${count}`;
}

export function SampleApp(): React.JSX.Element {
    const [count, setCount] = React.useState(0);
    // Id of the last notification, so pressing the button again replaces it.
    const lastNotificationId = React.useRef<string | undefined>(undefined);

    const increment = () => {
        const nextCount = count + 1;
        const text = incrementText(nextCount);
        setCount(nextCount);

        // Replace the previous notification instead of stacking banners.
        if (lastNotificationId.current !== undefined) {
            window.Notifications.dismiss(lastNotificationId.current);
        }
        lastNotificationId.current = window.Notifications.show({
            title: 'SampleApp',
            body: text,
            app: 'SampleApp',
        });

        // The game shows the same text as a hint and a systemChat message.
        void window.Networking.Request({
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
