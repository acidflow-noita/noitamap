import { BIOME_SPAWN_FUNCTION_MAP } from 'noita-telescope-full-pixels/spawn_function_config.js';
import { sceneBiomeNames } from './terrain-policy';

// The fork omits these six biome scripts from its spawn table. These are the
// RegisterSpawnFunction colors shared by data/scripts/biomes/friend_[1-6].lua.
const FRIEND_SCENE_SPAWN_COLORS = [0xffeedd, 0x31d0b0, 0x9dd0b0, 0x9dd0c0, 0x9dd0d0, 0x80ff5a] as const;
const byBiomes = new Map<string, Set<number>>();

/** A shared general/ scene can carry spawn instructions registered only by
 * its placed biome. Upstream's record-wide prescan does not know that biome.
 * Remove those instructions before material substitutions, without mutating
 * raw pixels shared with another placement or changing unknown artwork colors. */
export function clearSceneSpawnPixels(
  scene: { key: string; variantKey?: string },
  source: { data: Uint8Array | Uint8ClampedArray; biome?: string },
): Uint8Array | Uint8ClampedArray {
  const biomes = [...new Set([...sceneBiomeNames(scene), ...(source.biome ? [source.biome] : [])])];
  const key = biomes.join('/');
  let colors = byBiomes.get(key);
  if (!colors) {
    colors = new Set<number>();
    for (const biome of biomes) {
      for (const spawn of (BIOME_SPAWN_FUNCTION_MAP as Record<string, { color: number }[]>)[biome] ?? [])
        colors.add(spawn.color & 0xffffff);
      if (/^friend_[1-6]$/.test(biome)) for (const color of FRIEND_SCENE_SPAWN_COLORS) colors.add(color);
    }
    byBiomes.set(key, colors);
  }
  let output = source.data;
  for (let i = 0; i < source.data.length; i += 4) {
    if (!source.data[i + 3]) continue;
    const rgb = (source.data[i] << 16) | (source.data[i + 1] << 8) | source.data[i + 2];
    if (!colors.has(rgb)) continue;
    if (output === source.data) output = source.data.slice();
    output.fill(0, i, i + 4);
  }
  return output;
}
