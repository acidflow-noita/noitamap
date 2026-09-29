const MiB = 1024 * 1024;

/** These are decoded working-set limits, not persistent storage limits. Native
 * terrain cooking remains one game pixel per pixel on every device. */
export interface MapMemoryBudget {
  readonly profile: 'compact' | 'desktop';
  readonly viewportMaxPixels: number;
  readonly viewportMaxDimension: number;
  readonly retainedFramePixels: number;
  readonly terrainCacheBytes: number;
  readonly retainedTerrainBytes: number;
  readonly maskCacheBytes: number;
  readonly sceneCacheBytes: number;
  readonly biomeBackgroundCacheBytes: number;
  readonly staticBackgroundBytes: number;
  readonly osdCacheTiles: number;
  readonly imageLoaderLimit: number;
  readonly continuityTiles: number;
}

const desktop: MapMemoryBudget = Object.freeze({
  profile: 'desktop',
  viewportMaxPixels: 8 * MiB,
  viewportMaxDimension: 8192,
  retainedFramePixels: 8 * MiB,
  terrainCacheBytes: 32 * MiB,
  retainedTerrainBytes: 24 * MiB,
  maskCacheBytes: 32 * MiB,
  sceneCacheBytes: 16 * MiB,
  biomeBackgroundCacheBytes: 16 * MiB,
  staticBackgroundBytes: 24 * MiB,
  osdCacheTiles: 200,
  imageLoaderLimit: 0,
  continuityTiles: 512,
});

const compact: MapMemoryBudget = Object.freeze({
  profile: 'compact',
  viewportMaxPixels: 2 * MiB,
  viewportMaxDimension: 2048,
  retainedFramePixels: 2 * MiB,
  terrainCacheBytes: 8 * MiB,
  retainedTerrainBytes: 8 * MiB,
  maskCacheBytes: 8 * MiB,
  sceneCacheBytes: 4 * MiB,
  biomeBackgroundCacheBytes: 4 * MiB,
  // Retain complete static-world overviews even on phones. Detailed DZI
  // caches can shrink without turning the unloaded surroundings black.
  staticBackgroundBytes: 8 * MiB,
  osdCacheTiles: 64,
  imageLoaderLimit: 4,
  continuityTiles: 64,
});

/** Safari does not expose deviceMemory; its primary touch pointer still
 * selects the bounded mobile working set. A touch-capable mouse-driven
 * desktop does not become mobile merely because it has a touch screen. */
export function getMapMemoryBudget(): MapMemoryBudget {
  let coarsePointer = false;
  try { coarsePointer = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false; }
  catch { /* Browser policy may withhold this optional device hint. */ }
  const deviceMemory = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  return coarsePointer || (typeof deviceMemory === 'number'
    && Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= 4) ? compact : desktop;
}
