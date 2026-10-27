

interface AppPanelInfo {
    // Globally (across all panels) unique name of this one
    id: string;
    GetTacPhoneIcon(): string;
    GetDefaultTitle(): string;
    appComponent: React.ComponentClass;
}

interface AppModule {
    GetTacPhoneApps(): Array<AppPanelInfo>;
    OnMessageFromGame?(message: object): void | Promise<void>;
}