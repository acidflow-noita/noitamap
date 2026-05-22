/**
 * Biome slugs that make up the standard "main path" through Noita —
 * Mines → Coal Pits → Fungal Caverns → Snowy Depths → Hiisi Base →
 * Underground Jungle → The Vault → Temple of the Art → The Laboratory,
 * plus every Holy Mountain rest-area variant in between.
 *
 * Shared between the seed-report sidebar (filter toggle) and the
 * biome-boundaries overlay console command, so both stay in lockstep.
 */
export const MAIN_PATH_BIOMES = new Set<string>([
  "coalmine",
  "coalmine_alt",
  "fungicave",
  "snowcave",
  "snowcastle",
  "rainforest",
  "rainforest_open",
  "vault",
  "crypt",
  "boss_arena",
  // Holy Mountains
  "temple_wall",
  "temple_wall_ending",
  "temple_altar",
  "temple_altar_left",
  "temple_altar_right",
  "temple_altar_right_snowcave",
  "temple_altar_right_snowcastle",
  "temple_altar_secret",
  "temple_altar_empty",
  "temple_altar_left_empty",
  "temple_altar_right_empty",
  "temple_altar_right_snowcave_empty",
  "temple_altar_right_snowcastle_empty",
]);

/** Strip a biome reference down to its bare slug (no biome_/$biome_ prefix). */
export function biomeSlug(name: string | undefined | null): string {
  if (!name) return "";
  return name.replace(/^\$?biome_/, "");
}

/** True when the biome slug/key belongs to the main path. */
export function isMainPathBiome(name: string | undefined | null): boolean {
  return MAIN_PATH_BIOMES.has(biomeSlug(name));
}
