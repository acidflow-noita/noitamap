import { BIOME_BACKGROUND_MAP, STATIC_TERRAIN_BIOMES } from './terrain-policy';
import { createBiomeBackgroundTiles, type BiomeBackgroundRegion } from './biome-background-tile-source';

const phaseX = -17920, phaseY = -7168;

export function biomeBackgroundGeometry(biomes: { filename: string; svg_map_path: string }[]) {
  const regions: BiomeBackgroundRegion[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const biome of biomes) {
    const textureKey = BIOME_BACKGROUND_MAP[biome.filename];
    if (!textureKey || STATIC_TERRAIN_BIOMES.has(biome.filename)) continue;
    const rings: BiomeBackgroundRegion['rings'] = [];
    let ring: BiomeBackgroundRegion['rings'][number] = [];
    const tokens = biome.svg_map_path.trim().split(/\s+/);
    for (let i = 0; i < tokens.length;) {
      const command = tokens[i++];
      if (command === 'Z') continue;
      if (command !== 'M' && command !== 'L') throw new Error('Invalid biome background boundary');
      const x = Number(tokens[i++]) * 512 + phaseX;
      const y = Number(tokens[i++]) * 512 + phaseY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid biome background coordinate');
      if (command === 'M') { ring = []; rings.push(ring); }
      ring.push({ x, y });
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    if (rings.length) regions.push({ textureKey, rings });
  }
  if (!regions.length || maxX <= minX || maxY <= minY) throw new Error('No biome backgrounds');
  return { regions, originX: minX, originY: minY, width: maxX - minX, height: maxY - minY, phaseX, phaseY };
}

async function loadLayer() {
  const boundaries = (await import('../data/biome_boundries_py.json')).default;
  const geometry = biomeBackgroundGeometry(boundaries.biomes);
  const textures = new Map<string, ImageBitmap>();
  const outcomes = await Promise.allSettled([...new Set(geometry.regions.map(region => region.textureKey))].map(async path => {
    const response = await fetch(`./biome_bg/${path.split('/').pop()!}`);
    if (!response.ok) throw new Error(`Cannot load biome background ${path}: ${response.status}`);
    textures.set(path, await createImageBitmap(await response.blob()));
  }));
  const failed = outcomes.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    for (const bitmap of textures.values()) bitmap.close();
    throw failed.reason;
  }
  return { ...geometry, tiles: createBiomeBackgroundTiles({ ...geometry, textures }) };
}

let ready: ReturnType<typeof loadLayer> | undefined;
/** Decode the small original textures once and reuse them across seed changes. */
export function prepareBiomeBackgroundLayer() {
  return ready ??= loadLayer().catch(error => { ready = undefined; throw error; });
}

export function attachBiomeBackgroundLayer(
  viewer: any,
  layer: Awaited<ReturnType<typeof prepareBiomeBackgroundLayer>>,
  offsets: number[],
  isCurrent: () => boolean,
) {
  // Reserve a position below terrain queued after these asynchronous additions.
  const index = viewer.world.getItemCount();
  for (const offset of offsets) {
    if (!isCurrent()) return;
    const source = layer.tiles.createSource(offset);
    viewer.addTiledImage({
      tileSource: source, index,
      x: layer.originX + offset, y: layer.originY, width: layer.width,
      success: ({ item }: any) => {
        if (!isCurrent()) viewer.world.removeItem(item);
      },
      error: () => source.destroy(),
    });
  }
}
