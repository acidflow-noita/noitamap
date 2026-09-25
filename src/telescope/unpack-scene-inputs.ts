import { decodeScenePack } from "./scene-pack";

export async function unpackSceneInputs(
  compressed: ArrayBuffer,
  bytes: number,
  provenance: string,
) {
  const input = new Uint8Array(compressed);
  // Hosts may transparently decode .gz assets; validate either representation.
  const decoded =
    input[0] === 0x1f && input[1] === 0x8b
      ? await new Response(
          new Blob([compressed])
            .stream()
            .pipeThrough(new DecompressionStream("gzip")),
        ).arrayBuffer()
      : compressed;
  if (decoded.byteLength !== bytes)
    throw new Error("Prepared scene size mismatch");
  return decodeScenePack(decoded, provenance);
}
