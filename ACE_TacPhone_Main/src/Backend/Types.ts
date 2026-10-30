// App-facing contract of the TacPhone host.
//
// The contract itself lives in `@ace-tacphone/api`; this module only re-exports
// it under the paths the host implementation already uses, so there is exactly
// one definition of the app contract. Never add types here.

export type {
    InterAppRegistration,
    InterAppRegistry,
    AppCatalog,
    AppComponent,
    AppInfo,
    AppModule,
    AppPanelInfo,
    AppProps,
    AppServiceInfo,
    CommandHandler,
    CommandRegistry,
    CommandRegistryConstructor,
    InterestRegistryApi,
    Networking,
    NotificationAction,
    NotificationCenterApi,
    NotificationOptions,
    NotificationTapHandler,
    OpenPanelOptions,
    OpenPanelResult,
    PanelDirectoryApi,
    PanelInfo,
    PanelInstance,
    PanelMeta,
    PanelPlacement,
    PanelRect,
    TacPhoneHost,
    TacPhoneNotification,
    TacPhoneUtils,
    TargetChooser,
    TargetOptions,
    TargetPolicy,
} from "@ace-tacphone/api";

export { TACPHONE_API_VERSION } from "@ace-tacphone/api";
