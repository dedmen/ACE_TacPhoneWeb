/**
 * Public service API of the SampleApp.
 *
 * This module is the app's inter-app contract: it is the entry point for
 * `tacphone-build bundle-api-types`, which emits `dist/ace_tacphone_sampleapp.d.ts`
 * (declared as the package `types`). Keep it free of imports so the generated
 * declaration stays self-contained.
 *
 * Other apps reach the implementation through the host registry:
 *
 * ```ts
 * const sample = await window.TacPhone.interApp.resolveAsync({
 *     service: SAMPLEAPP_SERVICE,
 *     panelId: 'SampleApp',
 *     openIfMissing: true,
 * });
 * const api = sample?.api as SampleAppApi | undefined;
 * console.log(api?.getCount());
 * ```
 */

/** What other apps receive from the SampleApp panel. */
export interface SampleAppApi {
    /** Current value of the panel counter. */
    getCount(): number;
}

/** Service name registered by the SampleApp panel. */
export const SAMPLEAPP_SERVICE = 'sampleapp';

/** Major version of {@link SampleAppApi}. */
export const SAMPLEAPP_SERVICE_VERSION = 1;
