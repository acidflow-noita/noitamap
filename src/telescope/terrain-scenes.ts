import Flatbush from "flatbush";
import { compositeTerrain } from "./terrain-backgrounds";

export interface ScenePixels {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}
export interface TerrainScene {
  key: string;
  name: string;
  variantKey?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface TerrainSceneSource extends ScenePixels {
  visualArt?: ScenePixels | null;
  backgroundArt?: ScenePixels | null;
}
/** Raw, un-recolored sources are shared. Textures and biome bands depend on the
 * INSTANCE's absolute world coordinates, never just its scene/variant name. */
export interface TerrainSceneData {
  scenes: TerrainScene[];
  sources: Record<string, TerrainSceneSource>;
}
export interface PaintedScene {
  pixels: Uint8Array | Uint8ClampedArray;
  airMask: Uint8Array | Uint8ClampedArray | null;
}
export type ScenePainter = (
  scene: TerrainScene,
  source: TerrainSceneSource,
) => PaintedScene;

export function readRGBA(
  data: Uint8Array | Uint8ClampedArray,
  i: number,
): number {
  return (
    ((data[i + 3] << 24) |
      (data[i] << 16) |
      (data[i + 1] << 8) |
      data[i + 2]) >>>
    0
  );
}
export function writeRGBA(
  data: Uint8ClampedArray,
  i: number,
  rgba: number,
): void {
  data[i] = (rgba >>> 16) & 255;
  data[i + 1] = (rgba >>> 8) & 255;
  data[i + 2] = rgba & 255;
  data[i + 3] = rgba >>> 24;
}

/** Cell-color art does not place material in air. It overrides only cells that
 * the material pass actually painted opaque (Noita's colors_filename rule). */
export function applySceneVisualArt(
  pixels: Uint8Array | Uint8ClampedArray,
  source: TerrainSceneSource,
): void {
  const art = source.visualArt;
  if (!art) return;
  for (let y = 0; y < Math.min(source.height, art.height); y++)
    for (let x = 0; x < Math.min(source.width, art.width); x++) {
      const d = (y * source.width + x) * 4;
      if (pixels[d + 3] !== 255) continue;
      const s = (y * art.width + x) * 4,
        a = art.data[s + 3];
      for (let c = 0; c < 3; c++)
        pixels[d + c] =
          ((art.data[s + c] * a + pixels[d + c] * (255 - a) + 127) / 255) | 0;
    }
}

/** Scene backgrounds, force-air and material cells are different paint passes.
 * Flattening them into one source-over bitmap leaves terrain inside air holes,
 * paints background art over rock, and creates opaque biome-color rectangles. */
export function createSceneTileCompositor(
  data: TerrainSceneData,
  paint: ScenePainter,
  budget = 64 * 1024 * 1024,
) {
  const index = data.scenes.length ? new Flatbush(data.scenes.length) : null;
  for (const scene of data.scenes) {
    const source = data.sources[scene.key];
    index!.add(
      scene.x,
      scene.y,
      scene.x + Math.max(scene.width, source.backgroundArt?.width ?? 0),
      scene.y + Math.max(scene.height, source.backgroundArt?.height ?? 0),
    );
  }
  index?.finish();
  const cache = new Map<number, PaintedScene>();
  let bytes = 0;
  const size = (p: PaintedScene) =>
    p.pixels.byteLength + (p.airMask?.byteLength ?? 0);
  const instance = (id: number) => {
    let p = cache.get(id);
    if (p) {
      cache.delete(id);
      cache.set(id, p);
      return p;
    }
    p = paint(data.scenes[id], data.sources[data.scenes[id].key]);
    cache.set(id, p);
    bytes += size(p);
    while (bytes > budget && cache.size > 1) {
      const oldest = cache.keys().next().value!;
      bytes -= size(cache.get(oldest)!);
      cache.delete(oldest);
    }
    return p;
  };
  function blit(
    image: ScenePixels,
    scene: TerrainScene,
    tile: Uint8ClampedArray,
    x: number,
    y: number,
    w: number,
    h: number,
    mask?: PaintedScene["airMask"],
  ) {
    const left = Math.max(x, scene.x),
      top = Math.max(y, scene.y);
    const right = Math.min(x + w, scene.x + image.width),
      bottom = Math.min(y + h, scene.y + image.height);
    for (let wy = top; wy < bottom; wy++)
      for (let wx = left; wx < right; wx++) {
        const s = ((wy - scene.y) * image.width + wx - scene.x) * 4;
        const d = ((wy - y) * w + wx - x) * 4;
        const under = mask?.[s + 3] ? 0 : readRGBA(tile, d);
        writeRGBA(tile, d, compositeTerrain(readRGBA(image.data, s), under));
      }
  }
  return {
    contains(x: number, y: number, w: number, h: number) {
      return (index?.search(x, y, x + w, y + h).length ?? 0) > 0;
    },
    paint(
      terrain: Uint8ClampedArray,
      background: Uint8ClampedArray,
      x: number,
      y: number,
      w: number,
      h: number,
    ) {
      // Flatbush's query order is spatial, NOT the game's scene paint order.
      const ids = (index?.search(x, y, x + w, y + h) ?? []).sort(
        (a, b) => a - b,
      );
      for (const id of ids) {
        const scene = data.scenes[id],
          source = data.sources[scene.key];
        if (source.backgroundArt)
          blit(source.backgroundArt, scene, background, x, y, w, h);
      }
      for (const id of ids) {
        const scene = data.scenes[id],
          p = instance(id);
        blit(
          { data: p.pixels, width: scene.width, height: scene.height },
          scene,
          terrain,
          x,
          y,
          w,
          h,
          p.airMask,
        );
      }
    },
  };
}

/** #000042 is the game's FORCE AIR instruction, including scenes for which
 * Telescope's old overlay paints an opaque placeholder (shops/capsules/rooms).
 * Those display exceptions are not material instructions. */
export function applySceneForceAir(
  raw: Uint8Array | Uint8ClampedArray,
  painted: PaintedScene,
): void {
  for (let i = 0; i < raw.length; i += 4) {
    if (!raw[i + 3] || raw[i] !== 0 || raw[i + 1] !== 0 || raw[i + 2] !== 0x42)
      continue;
    painted.pixels[i + 3] = 0;
    painted.airMask ??= new Uint8Array(raw.length);
    painted.airMask[i + 3] = 255;
  }
}

const compositors = new WeakMap<
  TerrainSceneData,
  Promise<ReturnType<typeof createSceneTileCompositor>>
>();
export function createTerrainScenes(data: TerrainSceneData) {
  let pending = compositors.get(data);
  if (!pending) {
    pending = (async () => {
      const sceneModule =
        await import("noita-telescope-full-pixels/pixel_scene_generation.js");
      if (!(await sceneModule.initPixelSceneTextures()))
        throw new Error(
          "Full-resolution scene material textures could not be loaded",
        );
      return createSceneTileCompositor(data, (scene, source) => {
        let raw: Uint8Array | Uint8ClampedArray = source.data;
        let biome = scene.key.split("/")[0];
        for (const part of (scene.variantKey ?? "").split("&")) {
          const eq = part.indexOf("=");
          if (eq < 0) continue;
          if (part.slice(0, eq) === "biome") biome = part.slice(eq + 1);
          else
            raw = sceneModule.recolorPixelScene(
              raw,
              parseInt(part.slice(0, eq), 16),
              parseInt(part.slice(eq + 1), 16),
            );
        }
        const p = sceneModule.texturePixelSceneForBiome(
          scene.name,
          raw,
          source.width,
          source.height,
          biome,
          scene.x,
          scene.y,
        );
        applySceneForceAir(raw, p);
        applySceneVisualArt(p.pixels, source);
        return p;
      });
    })();
    compositors.set(data, pending);
  }
  return pending;
}
