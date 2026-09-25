/** OSD excludes already-loaded fine tiles when zooming out past minPixelRatio.
 * Reuse their real pixels, including revisited cached areas, until useful
 * replacements arrive. Loading and coverage selection still belong to OSD. */

type Bounds = { x: number; y: number; width: number; height: number };
type State = { remembered: Set<any>; extras: Set<any> };

// At minPixelRatio=.5, a 256px tile can occupy only 128 screen pixels. Two
// overlapping FHD layers can already need ~270 tiles in the preceding frame.
const DEFAULT_REFERENCE_LIMIT = 512;

class ReferenceBudget {
  private entries = new Map<any, State>();
  constructor(private limit: number) {}

  forget(state: State): void {
    for (const tile of state.remembered) this.entries.delete(tile);
    state.remembered.clear();
  }

  remember(state: State, infos: any[]): void {
    this.forget(state);
    // Prioritize the finer, central part of the preceding view if its drawn
    // tile count is larger than the shared budget. No pixel buffers are copied.
    const ordered = [...infos].sort((a, b) => b.level - a.level
      || a.tile.squaredDistance - b.tile.squaredDistance).slice(0, this.limit);
    for (const { tile } of ordered) {
      this.entries.set(tile, state);
      state.remembered.add(tile);
    }
    while (this.entries.size > this.limit) {
      const [tile, owner] = this.entries.entries().next().value!;
      this.entries.delete(tile);
      owner.remembered.delete(tile);
      if (owner.extras.delete(tile)) tile.beingDrawn = false;
    }
  }
}

