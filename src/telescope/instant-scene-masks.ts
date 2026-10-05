import { staticSceneBits, type StaticTerrainMask } from "./static-terrain-mask";
import { prepareAssetJobs } from "./background-idle";

interface Placement {
  key: string;
  x: number;
  y: number;
}
interface ScenePixels {
  width: number;
  height: number;
  imgElement?: unknown;
}

type MaskPixels = Omit<StaticTerrainMask, "x" | "y">;
// Telescope publishes pixels after spawn cleanup and replaces the view on
// reload. Key by that immutable view, not by a scene name or seed. Weak keys
// let old masks go when their decoded source pixels are no longer retained.
const preparedMasks = new WeakMap<ArrayBufferView, { byteLength: number; mask: MaskPixels }>();

/** Decode each selected material image once, with bounded concurrency. Output
 * stays in placement order; rooms and later seeds share immutable bit masks. */
export async function loadInstantSceneMasks(
  placements: readonly Placement[],
  load: (key: string) => Promise<ScenePixels | null | undefined>,
): Promise<StaticTerrainMask[]> {
  const keys = [...new Set(placements.map((scene) => scene.key))];
  const byKey = new Map<string, MaskPixels>();
  await prepareAssetJobs(keys, async key => {
    const raw = await load(key);
    if (
      !raw?.imgElement ||
      !ArrayBuffer.isView(raw.imgElement) ||
      raw.width < 2 ||
      raw.height < 2
    )
      return;
    const pixels = raw.imgElement as Uint8Array;
    const cached = preparedMasks.get(pixels);
    let mask = cached?.mask;
    if (!mask || mask.width !== raw.width || mask.height !== raw.height || cached?.byteLength !== pixels.byteLength) {
      mask = {
        width: raw.width,
        height: raw.height,
        bits: staticSceneBits(pixels),
        airBits: staticSceneBits(pixels, true),
      };
      preparedMasks.set(pixels, { byteLength: pixels.byteLength, mask });
    }
    byKey.set(key, mask);
  });
  const masks: StaticTerrainMask[] = [];
  for (const scene of placements) {
    const mask = byKey.get(scene.key);
    if (mask) masks.push({ x: scene.x, y: scene.y, ...mask });
  }
  return masks;
}
