import type { PixelScene } from "./telescope-adapter";

// Nightmare's data/biome/_pixel_scenes.xml includes the three material slices in
// data/biome_impl/spliced/lavalake_pit_bottom.xml, only in the central world.
const PIT_SCENE = "spliced/lavalake_pit_bottom";
const parts = [0, 1, 2].map(i => `${PIT_SCENE}/${i}`);
const chunk = 512;

export const pitPart = (key: string) => parts.indexOf(key);
export const pitBackground = (part: number) => `data/biome_impl/${PIT_SCENE}/${part}_background.png`;

export function nightmarePitScenes(pixels: ArrayLike<number>, width: number, center: number, names: Record<number, string>): PixelScene[] {
  return parts.map((key, part) => {
    const cx = 5 + part, cy = 6;
    const biome = names[pixels[(cy + 14) * width + cx + center] & 0xffffff] ?? "general";
    return { key, name: `lavalake_pit_bottom/${part}`, x: cx * chunk, y: cy * chunk,
      width: chunk, height: chunk, variantKey: `biome=${biome}`, imgElement: null! };
  });
}

/** Split the original material strip at the same boundaries as the three game PLZ files. */
export function pitMaterialSlice(source: { data: Uint8Array | Uint8ClampedArray; width: number; height: number }, part: number) {
  if (source.width !== 3 * chunk || source.height !== chunk) throw new Error("Unexpected lava pit splice dimensions");
  const data = new Uint8Array(chunk * chunk * 4);
  for (let y = 0; y < chunk; y++) {
    const start = (y * source.width + part * chunk) * 4;
    data.set(source.data.subarray(start, start + chunk * 4), y * chunk * 4);
  }
  // Black in this material image leaves the current world pixel untouched.
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) data[i + 3] = 0;
  }
  return data;
}

let materials: Promise<Uint8Array[]> | undefined;
export function loadPitMaterials(): Promise<Uint8Array[]> {
  return materials ??= (async () => {
    const [{ getZip }, { decodePngToRgba }] = await Promise.all([import("../data-archive"), import("./png-decode")]);
    const file = (await getZip("main"))?.file("data/biome_impl/spliced/lavalake_pit_bottom.png");
    if (!file) throw new Error("Missing original lava pit material image");
    const strip = decodePngToRgba(await file.async("arraybuffer"));
    return parts.map((_, part) => pitMaterialSlice(strip, part));
  })().catch(error => { materials = undefined; throw error; });
}
