import Flatbush from 'flatbush';
import { getInstantLiquidClipping, resolveInstantLiquidMaterials } from '../telescope/instant-terrain-backend';
import { loadLiquidMaterialIds } from '../telescope/liquid-surfaces';
import { sceneMaterialGrid, SCENE_UNTOUCHED } from '../telescope/scene-material-grid';
import type { TerrainScene, TerrainSceneSource } from '../telescope/terrain-scenes';
import { WORLD_HEIGHT, WORLD_TOP, type VerticalPlane } from '../telescope/terrain-policy';
import type { MaskBounds } from './mask-index';

export interface LiveLiquidInput {
  seed: number;
  scenes: readonly TerrainScene[];
  loadScene(key: string): Promise<{ width: number; height: number; imgElement?: unknown } | null | undefined>;
}

function sceneWindow(scene: TerrainScene, source: { width: number; height: number; imgElement?: unknown }, bounds: MaskBounds) {
  if (!(source.imgElement instanceof Uint8Array || source.imgElement instanceof Uint8ClampedArray)) return null;
  const left = Math.max(bounds.x, scene.x), top = Math.max(bounds.y, scene.y);
  const right = Math.min(bounds.x + bounds.width, scene.x + source.width);
  const bottom = Math.min(bounds.y + bounds.height, scene.y + source.height);
  if (right <= left || bottom <= top) return null;
  const width = right - left, height = bottom - top, data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((top - scene.y + y) * source.width + left - scene.x) * 4;
    data.set(source.imgElement.subarray(start, start + width * 4), y * width * 4);
  }
  return sceneMaterialGrid({ ...scene, x: left, y: top, width, height }, { data, width, height } as TerrainSceneSource);
}

/** Only the requested 256px blocks are resolved. The shared warm GPU performs
 * material queries asynchronously; authored scenes use the same ID resolver
 * as the baker. No image-color classification and no second terrain setup. */
export async function createLiveLiquidSource(input: LiveLiquidInput) {
  const [clip, ids] = await Promise.all([getInstantLiquidClipping(input.seed), loadLiquidMaterialIds()]);
  if (!clip) return null;
  const eligible = new Uint8Array(32768);
  for (const id of ids) if (id >= 0 && id < eligible.length) eligible[id] = 255;
  const masks = clip.masks;
  const maskIndex = masks.length ? new Flatbush(masks.length) : null;
  for (const mask of masks) maskIndex!.add(mask.x, mask.y, mask.x + mask.width, mask.y + mask.height);
  maskIndex?.finish();
  const scenes = input.scenes.filter(scene => scene.width > 0 && scene.height > 0 && !scene.key.startsWith('static_tile/'));
  const sceneIndex = scenes.length ? new Flatbush(scenes.length) : null;
  for (const scene of scenes) sceneIndex!.add(scene.x, scene.y, scene.x + scene.width, scene.y + scene.height);
  sceneIndex?.finish();
  let queries = 0, queryMS = 0;
  return {
    stats: () => ({ queries, queryMS }),
    async paint(bounds: MaskBounds, pixels: Uint8Array, signal: AbortSignal) {
      signal.throwIfAborted();
      if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) || bounds.width !== 256 || bounds.height !== 256 ||
        bounds.x % 256 || bounds.y % 256 || pixels.length !== 256 * 256)
        throw new Error('Live liquid masks require aligned 256px blocks');
      const plane = Math.floor((bounds.y - WORLD_TOP) / WORLD_HEIGHT);
      const owner = clip.owners[plane + 1];
      const chunkX = owner ? ((Math.floor((bounds.x + owner.width * 256) / 512) % owner.width) + owner.width) % owner.width : 0;
      const chunkY = Math.floor((bounds.y - WORLD_TOP - plane * WORLD_HEIGHT) / 512);
      if (owner && chunkY >= 0 && chunkY < 48 && owner.owners[chunkY * owner.width + chunkX] >= 0) {
        const started = performance.now();
        const result = await resolveInstantLiquidMaterials(input.seed,
          [{ x0: bounds.x, y0: bounds.y, w: bounds.width, h: bounds.height }], plane as VerticalPlane, signal);
        if (!result) return false;
        queries++; queryMS += performance.now() - started;
        signal.throwIfAborted();
        const protectedPixels = new Uint8Array(pixels.length);
        for (const id of maskIndex?.search(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height) ?? []) {
          const m = masks[id];
          for (let y = Math.max(bounds.y, m.y); y < Math.min(bounds.y + bounds.height, m.y + m.height); y++)
            for (let x = Math.max(bounds.x, m.x); x < Math.min(bounds.x + bounds.width, m.x + m.width); x++) {
              const p = (y - m.y) * m.width + x - m.x;
              if (((m.bits[p >> 3] ?? 0) | (m.airBits?.[p >> 3] ?? 0)) & (1 << (p & 7)))
                protectedPixels[(y - bounds.y) * bounds.width + x - bounds.x] = 1;
            }
        }
        const bytes = result[0];
        for (let y = 0; y < bounds.height; y++) for (let x = 0; x < bounds.width; x++) {
          const out = y * bounds.width + x;
          if (protectedPixels[out]) continue;
          const at = ((bounds.height - 1 - y) * bounds.width + x) * 4;
          const id = bytes[at] + (bytes[at + 1] << 8) - 1;
          pixels[out] = eligible[id] ?? 0;
        }
      }
      for (const id of (sceneIndex?.search(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height) ?? []).sort((a, b) => a - b)) {
        const scene = scenes[id], source = await input.loadScene(scene.key);
        signal.throwIfAborted(); if (!source) continue;
        const material = sceneWindow(scene, source, bounds); if (!material) continue;
        for (let y = 0; y < material.height; y++) for (let x = 0; x < material.width; x++) {
          const value = material.grid[y * material.width + x];
          if (value === SCENE_UNTOUCHED) continue;
          pixels[(y + material.y - bounds.y) * bounds.width + x + material.x - bounds.x] = eligible[value] ?? 0;
        }
      }
      return true;
    },
  };
}
