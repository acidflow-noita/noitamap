import { createTerrainScenes, readRGBA, writeRGBA, type TerrainScene, type TerrainSceneSource } from './terrain-scenes';
import { compositeTerrain, textureColor } from './terrain-backgrounds';
import { decodePngToRgba, type RawImageData } from './png-decode';
import { EDGE_DECAL_HALO, initEdgeDecalAtlas, stampEdgeDecals } from 'noita-telescope-full-pixels/edge_decals.js';
import { sceneMaterialGrid } from './scene-material-grid';

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
export async function paintWaterCaveScene(scene: TerrainScene, source: TerrainSceneSource, withBackground: boolean, seed: number) {
  const placed = { ...scene, width: source.width, height: source.height,
    variantKey: (scene.variantKey ?? '').split('&').some(part => part.startsWith('biome='))
      ? scene.variantKey : [scene.variantKey, 'biome=watercave'].filter(Boolean).join('&') };
  const texture = withBackground ? await background() : null;
  const [painter] = await Promise.all([
    createTerrainScenes({ scenes: [placed], sources: { [scene.key]: source } },
      texture ? (_scene, x, y) => textureColor(texture, x + 17920, y + 7168) : null),
    initEdgeDecalAtlas(),
  ]);
  const pixels = new Uint8ClampedArray(source.width * source.height * 4);
  const backdrop = new Uint8ClampedArray(pixels.length);
  painter.paint(pixels, backdrop, placed.x, placed.y, source.width, source.height);
  // EdgeGraphics dresses the scene's material cells before the backdrop is
  // composited. Use the scene-local pass, without resolving a world lattice.
  // As in the baker, stamps use deterministic seed/position randomness rather
  // than the game's runtime RNG, so individual flecks can differ from a capture.
  const pad = EDGE_DECAL_HALO, width = source.width + 2 * pad, height = source.height + 2 * pad;
  const decals = stampEdgeDecals(new Int16Array(width * height), width, height,
    placed.x - pad, placed.y - pad, seed, { scenes: [sceneMaterialGrid(placed, source)], inset: pad });
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4, s = ((y + pad) * width + x + pad) * 4;
      let material = readRGBA(pixels, i);
      if (source.data[i + 3] && decals[s + 3]) material = compositeTerrain(readRGBA(decals, s), material);
      writeRGBA(pixels, i, compositeTerrain(material, readRGBA(backdrop, i)));
    }
  }
  return pixels;
}
