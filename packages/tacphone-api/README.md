# @ace-tacphone/api

The app-facing contract of the TacPhone host. This package is the single source
of truth for what an app may import: it contains only type declarations and a few
runtime constants, and never imports host implementation code.

```ts
import type { AppPanelInfo, AppProps, TacPhoneHost } from '@ace-tacphone/api';
import { TACPHONE_API_VERSION } from '@ace-tacphone/api';
```

At runtime the same contract is the single host object `window.TacPhone`
(see `src/globals.ts`); apps never import a host module. The package ships
TypeScript sources directly (`main`/`types` point at `src/index.ts`), so it is
consumed through the workspace's TypeScript build, not prebuilt `.d.ts` files.

## What it exports

| Export | Purpose |
| --- | --- |
| `TACPHONE_API_VERSION` | Contract version (`2`). Every app module must export the same `apiVersion`. |
| `AppProps` | Props of every panel component: `appId`, `panelId`, `node`, `model`, `panel`. The host is the global `window.TacPhone`. |
| `AppModule`, `AppPanelInfo`, `AppComponent` | App entry module and panel registration. |
| `TacPhoneHost` | The `window.TacPhone` object: `apiVersion`, `reactVersion`, `networking`, `apps`, `panels`, `interApp`, `interests`, `notifications`, `utils`. |
| `Networking` | `WhenReady`, `Request`, `OnConnectionChange`, `LoadGameFileText`, `LoadGameFileTexture`, `LoadGameTerrain`, `ReplyTerrainSVG`, `OnMessageFromGame`. |
| `TerrainData`, `TerrainLayer` | Return type of `LoadGameTerrain()`: terrain `width`/`height` and standalone per-layer SVG documents. |
| `AppCatalog`, `AppInfo`, `PanelMeta` | Read-only app and panel catalog (`window.TacPhone.apps`). |
| `PanelDirectoryApi`, `PanelInfo`, `PanelInstance`, `OpenPanelOptions`, `OpenPanelResult`, `PanelRect`, `PanelPlacement` | Panel enumeration and control. |
| `InterAppRegistry`, `AppServiceInfo`, `InterAppRegistration`, `TargetOptions`, `TargetPolicy`, `TargetChooser` | Inter-app services and routing. |
| `InterestRegistryApi` | Reference-counted data interests. |
| `NotificationCenterApi`, `NotificationOptions`, `TacPhoneNotification`, `NotificationTapHandler`, `NotificationAction` | Toast banners. |
| `TacPhoneUtils`, `CommandRegistry`, `CommandRegistryConstructor`, `CommandHandler` | `CommandRegistry`, `PanelContext`, `usePanel()`, and the gzip/base64 helpers `compressAndToBase64` and `decompressFromBase64`. |

## App module contract

```ts
import type { AppModule, AppPanelInfo } from '@ace-tacphone/api';

export const apiVersion = 2; // required, must equal TACPHONE_API_VERSION

export function GetTacPhoneApps(): AppPanelInfo[] { /* ... */ }
export function OnMessageFromGame(message: object): void { /* optional */ }
```

`init()` is optional and runs once before `GetTacPhoneApps()`. `GetTacPhoneApps`
may return a promise. Apps read the host directly from `window.TacPhone`; it is
not passed as an argument or prop. A wrong `apiVersion` makes the app a failed
entry in `window.TacPhone.apps.failedApps` with a clear message.

## Notes

- `LoadGameTerrain()` resolves to a `TerrainData` (`width`, `height`, `layers`)
  instead of a raw SVG string. The in-game transport splits the SVG into
  standalone per-layer documents and streams compressed chunks; the browser
  transport reassembles them (and still accepts the legacy whole-SVG reply).
- `ReplyTerrainSVG(uid, config)` is the host-internal producer path used by the
  built-in main app; only the in-game transport implements it.
- Apps should also expose their inter-app service types from `src/api.ts`; that is
  bundled into `dist/*.d.ts` by `@ace-tacphone/build`, not by this package.
- There is no `TacPhoneMain.d.ts` any more. `ACE_TacPhone_Main/src/TacPhoneMain.ts`
  only re-exports this contract for host code; apps must not import it.