function intersection(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Coverage must include the whole visible footprint; one intersecting new
 * tile cannot replace the still-visible part of an old tile beside it. */
function covered(bounds: Bounds, replacements: any[]): boolean {
  let remaining = [bounds];
  for (const { tile } of replacements) {
    const next: Bounds[] = [];
    for (const part of remaining) {
      const overlap = intersection(part, tile.bounds);
      if (!overlap) { next.push(part); continue; }
      const right = part.x + part.width, bottom = part.y + part.height;
      if (overlap.x > part.x) next.push({ ...part, width: overlap.x - part.x });
      if (overlap.x + overlap.width < right) next.push({ ...part,
        x: overlap.x + overlap.width, width: right - overlap.x - overlap.width });
      if (overlap.y > part.y) next.push({ x: overlap.x, y: part.y,
        width: overlap.width, height: overlap.y - part.y });
      if (overlap.y + overlap.height < bottom) next.push({ x: overlap.x,
        y: overlap.y + overlap.height, width: overlap.width,
        height: bottom - overlap.y - overlap.height });
    }
    remaining = next;
    if (!remaining.length) return true;
    // Irregular custom sources must not create unbounded rectangle work. This
    // conservative limit keeps the prior tile until a later frame covers it.
    if (remaining.length > 64) return false;
  }
  return false;
}

function renderRatio(item: any, level: number): number {
  return item.viewport.deltaPixelsFromPointsNoRotate(item.source.getPixelRatio(level), true).x
    * item._scaleSpring.current.value;
}

function usefulLevel(item: any): number {
  let best = item.source.minLevel || 0, error = Infinity;
  let lastRatio = item.source.getPixelRatio(item.source.maxLevel).x;
  for (let level = item.source.maxLevel; level >= (item.source.minLevel || 0); level--) {
    const sourceRatio = item.source.getPixelRatio(level).x;
    if (item.discardLevelsBelowDownsampleRatio > 1
      && sourceRatio / lastRatio < item.discardLevelsBelowDownsampleRatio
      && level !== item.source.maxLevel) continue;
    lastRatio = sourceRatio;
    const ratio = renderRatio(item, level);
    if (ratio < item.minPixelRatio && level !== item.source.minLevel) continue;
    const difference = Math.abs(1 - ratio);
    if (difference < error) { best = level; error = difference; }
  }
  return best;
}

function protect(item: any, budget: ReferenceBudget): () => void {
  if (typeof item.getTilesToDraw !== 'function' || typeof item._positionTile !== 'function')
    return () => {};
  const original = item.getTilesToDraw;
  const state: State = { remembered: new Set(), extras: new Set() };

  const getTilesToDraw = function(this: any): any[] {
    for (const tile of state.extras) tile.beingDrawn = false;
    state.extras.clear();
    // Let normal OSD loading run without the retained tiles affecting coverage
    // or blocking the requests that will replace them.
    const drawn: any[] = original.call(this);
    const drawArea = this.getDrawArea();
    if (!drawArea || this.opacity === 0) { budget.forget(state); return drawn; }
    const area = drawArea.getBoundingBox();
    const normal = new Set(drawn.map(info => info.tile));
    const level = usefulLevel(this);
    const replacements = drawn.filter(info => info.level >= level && info.tile.opacity === 1);
    if (covered(area, replacements)) {
      budget.remember(state, drawn);
      return drawn;
    }
    // The last drawn view alone loses warm pixels after a pan away and back.
    // Rediscover only OSD-owned, already-loaded tiles for this exact image;
    // never traverse the source's unloaded tile matrix or start a request.
    const candidates = new Set(state.remembered);
    const cached = this._tileCache?.getLoadedTilesFor?.(this) ?? [];
    for (const tile of cached) candidates.add(tile);
    const retained: any[] = [];
    let center: any;
    for (const tile of candidates) {
      if (normal.has(tile) || !tile.loaded || tile.processing
        || (tile.opacity !== 1 && this.blendTime !== 0)
        || renderRatio(this, tile.level) >= this.minPixelRatio) continue;
      const visible = intersection(tile.bounds, area);
      if (!visible || covered(visible, replacements)) continue;
      center ??= this.viewport.pixelFromPoint(this.viewport.getCenter());
      this._positionTile(tile, this.source.tileOverlap, this.viewport, center, tile.visibility);
      retained.push({ tile, level: tile.level, levelOpacity: 1, currentTime: Date.now() });
    }
    // Select references before drawing so rediscovery cannot append an
    // unbounded number of cached tiles to a single image's draw list.
    budget.remember(state, [...drawn, ...retained]);
    for (const info of retained) {
      const tile = info.tile;
      if (!state.remembered.has(tile)) continue;
      tile.opacity = 1;
      tile.beingDrawn = true;
      state.extras.add(tile);
      // OSD returns its _lastDrawn array. Adding here also gives the normal
      // next-frame cache protection/reset lifecycle to these real tile objects.
      drawn.push(info);
    }
    if (state.extras.size) drawn.sort((a, b) => a.level - b.level);
    return drawn;
  };
  item.getTilesToDraw = getTilesToDraw;
  return () => {
    if (item.getTilesToDraw === getTilesToDraw) item.getTilesToDraw = original;
    for (const tile of state.extras) tile.beingDrawn = false;
    state.extras.clear();
    budget.forget(state);
  };
}

/** Standalone entry point for an image or a native OSD integration fixture. */
export function protectTileContinuity(item: any, options: { maxTiles?: number } = {}): () => void {
  return protect(item, new ReferenceBudget(Math.max(0, options.maxTiles ?? DEFAULT_REFERENCE_LIMIT)));
}

/** Share a bounded reference budget across static DZI and generated map layers.
 * OSD owns every tile/cache canvas; removing images releases all extra refs. */
export function installTileContinuity(viewer: any, options: { maxTiles?: number } = {}): () => void {
  const budget = new ReferenceBudget(Math.max(0, options.maxTiles ?? DEFAULT_REFERENCE_LIMIT));
  const images = new Map<any, () => void>();
  const add = ({ item }: any) => {
    if (!images.has(item)) images.set(item, protect(item, budget));
  };
  const remove = ({ item }: any) => { images.get(item)?.(); images.delete(item); };
  for (let i = 0; i < viewer.world.getItemCount(); i++) add({ item: viewer.world.getItemAt(i) });
  viewer.world.addHandler('add-item', add);
  viewer.world.addHandler('remove-item', remove);
  const dispose = () => {
    viewer.world.removeHandler('add-item', add);
    viewer.world.removeHandler('remove-item', remove);
    viewer.removeHandler('before-destroy', dispose);
    for (const release of images.values()) release();
    images.clear();
  };
  viewer.addHandler('before-destroy', dispose);
  return dispose;
}
