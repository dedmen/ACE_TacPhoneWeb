// Host-internal helpers. Deliberately not exported from the app contract:
// apps see `window.TacPhone`, not these modules.

/** Rejects with a readable error when `promise` takes longer than `timeoutMs`. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false

        const timer = setTimeout(() => {
            if (settled)
                return

            settled = true
            reject(new Error(`${description} timed out after ${timeoutMs} ms`))
        }, timeoutMs)

        promise.then(
            value => {
                if (settled)
                    return

                settled = true
                clearTimeout(timer)
                resolve(value)
            },
            error => {
                if (settled)
                    return

                settled = true
                clearTimeout(timer)
                reject(error)
            },
        )
    })
}

/**
 * Canonical form of a game file path: backslashes, no leading slash, lower case.
 * Game paths compare case-insensitively.
 */
export function normalizeGamePath(path: string): string {
    return path.trim().replaceAll('/', '\\').replace(/^\\+/, '').toLowerCase()
}
