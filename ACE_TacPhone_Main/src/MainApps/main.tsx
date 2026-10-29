import React from "react";
import type { AppPanelInfo } from "../Backend/Types";
import type { PanelInfo } from "../Backend/PanelDirectory";

// These are apps included in TacPhone, even if no other apps are loaded. Core functionality like Notifications and Settings


export function GetTacPhoneApps(): Array<AppPanelInfo> {
  return [
    ...devApps,
  ]
};

// Dev host only: a read-only view of the open panels plus buttons to exercise
// window.PanelDirectory (activate, open a docked tab, open a floating popup).
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

class PanelInspectorPanelContent extends React.Component<{}, PanelInspectorState> {
  state: PanelInspectorState = {
    panels: window.PanelDirectory.list(),
    panelId: "",
  };

  private refresh = (): void => {
    this.setState({ panels: window.PanelDirectory.list() });
  };

  private activate = (panel: PanelInfo): void => {
    // A background tab has no instance yet; activate() also accepts its tab id.
    if (!window.PanelDirectory.activate(panel.instanceId ?? panel.tabId))
      console.warn(`TacPhone panel inspector could not activate tab "${panel.tabId}".`);

    this.refresh();
  };

  private open = (placement: "float" | "tab"): void => {
    if (!this.state.panelId)
      return;

    const result = window.PanelDirectory.open(this.state.panelId, { placement });
    if (!result)
      console.warn(`TacPhone panel inspector could not open panel "${this.state.panelId}".`);

    this.refresh();
  };

  render(): React.ReactNode {
    const { panels, panelId } = this.state;
    const knownPanels = [...window.AppDirectory.knownPanels.values()];

    return (
      <div style={inspectorBoxStyle}>
        <div style={inspectorRowStyle}>
          <strong>Panel inspector (dev)</strong>
          <button type="button" onClick={this.refresh}>Refresh</button>
          <select value={panelId} onChange={event => this.setState({ panelId: event.target.value })}>
            <option value="">Select a panel</option>
            {knownPanels.map(panel => (
              <option key={panel.id} value={panel.id}>{panel.id}</option>
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
  GetTacPhoneIcon: () => "",
  GetDefaultTitle: () => "Panel Inspector",
  appComponent: PanelInspectorPanelContent,
};

const devApps: Array<AppPanelInfo> = import.meta.env.DEV ? [panelInspectorPanel] : [];

//#TODO but this somewhere else?
// 1. Compress a string and turn it into Base64
async function compressAndToBase64(input: string): Promise<string> {
  // Convert string to bytes
  const byteArray = new TextEncoder().encode(input);

  // Create a compression stream (can use 'gzip' or 'deflate')
  const stream = new Blob([byteArray]).stream();
  const compressionStream = new CompressionStream("gzip");
  const compressedStream = stream.pipeThrough(compressionStream);

  // Read the compressed stream into an ArrayBuffer
  const response = new Response(compressedStream);
  const buffer = await response.arrayBuffer();
  console.log("compress3");

  // Convert compressed bytes to Base64
  //const compressedBytes = new Uint8Array(buffer);

  // Native modern approach (or fall back to Buffer in Node / btoa in older browsers)
  //if (typeof compressedBytes.toBase64 === "function") { // Steam still ships Chrome 126 (thats from june 2024), .toBase64 is chrome 140 (september 2025)
  //  return compressedBytes.toBase64();
  //}

  // Fallback for older browsers
  //return btoa(String.fromCharCode(...compressedBytes)); // This does not work, the spread operator tries to push it all to stack, which is way too large. It would be better on chrome 140 to use toBase64()

  // Convert the buffer into a Blob
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  
  // Use FileReader to safely and efficiently generate a Base64 Data URL
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = (reader.result as string).split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}


export async function OnMessageFromGame(message: object): Promise<void> {
  
    const { c } = message as { c: string };

    if (c == "RequestTerrainSVG") {
        // Game would like to get SVG image sent back to it

        const { config, uid } = message as { config: object, uid: string };

        var terrainData = await window.Networking.LoadGameTerrain(config);
        // terrainData is a raw several MB large SVG image
        // We need to reduce the size to transfer it

        console.log("Terrain data pre compress", terrainData.length);
        terrainData = await compressAndToBase64(terrainData);
        console.log("Terrain data compressed", terrainData.length);

        // Now we can send it back, we do that by sending a request to the game

        await window.Networking.Request({ a: "main", c: "ReplyRequestTerrainSVG", uid: uid, data: terrainData });
    }

    if (c == "RequestTexture") {
        // Game would like to get the texture sent back to it

        const { path, maxSize, uid } = message as { path: string, maxSize: number, uid: string };

        var textureData = await window.Networking.LoadGameFileTexture(path, maxSize);
        // textureData can be large
        // We need to reduce the size to transfer it

        console.log("Texture data pre compress", textureData.length);
        textureData = await compressAndToBase64(textureData);
        console.log("Texture data compressed", textureData.length);

        // Now we can send it back, we do that by sending a request to the game

        await window.Networking.Request({ a: "main", c: "ReplyRequestTexture", uid: uid, data: textureData });
    }
};
