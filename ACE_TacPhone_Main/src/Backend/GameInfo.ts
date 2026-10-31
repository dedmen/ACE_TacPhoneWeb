// Mission-static game information requested once per phone page load.
//
// Apps read it through window.TacPhone.gameInfo and should use whenReady()
// before relying on the values. The snapshot is cached for the lifetime of the
// page; it intentionally has no change subscription.

import type { GameInfo, GameInfoApi } from '@ace-tacphone/api';
import { networking } from './Networking';

const GAME_INFO_TIMEOUT_MS = 10_000;

const FALLBACK_GAME_INFO: GameInfo = Object.freeze({
    multiplayer: false,
    playerId: '',
    missionName: '',
    terrainName: '',
    gameVersion: '',
    debug: false,
});

function withTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
            if (settled) {
                return;
            }

            settled = true;
            reject(new Error(`${description} timed out after ${GAME_INFO_TIMEOUT_MS} ms`));
        }, GAME_INFO_TIMEOUT_MS);

        promise.then(
            (value) => {
                if (settled) {
                    return;
                }

                settled = true;
                window.clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                if (settled) {
                    return;
                }

                settled = true;
                window.clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function parseGameInfo(raw: object): GameInfo {
    const value = raw as Partial<Record<keyof GameInfo, unknown>>;

    return Object.freeze({
        multiplayer: value.multiplayer === true,
        playerId: String(value.playerId ?? ''),
        missionName: String(value.missionName ?? ''),
        terrainName: String(value.terrainName ?? ''),
        gameVersion: String(value.gameVersion ?? ''),
        debug: value.debug === true,
    });
}

class GameInfoStore implements GameInfoApi {
    private info: GameInfo | undefined;
    private loading: Promise<GameInfo> | undefined;

    public get(): GameInfo | undefined {
        return this.info;
    }

    public isDebug(): boolean {
        return this.info?.debug === true;
    }

    public whenReady(): Promise<GameInfo> {
        if (this.info) {
            return Promise.resolve(this.info);
        }

        if (!this.loading) {
            this.loading = this.load();
        }

        return this.loading;
    }

    private async load(): Promise<GameInfo> {
        let info: GameInfo;

        try {
            const raw = await withTimeout(
                networking.Request({ a: 'main', c: 'GetGameInfo' }),
                'GetGameInfo',
            );
            info = parseGameInfo(raw);
        } catch (error) {
            console.warn('TacPhone could not load global game info; assuming singleplayer.', error);
            info = FALLBACK_GAME_INFO;
        }

        this.info = info;
        return info;
    }
}

export const gameInfo = new GameInfoStore();
export { GameInfoStore };
