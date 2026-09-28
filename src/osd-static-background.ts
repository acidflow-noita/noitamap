import { getMapMemoryBudget } from './map-memory-budget';

declare const OpenSeadragon: any;

type Entry = { item: any; tile: any; bytes: number };

/** Keep a small, complete image behind the camera-dependent DZI detail. OSD's
 * immediateRender can finish a close view without ever loading its overview,
 * and its cache eviction uses the incoming image's cutoff, not the old one's. */
export function installStaticBackgroundResidency(viewer: any, options: { maxBytes?: number } = {}): () => void {
  const cache = viewer.tileCache;
  if (!cache || typeof cache._freeOldRecordRoutine !== 'function') return () => {};
  const maxBytes = Math.max(0, options.maxBytes ?? getMapMemoryBudget().staticBackgroundBytes);
  const images = new Map<any, Entry[]>(), pinned = new Set<any>(), active = new Set<any>();
  let queue: Entry[] = [], bytes = 0, disposed = false, scheduled = false;
  const originalFree = cache._freeOldRecordRoutine;
  const protectedFree = function(this: any, ...args: any[]) {
    // Protect only these bounded overview pixels, even while a different
    // source (including a level-zero overlay) adds data between draw passes.
    const flags = [...pinned].map(tile => [tile, tile.beingDrawn] as const);
    for (const [tile] of flags) tile.beingDrawn = true;
    try { return originalFree.apply(this, args); }
    finally { for (const [tile, drawn] of flags) tile.beingDrawn = drawn; }
  };
  cache._freeOldRecordRoutine = protectedFree;

  function pump(): void {
    scheduled = false;
    if (disposed) return;
    while (active.size < 2 && queue.length) {
      const entry = queue.shift()!, { item, tile } = entry;
      if (!images.has(item) || tile.loaded || tile.loading || !tile.exists) continue;
      // OSD clears its waiting download queue during camera updates without a
      // tile completion event. Keep our work here until it can start directly.
      if (item._imageLoader.canAcceptNewJob?.() === false) {
        queue.unshift(entry);
        break;
      }
      active.add(tile);
      try { item._loadTile(tile, OpenSeadragon.now()); }
      catch (error) {
        active.delete(tile);
        tile.loading = false;
        console.warn('[Static background] Overview tile could not start:', error);
      }
    }
  }
  function schedule(): void {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(pump);
  }
  function settled({ tile }: any): void {
    active.delete(tile);
    if (queue.length) schedule();
  }
  function add({ item }: any): void {
    // AppOSD's later add-item handler applies the current asset version and
    // identifies static base sources before any tile URL is materialized.
    queueMicrotask(() => {
      if (disposed || !item.source?.__staticBackground || images.has(item)
        || viewer.world.getIndexOfItem(item) < 0) return;
      const source = item.source, entries: Entry[] = [];
      images.set(item, entries);
      const cutoff = source.getClosestLevel();
      // The single-tile level guarantees coverage first. Two levels above it
      // improve the resident overview without retaining a multi-gigabyte map.
      for (const level of new Set([cutoff, Math.min(cutoff + 2, source.maxLevel)])) {
        const count = source.getNumTiles(level), candidates: Entry[] = [];
        let levelBytes = 0;
        for (let x = 0; x < count.x; x++) for (let y = 0; y < count.y; y++) {
          const bounds = source.getTileBounds(level, x, y, true);
          const size = Math.ceil(bounds.width) * Math.ceil(bounds.height) * 4;
          levelBytes += size;
          candidates.push({ item, tile: item._getTile(x, y, level, OpenSeadragon.now(), count), bytes: size });
        }
        if (bytes + levelBytes > maxBytes) continue;
        bytes += levelBytes;
        for (const entry of candidates) {
          entries.push(entry); pinned.add(entry.tile); queue.push(entry);
        }
      }
      // All three worlds' tiny whole-image tiles precede larger overviews.
      queue.sort((a, b) => a.tile.level - b.tile.level);
      schedule();
    });
  }
  function remove({ item }: any): void {
    const entries = images.get(item);
    if (!entries) return;
    for (const entry of entries) {
      bytes -= entry.bytes; pinned.delete(entry.tile); active.delete(entry.tile);
    }
    images.delete(item);
    queue = queue.filter(entry => entry.item !== item);
    schedule();
  }
  const stats = {
    get images() { return images.size; }, get tiles() { return pinned.size; },
    get readyTiles() { return [...pinned].filter(tile => tile.loaded).length; },
    get reservedBytes() { return bytes; },
    get decodedBytes() { return [...images.values()].flat().reduce((sum, entry) => sum + (entry.tile.loaded ? entry.bytes : 0), 0); },
    get pending() { return queue.length + active.size; },
  };
  viewer.staticBackgroundResidency = stats;
  viewer.world.addHandler('add-item', add);
  viewer.world.addHandler('remove-item', remove);
  viewer.addHandler('tile-loaded', settled);
  viewer.addHandler('tile-load-failed', settled);
  viewer.addHandler('update-viewport', schedule);
  viewer.addHandler('before-destroy', dispose);
  for (let i = 0; i < viewer.world.getItemCount(); i++) add({ item: viewer.world.getItemAt(i) });
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    viewer.world.removeHandler('add-item', add);
    viewer.world.removeHandler('remove-item', remove);
    viewer.removeHandler('tile-loaded', settled);
    viewer.removeHandler('tile-load-failed', settled);
    viewer.removeHandler('update-viewport', schedule);
    viewer.removeHandler('before-destroy', dispose);
    if (cache._freeOldRecordRoutine === protectedFree) cache._freeOldRecordRoutine = originalFree;
    if (viewer.staticBackgroundResidency === stats) delete viewer.staticBackgroundResidency;
    images.clear(); pinned.clear(); active.clear(); queue = []; bytes = 0;
  }
  return dispose;
}
