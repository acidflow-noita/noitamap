import { createTerrainScenes, readRGBA, writeRGBA, type TerrainScene, type TerrainSceneSource } from './terrain-scenes';
import { compositeTerrain, textureColor } from './terrain-backgrounds';
import { decodePngToRgba, type RawImageData } from './png-decode';

const BACKGROUND_PATH = 'data/weather_gfx/background_cave_04_alt.png';
let backgroundReady: Promise<RawImageData> | undefined;

function background() {
  return backgroundReady ??= (async () => {
    const { getZip } = await import('../data-archive');
    const file = (await getZip('main'))?.file(BACKGROUND_PATH);
    if (!file) throw new Error(`Missing Water Cave background: ${BACKGROUND_PATH}`);
    return decodePngToRgba(await file.async('arraybuffer'));
  })().catch(error => { backgroundReady = undefined; throw error; });
}

/** The layout PNG is material instructions, never visual artwork. Use the
 * baker's native scene painter; leave untouched pixels to the captured frame. */
export async function paintWaterCaveScene(scene: TerrainScene, source: TerrainSceneSource, withBackground: boolean) {
  const placed = { ...scene, width: source.width, height: source.height,
    variantKey: (scene.variantKey ?? '').split('&').some(part => part.startsWith('biome='))
      ? scene.variantKey : [scene.variantKey, 'biome=watercave'].filter(Boolean).join('&') };
  const texture = withBackground ? await background() : null;
  const painter = await createTerrainScenes({ scenes: [placed], sources: { [scene.key]: source } },
    texture ? (_scene, x, y) => textureColor(texture, x + 17920, y + 7168) : null);
  const pixels = new Uint8ClampedArray(source.width * source.height * 4);
  const backdrop = new Uint8ClampedArray(pixels.length);
  painter.paint(pixels, backdrop, placed.x, placed.y, source.width, source.height);
  for (let i = 0; i < pixels.length; i += 4)
    writeRGBA(pixels, i, compositeTerrain(readRGBA(pixels, i), readRGBA(backdrop, i)));
  return pixels;
}
