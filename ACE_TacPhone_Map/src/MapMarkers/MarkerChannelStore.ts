/**
 * Small external store that mirrors the marker module's channel state for the
 * LayerSwitcher. The marker overlay owns the module and updates this store;
 * LayerSwitcher subscribes and calls setActiveChannel directly.
 *
 * When no marker module is attached the store reports `enabled: false`, so the
 * layer switcher shows no chat-channel or active-channel UI.
 */

import type { MarkerModule } from './MarkerModule';

export interface MarkerChannelsSnapshot {
    enabled: boolean;
    multiplayer: boolean;
    activeChannel: number;
    activeChannelLabel: string;
}

const DISABLED_SNAPSHOT: MarkerChannelsSnapshot = {
    enabled: false,
    multiplayer: false,
    activeChannel: 3,
    activeChannelLabel: '',
};

export class MarkerChannelStore {
    private module: MarkerModule | null = null;
    private snapshot: MarkerChannelsSnapshot = DISABLED_SNAPSHOT;
    private listeners = new Set<() => void>();

    public getSnapshot = (): MarkerChannelsSnapshot => this.snapshot;

    public subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    public attach(module: MarkerModule): void {
        this.module = module;
        this.update();
    }

    public detach(module: MarkerModule): void {
        if (this.module !== module) {
            return;
        }

        this.module = null;
        this.update();
    }

    public setActiveChannel(channel: number): void {
        this.module?.setActiveChannel(channel);
        this.update();
    }

    public update(): void {
        const module = this.module;
        const next: MarkerChannelsSnapshot = module
            ? {
                enabled: true,
                multiplayer: module.isMultiplayer(),
                activeChannel: module.getActiveChannel(),
                activeChannelLabel: module.getChannelLabel(module.getActiveChannel()),
            }
            : DISABLED_SNAPSHOT;

        if (
            next.enabled === this.snapshot.enabled
            && next.multiplayer === this.snapshot.multiplayer
            && next.activeChannel === this.snapshot.activeChannel
            && next.activeChannelLabel === this.snapshot.activeChannelLabel
        ) {
            return;
        }

        this.snapshot = next;
        for (const listener of this.listeners) {
            listener();
        }
    }
}
