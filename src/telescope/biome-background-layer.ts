import { biomeBackgroundRevisions } from 'virtual:noitamap-data-archives';
import { BIOME_BACKGROUND_MAP, STATIC_TERRAIN_BIOMES, CARVED_ROOM_BIOMES, WORLD_HEIGHT } from './terrain-policy';
import { immutableTelescopeAssets, revisionedAssetUrl } from './immutable-assets';
import { createBiomeBackgroundTiles, type BiomeBackgroundRegion } from './biome-background-tile-source';
import { installViewportLayerDrawing } from './instant-terrain-viewport';

const phaseX = -17920, phaseY = -7168;

/** Keep every SVG subpath in one clip, including oppositely wound holes. */
export function biomeBackgroundGeometry(biomes: { filename: string; svg_map_path: string }[]) {
  const regions: BiomeBackgroundRegion[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const biome of biomes) {
    const textureKey = BIOME_BACKGROUND_MAP[biome.filename];
    // Carved rooms supply the backdrop only inside their air, never over EDR.
    if (!textureKey || STATIC_TERRAIN_BIOMES.has(biome.filename) || CARVED_ROOM_BIOMES.has(biome.filename)) continue;
    const rings: BiomeBackgroundRegion['rings'] = [];
    let ring: BiomeBackgroundRegion['rings'][number] = [];
    const tokens = biome.svg_map_path.trim().split(/\s+/);
    for (let i = 0; i < tokens.length;) {
      const command = tokens[i++];
      if (command === 'Z') continue;
      if (command !== 'M' && command !== 'L') throw new Error('Invalid biome background boundary');
      const x = Number(tokens[i++]) * 512 + phaseX;
      const sourceY = Number(tokens[i++]) * 512 + phaseY;
      // The normal-world bake repeats its last biome-map row through hell.
      // Continue the orthogonal bottom edge as one contour (including holes),
      // avoiding a separate rectangle seam. Only the clip grows; artwork tiles
      // at native size with the same phase in both vertical worlds.
      const y = sourceY === phaseY + WORLD_HEIGHT ? sourceY + WORLD_HEIGHT : sourceY;
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

type BackgroundAttachment = {
  layer: Awaited<ReturnType<typeof prepareBiomeBackgroundLayer>>;
  source: any;
  item?: any;
  isCurrent: () => boolean;
  onAttach: (item: any) => void;
};
const attachedLayers = new WeakMap<object, Map<number, BackgroundAttachment>>();

function removeBackground(viewer: any, entry: BackgroundAttachment): void {
  try { if (entry.item) viewer.world.removeItem(entry.item); }
  catch { /* A closing viewer can already have detached its world. */ }
  finally { entry.source.destroy(); }
}

/** Hard navigation/baked handoff must also cancel attachments not in OSD yet. */
export function clearBiomeBackgroundLayers(viewer: any): void {
  const owner = viewer.viewer || viewer;
  const entries = attachedLayers.get(owner);
  attachedLayers.delete(owner);
  for (const entry of [...entries?.values() ?? []]) removeBackground(viewer, entry);
}

/** Share seed-independent sources, including pending OSD attachments. */
export function attachBiomeBackgroundLayer(
  viewer: any,
  layer: Awaited<ReturnType<typeof prepareBiomeBackgroundLayer>>,
  offsets: number[],
  isCurrent: () => boolean,
  onAttach: (item: any) => void,
  index = viewer.world.getItemCount(),
) {
  if (!isCurrent()) return;
  const owner = viewer.viewer || viewer;
  let entries = attachedLayers.get(owner);
  if (!entries) attachedLayers.set(owner, entries = new Map());
  for (const [offset, entry] of [...entries])
    if (entry.layer !== layer || !offsets.includes(offset)) removeBackground(viewer, entry);
  for (const offset of offsets) {
    if (!isCurrent()) return;
    const existing = entries.get(offset);
    if (existing) {
      existing.isCurrent = isCurrent;
      existing.onAttach = onAttach;
      if (existing.item) onAttach(existing.item);
      continue;
    }
    const source = layer.tiles.createSource(offset);
    const entry: BackgroundAttachment = { layer, source, isCurrent, onAttach };
    entries.set(offset, entry);
    const originalDestroy = source.destroy;
    let destroyed = false;
    source.destroy = () => {
      if (destroyed) return;
      destroyed = true;
      if (entries.get(offset) === entry) entries.delete(offset);
      originalDestroy.call(source);
    };
    // Background artwork is ready independently of shader compilation. Draw
    // the whole visible area now instead of loading OSD tiles until terrain starts.
    installViewportLayerDrawing(viewer, source);
    try {
      viewer.addTiledImage({
        tileSource: source, index,
        x: layer.originX + offset, y: layer.originY, width: layer.width,
        success: ({ item }: any) => {
          entry.item = item;
          if (destroyed || !entry.isCurrent()) {
            removeBackground(viewer, entry); return;
          }
          entry.onAttach(item);
        },
        error: () => source.destroy(),
      });
    } catch (error) { source.destroy(); throw error; }
  }
}
