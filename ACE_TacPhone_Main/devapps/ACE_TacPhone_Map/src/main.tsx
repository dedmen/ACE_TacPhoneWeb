import React from 'react';
import App from './Map.tsx'
import type { AppPanelInfo } from './TacPhoneMain';


class AppPlaceholder extends React.Component<{}, {loading: boolean}> {
    render() {
        return (<><div style={{color: 'red'}}>Wololo!</div></>);
    }
}
export function GetTacPhoneApps(): Array<AppPanelInfo> {
  return [
    {
        id: "ACE_TacPhone_Map",
        appComponent: App,
        GetDefaultTitle() {
            return "Map";
        },
        GetTacPhoneIcon() {
            // https://fontawesome.com/icons
            // https://yoksel.github.io/url-encoder/
            return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 640'%3E%3C!--!Font Awesome Free v7.3.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--%3E%3Cpath d='M576 112C576 100.9 570.3 90.6 560.8 84.8C551.3 79 539.6 78.4 529.7 83.4L413.5 141.5L234.1 81.6C226 78.9 217.3 79.5 209.7 83.3L81.7 147.3C70.8 152.8 64 163.9 64 176L64 528C64 539.1 69.7 549.4 79.2 555.2C88.7 561 100.4 561.6 110.3 556.6L226.4 498.5L405.8 558.3C413.9 561 422.6 560.4 430.2 556.6L558.2 492.6C569 487.2 575.9 476.1 575.9 464L575.9 112zM256 440.9L256 156.4L384 199.1L384 483.6L256 440.9z'/%3E%3C/svg%3E"; 
        },

    },

    {
        id: "ACE_TacPhone_Map_Placeholder",
        appComponent: AppPlaceholder,
        GetDefaultTitle() {
            return "Placeholder";
        },
        GetTacPhoneIcon() {
            // https://fontawesome.com/icons
            // https://yoksel.github.io/url-encoder/
            return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 640'%3E%3C!--!Font Awesome Free v7.3.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--%3E%3Cpath d='M576 112C576 100.9 570.3 90.6 560.8 84.8C551.3 79 539.6 78.4 529.7 83.4L413.5 141.5L234.1 81.6C226 78.9 217.3 79.5 209.7 83.3L81.7 147.3C70.8 152.8 64 163.9 64 176L64 528C64 539.1 69.7 549.4 79.2 555.2C88.7 561 100.4 561.6 110.3 556.6L226.4 498.5L405.8 558.3C413.9 561 422.6 560.4 430.2 556.6L558.2 492.6C569 487.2 575.9 476.1 575.9 464L575.9 112zM256 440.9L256 156.4L384 199.1L384 483.6L256 440.9z'/%3E%3C/svg%3E"; 
        },

    }
  ]
};    

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

        await window.Networking.Request({ a: "ACE_TacPhone_Map", c: "ReplyRequestTerrainSVG", uid: uid, data: terrainData });
    }
};
