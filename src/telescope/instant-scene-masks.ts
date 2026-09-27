import { staticSceneBits, type StaticTerrainMask } from "./static-terrain-mask";

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

/** Decode each selected material image once, with bounded concurrency. Output
 * stays in placement order; repeated rooms share immutable bit masks. */
export async function loadInstantSceneMasks(
  placements: readonly Placement[],
  load: (key: string) => Promise<ScenePixels | null | undefined>,
): Promise<StaticTerrainMask[]> {
  const keys = [...new Set(placements.map((scene) => scene.key))];
  const byKey = new Map<string, Omit<StaticTerrainMask, "x" | "y">>();
  let next = 0,
    failed = false;
  await Promise.all(
    Array.from({ length: Math.min(8, keys.length) }, async () => {
      while (!failed && next < keys.length) {
        const key = keys[next++];
        try {
          const raw = await load(key);
          if (
            !raw?.imgElement ||
            !ArrayBuffer.isView(raw.imgElement) ||
            raw.width < 2 ||
            raw.height < 2
          )
            continue;
          const pixels = raw.imgElement as Uint8Array;
          byKey.set(key, {
            width: raw.width,
            height: raw.height,
            bits: staticSceneBits(pixels),
            airBits: staticSceneBits(pixels, true),
          });
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const masks: StaticTerrainMask[] = [];
  for (const scene of placements) {
    const mask = byKey.get(scene.key);
    if (mask) masks.push({ x: scene.x, y: scene.y, ...mask });
  }
  return masks;
}
