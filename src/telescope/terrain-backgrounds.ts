import { decodePngToRgba } from "./png-decode";
import { BIOME_BACKGROUND_MAP } from "./terrain-policy";
export interface TerrainTexture {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
const textures = new Map<string, Promise<TerrainTexture>>();

/** Original game background bytes, at native resolution. No 1/10 canvas. */
export async function loadTerrainBackgrounds(
  names: string[],
): Promise<Map<string, TerrainTexture>> {
  const out = new Map<string, TerrainTexture>();
  const { getZip } = await import("../data-archive");
  const archive = await getZip("main");
  if (!archive)
    throw new Error(
      "World data archive is unavailable for terrain backgrounds",
    );
  for (const name of new Set(names)) {
    const path = BIOME_BACKGROUND_MAP[name];
    if (!path) continue; // sky/clouds intentionally reveal the static backdrop
    let texture = textures.get(path);
    if (!texture) {
      texture = (async () => {
        const file = archive.file(path);
        if (!file) throw new Error(`Missing biome background: ${path}`);
        return decodePngToRgba(await file.async("arraybuffer"));
      })();
      textures.set(path, texture);
    }
    out.set(name, await texture);
  }
  return out;
}

/** Straight-alpha source-over, shared by native bake and browser CPU tiles. */
export function compositeTerrain(fg: number, bg: number): number {
  const a = fg >>> 24,
    b = bg >>> 24;
  if (a === 255 || b === 0) return fg;
  if (a === 0) return bg;
  const weight = b * (255 - a),
    alpha = a * 255 + weight;
  const channel = (shift: number) =>
    Math.round(
      (((fg >>> shift) & 255) * a * 255 + ((bg >>> shift) & 255) * weight) /
        alpha,
    );
  return (
    ((Math.round(alpha / 255) << 24) |
      (channel(16) << 16) |
      (channel(8) << 8) |
      channel(0)) >>>
    0
  );
}
export function textureColor(
  texture: TerrainTexture,
  x: number,
  y: number,
): number {
  const tx = ((x % texture.width) + texture.width) % texture.width;
  const ty = ((y % texture.height) + texture.height) % texture.height;
  const o = (ty * texture.width + tx) * 4,
    p = texture.data;
  return ((p[o + 3] << 24) | (p[o] << 16) | (p[o + 1] << 8) | p[o + 2]) >>> 0;
}
