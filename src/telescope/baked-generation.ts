/**
 * baked-generation.ts
 *
 * Bakes the full telescope generation result (POIs, pixel-scene placements,
 * biome map) into a static JSON artifact and loads it back on the live map.
 *
 * Flow:
 *   - bake page: build-daily-seed-images.cjs calls the dev hook
 *     window.noitamap.exportGenerationData() -> serializeGenerationForBake()
 *     and writes <state>/generation.json next to the region manifest.
 *   - stitch-dzis.cjs splits that file per world (left/middle/right) into each
 *     CF Static Assets deploy root, alongside the DZIs.
 *   - live map: when the baked-DZI probe hits, fetchBakedGeneration() pulls
 *     generation.json from the same workers and hydrates a GenerationResult.
 *     dynamic-map.ts then renders WITHOUT ever initializing telescope: no
 *     wasm, no generation, no data.zip on the critical path.
 *
 * The serialized shape deliberately mirrors the IndexedDB cache entry in
 * tile-cache.ts (minus tileLayers, which only the live-composite path needs),
 * so hydration is the same reconstruction getCachedGeneration performs.
 */

import type { GenerationResult } from "./telescope-adapter";
import { originFor, type World } from "./baked-dzi-loader";

export const BAKED_GENERATION_VERSION = 1;

export interface BakedGenerationFile {
  version: number;
  seed: number;
  ngPlus: number;
  isNGP: boolean;
  worldSize: number;
  worldCenter: number;
  /** pw values whose POIs/scenes are present in THIS file (per-world slice). */
  parallelWorlds: number[];
  /** base64 of the Uint32Array biome-map pixels (identical in every slice). */
  biomeDataPixels: string;
  biomeDataW: number;
  biomeDataH: number;
  /** keys "pw,pvt" e.g. "0,0", "-1,0" */
  poisByPW: Record<string, any[]>;
  pixelScenesByPW: Record<string, any[]>;
}

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Browser-side (bake page): serialize the full generation result. */
export function serializeGenerationForBake(result: GenerationResult): BakedGenerationFile | null {
  if (!result || !result.biomeData?.pixels) return null;
  const pixelScenesByPW: Record<string, any[]> = {};
  for (const [pw, scenes] of Object.entries(result.pixelScenesByPW || {})) {
    pixelScenesByPW[pw] = (scenes as any[]).map((s) => ({
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      name: s.name,
      key: s.key,
      variantKey: s.variantKey || "",
      imgData: null,
    }));
  }
  return {
    version: BAKED_GENERATION_VERSION,
    seed: result.seed,
    ngPlus: result.ngPlus,
    isNGP: result.isNGP,
    worldSize: result.worldSize,
    worldCenter: result.worldCenter,
    parallelWorlds: result.parallelWorlds || [-1, 0, 1],
    biomeDataPixels: bufToB64(new Uint32Array(result.biomeData.pixels).buffer),
    biomeDataW: result.isNGP ? 72 : 70,
    biomeDataH: 48,
    poisByPW: result.poisByPW,
    pixelScenesByPW,
  };
}

/** Merge per-world slices and rebuild a render-ready GenerationResult. */
export function hydrateBakedGeneration(files: BakedGenerationFile[]): GenerationResult {
  const base = files[0];
  const poisByPW: Record<string, any[]> = {};
  const pixelScenesByPW: Record<string, any[]> = {};
  const pws = new Set<number>();
  for (const f of files) {
    Object.assign(poisByPW, f.poisByPW);
    for (const [k, scenes] of Object.entries(f.pixelScenesByPW || {})) {
      pixelScenesByPW[k] = (scenes as any[]).map((s) => ({ ...s, imgElement: null }));
    }
    for (const pw of f.parallelWorlds || []) pws.add(pw);
  }

  // Same biomeData reconstruction as getCachedGeneration in tile-cache.ts.
  const pixels = new Uint32Array(b64ToBuf(base.biomeDataPixels));
  const w = base.biomeDataW > 0 ? base.biomeDataW : base.isNGP ? 72 : 70;
  const h = base.biomeDataH > 0 ? base.biomeDataH : 48;
  const heavenPixels = new Uint32Array(pixels.length);
  const hellPixels = new Uint32Array(pixels.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      heavenPixels[y * w + x] = pixels[x % w];
      hellPixels[y * w + x] = pixels[(h - 1) * w + (x % w)];
    }
  }

  return {
    seed: base.seed,
    ngPlus: base.ngPlus,
    isNGP: base.isNGP,
    worldSize: base.worldSize,
    worldCenter: base.worldCenter,
    parallelWorlds: [...pws].sort((a, b) => a - b),
    biomeData: { pixels, heavenPixels, hellPixels, w, h },
    // Only the live-composite path reads tileLayers; the baked-DZI render
    // path never touches them (biomes come from the CF DZI pyramids).
    tileLayers: [],
    poisByPW,
    pixelScenesByPW,
    eyes: undefined,
  } as GenerationResult;
}

/**
 * Fetch + validate generation.json from each world worker. All-or-nothing,
 * mirroring the DZI probe: a partial POI set would render a half-empty map.
 * Returns null on any miss; caller falls back to client-side telescope.
 */
export async function fetchBakedGeneration(
  prefix: "daily" | "previous-daily",
  worlds: World[],
  seed: number,
): Promise<GenerationResult | null> {
  try {
    const files = await Promise.all(
      worlds.map(async (w) => {
        const resp = await fetch(`${originFor(prefix, w)}/generation.json`);
        if (!resp.ok) return null;
        const j = (await resp.json()) as BakedGenerationFile;
        if (!j || j.version !== BAKED_GENERATION_VERSION || j.seed !== seed || !j.biomeDataPixels) return null;
        return j;
      }),
    );
    if (files.some((f) => !f)) return null;
    return hydrateBakedGeneration(files as BakedGenerationFile[]);
  } catch (e) {
    console.warn("[baked-generation] fetch failed:", e);
    return null;
  }
}
