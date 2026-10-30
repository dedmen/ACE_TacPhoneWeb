/**
 * Gzip-compresses a string and returns it as a base64 string.
 * The game cannot pass large text through the browser bridge directly.
 */
export async function compressAndToBase64(input: string): Promise<string> {
  // Convert string to bytes
  const byteArray = new TextEncoder().encode(input);

  // Create a compression stream (can use 'gzip' or 'deflate')
  const stream = new Blob([byteArray]).stream();
  const compressionStream = new CompressionStream("gzip");
  const compressedStream = stream.pipeThrough(compressionStream);

  // Read the compressed stream into an ArrayBuffer
  const response = new Response(compressedStream);
  const buffer = await response.arrayBuffer();

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

/** Decompresses a base64 string produced by `compressAndToBase64`. */
export async function decompressFromBase64(base64Input: string): Promise<string> {
  // Reconstruct a full Data URL from the Base64 string
  const dataUrl = `data:application/octet-stream;base64,${base64Input}`;

  // Use fetch ONLY to convert the data URL into a Blob (this does not hit the network)
  const blob = await fetch(dataUrl).then(res => res.blob());

  // Use FileReader to safely read the blob as an ArrayBuffer
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });

  // Create a decompression stream using 'gzip'
  const stream = new Blob([buffer]).stream();
  const decompressionStream = new DecompressionStream("gzip");
  const decompressedStream = stream.pipeThrough(decompressionStream);

  // Read the decompressed stream into an ArrayBuffer
  const response = new Response(decompressedStream);
  const decompressedBuffer = await response.arrayBuffer();

  // Decode the ArrayBuffer back to a string
  return new TextDecoder().decode(decompressedBuffer);
}
