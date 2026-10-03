import type { RawImageData } from "./png-decode";

const splicedBackgrounds = import.meta.glob<string>(
  "../../lib/noita-telescope-vm/data/pixel_scenes/spliced/*_background.png",
  { query: "?url", import: "default", eager: true },
);

/** Telescope also ships generated backgrounds that do not exist in data.zip. */
export async function loadSceneBackground(path: string): Promise<RawImageData> {
  // @ts-ignore — upstream JavaScript, with asset URLs rewritten by Vite.
  const { loadPackedImage } = await import("noita-telescope-full-pixels/asset_pack.js");
  const packed = await loadPackedImage(`../${path}`);
  if (packed) return { ...packed, data: new Uint8ClampedArray(packed.data) };

  // Retain the archive fallback when native gzip decompression is unavailable.
  const { decodePngToRgba } = await import("./png-decode");
  const spliced = splicedBackgrounds[`../../lib/noita-telescope-vm/${path}`];
  if (spliced) {
    const response = await fetch(spliced);
    if (!response.ok) throw new Error(`Missing scene background: ${path} (HTTP ${response.status})`);
    return decodePngToRgba(await response.arrayBuffer());
  }
  const { getDataZip } = await import("../data-archive");
  const archivePath = path.replace(/^data\/backgrounds\//, "data/");
  const file = (await getDataZip())?.file(archivePath);
  if (!file) throw new Error(`Missing scene background: ${path}`);
  return decodePngToRgba(await file.async("arraybuffer"));
}
