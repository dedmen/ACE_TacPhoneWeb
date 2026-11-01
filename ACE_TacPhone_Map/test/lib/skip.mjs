/**
 * Scenario skip signal.
 *
 * A scenario throws `SkipError` when a prerequisite is missing (no Playwright,
 * no installed Chrome channel, no Map app in the running game). The runner
 * reports it as SKIP instead of FAIL, so the suite stays usable on machines
 * that cannot run the browser half.
 */

export class SkipError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SkipError';
    }
}

export function skip(message) {
    throw new SkipError(message);
}
