import React from "react";
import { TACPHONE_API_VERSION } from "@ace-tacphone/api";
import type { AppPanelInfo, AppProps, PanelInfo, TacPhoneHost } from "@ace-tacphone/api";
import { compressAndToBase64 } from "../Backend/Compression";

// These are apps included in TacPhone, even if no other apps are loaded. Core functionality like Notifications and Settings

/** Contract version this app was built against; checked by the host. */
export const apiVersion = TACPHONE_API_VERSION;

export function GetTacPhoneApps(): Array<AppPanelInfo> {
  return [
    ...devApps(),
  ]
};

// Dev host only: a read-only view of the open panels plus buttons to exercise
// the panel directory (activate, open a docked tab, open a floating popup).
// The import.meta.env.DEV check below makes the release build drop this panel.

type PanelInspectorState = {
  panels: PanelInfo[];
  panelId: string;
};

const inspectorBoxStyle: React.CSSProperties = {
  padding: 10,
  height: "100%",
  boxSizing: "border-box",
  overflow: "auto",
  backgroundColor: "#222",
  color: "#eee",
  fontFamily: "monospace",
  fontSize: 12,
};

const inspectorRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 6,
  marginBottom: 8,
};

class PanelInspectorPanelContent extends React.Component<AppProps, PanelInspectorState> {
  state: PanelInspectorState = {
    panels: window.TacPhone.panels.list(),
    panelId: "",
  };

  private get host(): TacPhoneHost {
    return window.TacPhone;
  }

  private refresh = (): void => {
    this.setState({ panels: this.host.panels.list() });
  };

  private activate = (panel: PanelInfo): void => {
    // A background tab has no instance yet; activate() also accepts its tab id.
    if (!this.host.panels.activate(panel.instanceId ?? panel.tabId))
      console.warn(`TacPhone panel inspector could not activate tab "${panel.tabId}".`);

    this.refresh();
  };

  private open = (placement: "float" | "tab"): void => {
    if (!this.state.panelId)
      return;

    const result = this.host.panels.open(this.state.panelId, { placement });
    if (!result)
      console.warn(`TacPhone panel inspector could not open panel "${this.state.panelId}".`);

    this.refresh();
  };

  render(): React.ReactNode {
    const { panels, panelId } = this.state;
    const knownPanels = this.host.apps.listPanels();

    return (
      <div style={inspectorBoxStyle}>
        <div style={inspectorRowStyle}>
          <strong>Panel inspector (dev)</strong>
          <button type="button" onClick={this.refresh}>Refresh</button>
          <select value={panelId} onChange={event => this.setState({ panelId: event.target.value })}>
            <option value="">Select a panel</option>
            {knownPanels.map(panel => (
              <option key={panel.id} value={panel.id}>{panel.title}</option>
            ))}
          </select>
          <button type="button" onClick={() => this.open("tab")} disabled={!panelId}>Open tab</button>
          <button type="button" onClick={() => this.open("float")} disabled={!panelId}>Open popup</button>
        </div>
        <div style={inspectorRowStyle}>
          {panels.map(panel => (
            <button key={panel.tabId} type="button" onClick={() => this.activate(panel)}>
              Activate {panel.instanceId ?? panel.tabId}
            </button>
          ))}
        </div>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {JSON.stringify(panels, null, 2)}
        </pre>
      </div>
    );
  }
}

const panelInspectorPanel: AppPanelInfo = {
  id: "ACE_TacPhone_PanelInspector",
  GetDefaultTitle: () => "Panel Inspector",
  appComponent: PanelInspectorPanelContent,
};

function devApps(): Array<AppPanelInfo> {
  return import.meta.env.DEV ? [panelInspectorPanel] : [];
}

export async function OnMessageFromGame(message: object): Promise<void> {

    const { c } = message as { c: string };

    if (c == "RequestTerrainSVG") {
        // Game would like to get SVG image sent back to it

        const { config, uid } = message as { config: object, uid: string };

        var terrainData = await window.TacPhone.networking.LoadGameTerrain(config);
        // terrainData is a raw several MB large SVG image
        // We need to reduce the size to transfer it

        console.log("Terrain data pre compress", terrainData.length);
        terrainData = await compressAndToBase64(terrainData);
        console.log("Terrain data compressed", terrainData.length);

        // Now we can send it back, we do that by sending a request to the game

        await window.TacPhone.networking.Request({ a: "main", c: "ReplyRequestTerrainSVG", uid: uid, data: terrainData });
    }

    if (c == "RequestTexture") {
        // Game would like to get the texture sent back to it

        const { path, maxSize, uid } = message as { path: string, maxSize: number, uid: string };

        var textureData = await window.TacPhone.networking.LoadGameFileTexture(path, maxSize);
        // textureData can be large
        // We need to reduce the size to transfer it

        console.log("Texture data pre compress", textureData.length);
        textureData = await compressAndToBase64(textureData);
        console.log("Texture data compressed", textureData.length);

        // Now we can send it back, we do that by sending a request to the game

        await window.TacPhone.networking.Request({ a: "main", c: "ReplyRequestTexture", uid: uid, data: textureData });
    }
};
