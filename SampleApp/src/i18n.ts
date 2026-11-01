/** Localized text helper for the SampleApp. */
export const t = (key: string, ...args: Array<string | number>): string =>
    window.TacPhone.localization.t(key, ...args);
