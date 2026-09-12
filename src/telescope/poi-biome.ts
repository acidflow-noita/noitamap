/** Fixed authored room identities outrank legacy broad-area metadata.
 * Old generation.json/cache snapshots labelled this sky room "desert".
 * Use its explicit chest variant, never proximity or the display language. */
export function poiBiome(poi: {
  type: string;
  biome?: string;
  chestVariant?: unknown;
}): string | undefined {
  return poi.type === "chest" && poi.chestVariant === "coral"
    ? "song_room"
    : poi.biome;
}
