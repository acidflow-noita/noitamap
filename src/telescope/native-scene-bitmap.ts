import {
  readRGBA, writeRGBA,
  type ScenePainter, type ScenePixels, type TerrainScene, type TerrainSceneSource,
} from "./terrain-scenes";
import { compositeTerrain, textureColor, type TerrainTexture } from "./terrain-backgrounds";
import { BIOME_BACKGROUND_MAP, sceneBiomeNames, TERRAIN_VERSION } from "./terrain-policy";

/** Every material scene uses native textures. Static tiles are already artwork. */
export function usesNativeSceneBitmap(scene: Pick<TerrainScene, "key" | "width" | "height">): boolean {
  return !scene.key.startsWith("static_tile/") && scene.width > 0 && scene.height > 0;
}

// These source PNGs contain authored partial alpha, independently of material
// translucency. Preserve their underlying-layer treatment rather than claiming
// that the displayed bitmap covers every reserved cell opaquely.
const TRANSLUCENT_SCENE_ART = new Set([
  "excavationsite/meditation_cube_visual", "mountain/right_bottom",
]);

/** Native material bitmaps include the opaque biome backdrop beneath force-air,
 * density-air and translucent material cells. Transparent texture texels and
 * cleared spawn instructions place no cell and leave the terrain untouched.
 * Erasing either kind in a separate cached camera creates moving gaps when the
 * artwork is resampled at the current camera. Static artwork, disabled layers
 * and scenes without a known backdrop still need their separate masks. */
export function nativeSceneBitmapReplacesTerrain(
  scene: Pick<TerrainScene, "key" | "width" | "height" | "variantKey">,
  layers: { background: boolean; materials: boolean },
): boolean {
  return layers.background && layers.materials && usesNativeSceneBitmap(scene)
    && !TRANSLUCENT_SCENE_ART.has(scene.key)
    && sceneBiomeNames(scene).some(name => !!BIOME_BACKGROUND_MAP[name]);
}

/** Material sampling depends on the absolute placement and variant. Keep this
 * namespace separate from the old flat composites and their scene prefetch. */
export function nativeSceneBitmapKey(scene: TerrainScene & { backgroundArt?: string | null }, worldSize: number): string {
  return `native-scene-v2/${TERRAIN_VERSION}/${worldSize}/${scene.key}/${scene.x},${scene.y}/${scene.variantKey ?? ""}/${scene.backgroundArt ?? ""}`;
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
  const output = new Uint8ClampedArray(scene.width * scene.height * 4);
  // Material density and texture phase use absolute placement. Resolve bounded
  // native blocks so a large authored scene does not allocate several full
  // RGBA intermediates alongside its source and final compressed image.
  const crop = (image: ScenePixels, x: number, y: number, width: number, height: number): ScenePixels => {
    const bytes = new Uint8Array(width * height * 4);
    const endX = Math.min(image.width, x + width), endY = Math.min(image.height, y + height);
    for (let row = y; row < endY; row++) if (endX > x)
      bytes.set(image.data.subarray((row * image.width + x) * 4, (row * image.width + endX) * 4),
        (row - y) * width * 4);
    return { data: bytes, width, height };
  };
  for (let y = 0; y < scene.height; y += 512) for (let x = 0; x < scene.width; x += 512) {
    const width = Math.min(512, scene.width - x), height = Math.min(512, scene.height - y);
    const block: TerrainSceneSource = { ...source, ...crop(source, x, y, width, height),
      skipEdgeTextures: source.skipEdgeTextures,
      visualArt: source.visualArt ? crop(source.visualArt, x, y, width, height) : null };
    const background = source.backgroundArt ? crop(source.backgroundArt, x, y, width, height) : null;
    const instance = { ...scene, x: scene.x + x, y: scene.y + y, width, height };
    const painted = paint(instance, block);
    for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
      const index = (row * width + column) * 4;
      // Background art belongs behind terrain. Only cells this scene erases
      // or paints may carry it into the foreground bitmap; untouched cells
      // must not turn the sprite's bounding rectangle into a terrain cover.
      let under = background && (painted.pixels[index + 3] || painted.airMask?.[index + 3])
        ? readRGBA(background.data, index) : 0;
      if (backdrop && painted.airMask?.[index + 3])
        under = compositeTerrain(under, textureColor(backdrop,
          instance.x + column + worldSize * 256, instance.y + row + 7168));
      writeRGBA(output, ((y + row) * scene.width + x + column) * 4,
        compositeTerrain(readRGBA(painted.pixels, index), under));
    }
  }
  return output;
}
