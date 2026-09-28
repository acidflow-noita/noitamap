import {
  createSceneTileCompositor, readRGBA, writeRGBA,
  type ScenePainter, type TerrainScene, type TerrainSceneSource,
} from "./terrain-scenes";
import { compositeTerrain, textureColor, type TerrainTexture } from "./terrain-backgrounds";
import { TERRAIN_VERSION } from "./terrain-policy";

/** These authored rooms are material instructions, never finished scene art.
 * Each is one native 512px chunk. Do not allocate per-instance bitmaps for the
 * thousands of ordinary scenes or larger authored images here. */
export function usesNativeSceneBitmap(scene: Pick<TerrainScene, "key" | "width" | "height">): boolean {
  return scene.width <= 512 && scene.height <= 512 &&
    (/^general\/watercave_layout_[1-5]$/.test(scene.key) ||
      scene.key === "general/solid_wall_hidden_cavern");
}

/** Material sampling depends on the absolute placement and variant. Keep this
 * namespace separate from the old flat composites and their scene prefetch. */
export function nativeSceneBitmapKey(scene: TerrainScene, worldSize: number): string {
  return `native-scene-v1/${TERRAIN_VERSION}/${worldSize}/${scene.key}/${scene.x},${scene.y}/${scene.variantKey ?? ""}`;
}

export function renderNativeSceneBitmap(
  scene: TerrainScene,
  source: TerrainSceneSource,
  paint: ScenePainter,
  worldSize: number,
  backdrop?: TerrainTexture,
): Uint8ClampedArray<ArrayBuffer> {
  if (!usesNativeSceneBitmap(scene) || source.width !== scene.width || source.height !== scene.height)
    throw new Error(`Unsupported native scene bitmap extent: ${scene.key}`);
  const terrain = new Uint8ClampedArray(scene.width * scene.height * 4);
  const background = new Uint8ClampedArray(terrain.length);
  const compositor = createSceneTileCompositor({
    scenes: [scene], sources: { [scene.key]: source },
  }, paint, 2 * 512 * 512 * 4, backdrop
    ? (_scene, x, y) => textureColor(backdrop, x + worldSize * 256, y + 7168)
    : null);
  compositor.paint(terrain, background, scene.x, scene.y, scene.width, scene.height);
  for (let i = 0; i < terrain.length; i += 4)
    writeRGBA(terrain, i, compositeTerrain(readRGBA(terrain, i), readRGBA(background, i)));
  return terrain;
}
