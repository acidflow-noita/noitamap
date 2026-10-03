import { biomeBackgroundRevisions } from 'virtual:noitamap-data-archives';
import { BIOME_BACKGROUND_MAP, STATIC_TERRAIN_BIOMES, FRIEND_ROOM_BIOMES } from './terrain-policy';
import { immutableTelescopeAssets, revisionedAssetUrl } from './immutable-assets';
import { createBiomeBackgroundTiles, type BiomeBackgroundRegion } from './biome-background-tile-source';

const phaseX = -17920, phaseY = -7168;

/** Keep every SVG subpath in one clip, including oppositely wound holes. */
export function biomeBackgroundGeometry(biomes: { filename: string; svg_map_path: string }[]) {
  const regions: BiomeBackgroundRegion[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const biome of biomes) {
    const textureKey = BIOME_BACKGROUND_MAP[biome.filename];
    // Friend scenes supply the backdrop only inside their carved air.
    if (!textureKey || STATIC_TERRAIN_BIOMES.has(biome.filename) || FRIEND_ROOM_BIOMES.has(biome.filename)) continue;
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
  const started = performance.now();
  const boundaries = (await import('../data/biome_boundries_py.json')).default;
  const geometry = biomeBackgroundGeometry(boundaries.biomes);
  const textures = new Map<string, ImageBitmap>();
  const outcomes = await Promise.allSettled([...new Set(geometry.regions.map(region => region.textureKey))].map(async path => {
    const filename = path.split('/').pop()!;
    const revision = biomeBackgroundRevisions[filename];
    if (!revision) throw new Error(`Missing biome background revision: ${filename}`);
    const response = await immutableTelescopeAssets.fetch(`biome-background/${filename}`, revision,
      () => fetch(revisionedAssetUrl(`./biome_bg/${filename}`, revision), { signal: AbortSignal.timeout(30_000) }));
    if (!response.ok) throw new Error(`Cannot load biome background ${filename}: ${response.status}`);
    textures.set(path, await createImageBitmap(await response.blob()));
  }));
  const failed = outcomes.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    for (const bitmap of textures.values()) bitmap.close();
    throw failed.reason;
  }
  const tiles = createBiomeBackgroundTiles({ ...geometry, textures });
  console.info(`[OSD Bridge] Native biome backgrounds ready in ${((performance.now() - started) / 1000).toFixed(2)} seconds`, {
    textures: textures.size,
    decodedBytes: [...textures.values()].reduce((total, bitmap) => total + bitmap.width * bitmap.height * 4, 0),
    pixelsPerWorldPixel: 1,
  });
  return { ...geometry, tiles };
}

let ready: ReturnType<typeof loadLayer> | undefined;
/** Original artwork and bounded rendered tiles are shared across seeds/PWs. */
export function prepareBiomeBackgroundLayer() {
  return ready ??= loadLayer().catch(error => { ready = undefined; throw error; });
}

export function attachBiomeBackgroundLayer(
  viewer: any,
  layer: Awaited<ReturnType<typeof prepareBiomeBackgroundLayer>>,
  offsets: number[],
  isCurrent: () => boolean,
  onAttach: (item: any) => void,
) {
  const index = viewer.world.getItemCount();
  for (const offset of offsets) {
    if (!isCurrent()) return;
    const source = layer.tiles.createSource(offset);
    viewer.addTiledImage({
      tileSource: source, index,
      x: layer.originX + offset, y: layer.originY, width: layer.width,
      success: ({ item }: any) => {
        if (!isCurrent()) { viewer.world.removeItem(item); return; }
        onAttach(item);
      },
      error: () => source.destroy(),
    });
  }
}
