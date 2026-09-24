import metadata from '../data/biome-names.json';
import i18next from '../i18n';
import { biomeSlug, MAIN_PATH_BIOMES } from './main-path-biomes';

export interface BiomeDescription {
  displayName: string;
  internalName: string;
  mainPath: boolean;
}

// Compact projection of biome_boundries_py.json: [filename, XML name, RGB].
// The boundary-name tests guard it against both original and styled metadata.
const names = new Map(metadata.map(([filename, name]) => [String(filename), String(name)]));
const colors = new Map(metadata.map(([filename, , color]) => [Number(color), String(filename)]));

/** Use the boundary overlay's authored XML name, never infer a name from a
 * room filename. A blank name is meaningful: Noita leaves that room unnamed. */
export function describeBiome(internalName: string, boundaryName?: string): BiomeDescription {
  const raw = biomeSlug(internalName);
  const authored = boundaryName ?? names.get(raw);
  const name = authored === '_EMPTY_' ? '' : authored;
  const canonical = biomeSlug(name ?? raw);
  const key = canonical && canonical !== '_EMPTY_' ? `gameContent.biomes.biome_${canonical}` : '';
  const translated = key ? i18next.t(key, { defaultValue: null }) : null;
  return {
    displayName: String(translated || (name ? name : i18next.t('noInGameName', { defaultValue: 'No in-game name' }))),
    internalName: raw,
    mainPath: MAIN_PATH_BIOMES.has(raw) || MAIN_PATH_BIOMES.has(canonical) || canonical === 'holymountain',
  };
}

interface BiomeGeneration {
  worldSize: number;
  worldCenter: number;
  biomeData: {
    pixels: ArrayLike<number>;
    heavenPixels?: ArrayLike<number>;
    hellPixels?: ArrayLike<number>;
    w?: number;
    h?: number;
  };
}

/** Resolve the actual boundary cell of the loaded seed. Global coordinates
 * already include parallel-world offsets; wrap once, never add poi.pw again.
 * This uses boundary cells rather than the terrain renderer's noisy edges. */
export function getPOIBiomeDescription(
  poi: { worldX?: number; worldY?: number; biome?: string; [key: string]: unknown },
  generation?: BiomeGeneration | null,
): BiomeDescription | null {
  const data = generation?.biomeData;
  const width = data?.w ?? generation?.worldSize ?? 0;
  const height = data?.h ?? (data && width > 0 ? data.pixels.length / width : 0);
  if (data && Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    && Number.isFinite(generation?.worldCenter) && Number.isFinite(poi.worldX) && Number.isFinite(poi.worldY)) {
    const wrap = (value: number, size: number) => ((value % size) + size) % size;
    const x = wrap(Math.floor(poi.worldX! / 512 + generation!.worldCenter), width);
    let y = Math.floor(poi.worldY! / 512 + 14);
    let pixels = data.pixels;
    if (y < 0 && data.heavenPixels) { pixels = data.heavenPixels; y = wrap(y, height); }
    else if (y >= height && data.hellPixels) { pixels = data.hellPixels; y = wrap(y, height); }
    else y = Math.max(0, Math.min(height - 1, y));
    const color = pixels[y * width + x];
    const internalName = typeof color === 'number' ? colors.get(color & 0xffffff) : undefined;
    if (internalName) return describeBiome(internalName);
  }
  const raw = biomeSlug(poi.biome);
  return raw && raw.toLowerCase() !== 'unknown' ? describeBiome(raw) : null;
}
