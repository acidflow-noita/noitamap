/** Cold generated tiles wait here BEFORE OSD creates a timed ImageJob. Cached
 * tiles keep OSD's normal fast path. Camera changes can discard unstarted work
 * without turning cancellation into a permanently failed/missing map tile. */
export interface TerrainTileAdmission {
  started: Promise<void>;
  finished: Promise<void>;
  retain(keep: () => boolean): () => void;
  cancel(): void;
}
interface Entry {
  item: any;
  tile: any;
  time: number;
  original: (...args: any[]) => unknown;
  ticket: TerrainTileAdmission;
  interests: Set<() => boolean>;
  phase: "queued" | "active" | "finished";
  start: () => void;
  finish: () => void;
  rejectStart: (reason: unknown) => void;
  rejectFinish: (reason: unknown) => void;
}
const tickets = new WeakMap<object, TerrainTileAdmission>();
const installed = new WeakMap<object, () => void>();
const MAX_COLD_LOADS = 2;

export function getTerrainTileAdmission(
  tile: object,
): TerrainTileAdmission | undefined {
  return tickets.get(tile);
}

function intersects(a: any, b: any): boolean {
  return (
    !!a &&
    !!b &&
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
function viewOf(item: any) {
  return {
    current: item.getDrawArea?.()?.getBoundingBox?.(),
    target: item.getLoadArea?.()?.getBoundingBox?.(),
    scale: item.getBounds(true).width,
  };
}
function ratios(entry: Entry, view: ReturnType<typeof viewOf>) {
  const pixel = entry.item.source.getPixelRatio(entry.tile.level);
  return {
    current:
      entry.item.viewport.deltaPixelsFromPointsNoRotate(pixel, true).x *
      view.scale,
    target:
      entry.item.viewport.deltaPixelsFromPointsNoRotate(pixel, false).x *
      view.scale,
  };
}
function retained(entry: Entry): boolean {
  for (const keep of entry.interests) {
    try {
      if (keep()) return true;
    } catch {
      /* Removed generation/view. */
    }
  }
  return false;
}
function wanted(entry: Entry, view: ReturnType<typeof viewOf>): boolean {
  if (!entry.tile.exists) return false;
  if (retained(entry)) return true;
  const source = entry.item.source;
  const base =
    source.getClosestLevel() + (source.instantCoverageExtraLevels ?? 2);
  const ratio = ratios(entry, view),
    minimum = entry.item.minPixelRatio ?? 0.5;
  const accepts = (value: number) => value >= minimum && value <= 2;
  return (
    (intersects(entry.tile.bounds, view.current) &&
      (entry.tile.level <= base || accepts(ratio.current))) ||
    (intersects(entry.tile.bounds, view.target) &&
      (entry.tile.level <= base || accepts(ratio.target)))
  );
}
function priority(entry: Entry, view: ReturnType<typeof viewOf>): number {
  const target = intersects(entry.tile.bounds, view.target);
  const current = intersects(entry.tile.bounds, view.current);
  const area = view.target ?? view.current;
  const ratio = ratios(entry, view);
  const distance = area
    ? Math.hypot(
        entry.tile.bounds.x +
          entry.tile.bounds.width / 2 -
          area.x -
          area.width / 2,
        entry.tile.bounds.y +
          entry.tile.bounds.height / 2 -
          area.y -
          area.height / 2,
      )
    : 0;
  // Match OSD's closest absolute physical-pixel ratio, including 0.69 vs 1.38.
  return (
    (target ? 0 : current ? 1e6 : 2e6) +
    Math.min(1e3, Math.abs(1 - ratio.target)) * 1000 +
    distance
  );
}

export function installTerrainAdmission(viewer: any): () => void {
  const existing = installed.get(viewer);
  if (existing) return existing;
  const images = new Map<any, { original: any; wrapped: any }>();
  const entries = new Map<any, Entry>();
  let active = 0,
    timer: ReturnType<typeof setTimeout> | undefined,
    disposed = false;
  const stats = {
    maxColdLoads: MAX_COLD_LOADS,
    started: 0,
    cached: 0,
    discarded: 0,
  };
  Object.defineProperties(stats, {
    active: { enumerable: true, get: () => active },
    queued: { enumerable: true, get: () => entries.size - active },
  });
  viewer.terrainAdmissionStats = stats;
  const aborted = () =>
    new DOMException("Obsolete unstarted terrain tile", "AbortError");
  function settle(entry: Entry, error?: unknown) {
    if (entry.phase === "finished") return;
    const queued = entry.phase === "queued";
    if (queued) {
      entry.tile.loading = false;
      stats.discarded++;
    } else active--;
    entry.phase = "finished";
    entries.delete(entry.tile);
    tickets.delete(entry.tile);
    if (error) {
      if (queued) entry.rejectStart(error);
      entry.rejectFinish(error);
    } else {
      entry.start();
      entry.finish();
    }
    entry.interests.clear();
    schedule();
  }
  function schedule() {
    if (disposed || timer || !entries.size) return;
    timer = setTimeout(pump, 0);
  }
  function pump() {
    timer = undefined;
    if (disposed) return;
    const views = new Map<any, ReturnType<typeof viewOf>>();
    const candidates: { entry: Entry; priority: number }[] = [];
    for (const entry of entries.values()) {
      if (entry.phase !== "queued") continue;
      let view = views.get(entry.item);
      if (!view) {
        view = viewOf(entry.item);
        views.set(entry.item, view);
      }
      if (!images.has(entry.item) || !wanted(entry, view)) {
        settle(entry, aborted());
        continue;
      }
      candidates.push({ entry, priority: priority(entry, view) });
    }
    candidates.sort((a, b) => a.priority - b.priority);
    for (const { entry } of candidates) {
      if (active >= MAX_COLD_LOADS) break;
      if (entry.phase !== "queued") continue;
      entry.phase = "active";
      active++;
      stats.started++;
      entry.start();
      try {
        entry.original.call(entry.item, entry.tile, entry.time);
      } catch (error) {
        settle(entry, error);
      }
    }
  }
  const loaded = (event: any) => {
    const entry = entries.get(event.tile);
    if (!entry || entry.phase !== "active") return;
    // OSD awaits handlers before resolving event.promise: do not return it.
    void Promise.resolve(event.promise).then(
      () => settle(entry),
      (error) => settle(entry, error),
    );
  };
  const failed = (event: any) => {
    const entry = entries.get(event.tile);
    if (entry)
      settle(entry, new Error(event.message || "Generated tile load failed"));
  };
  const add = ({ item }: any) => {
    if (
      images.has(item) ||
      !(item.source?.__instantTerrain || item.source?.__instantCoverage) ||
      typeof item._loadTile !== "function"
    )
      return;
    const original = item._loadTile;
    const wrapped = function (
      this: any,
      tile: any,
      time: number,
    ): TerrainTileAdmission | undefined {
      const existing = entries.get(tile);
      if (existing) return existing.ticket;
      if (tile.loaded || disposed) return undefined;
      if (this.source.hasCachedTile?.(tile)) {
        stats.cached++;
        original.call(this, tile, time);
        return undefined;
      }
      let start!: () => void, finish!: () => void;
      let rejectStart!: (error: unknown) => void,
        rejectFinish!: (error: unknown) => void;
      const started = new Promise<void>((resolve, reject) => {
        start = resolve;
        rejectStart = reject;
      });
      const finished = new Promise<void>((resolve, reject) => {
        finish = resolve;
        rejectFinish = reject;
      });
      // Native OSD ignores _loadTile's result; observers opt in via the ticket.
      void started.catch(() => {});
      void finished.catch(() => {});
      const interests = new Set<() => boolean>();
      const ticket: TerrainTileAdmission = {
        started,
        finished,
        retain(keep) {
          interests.add(keep);
          return () => {
            interests.delete(keep);
            schedule();
          };
        },
        cancel() {
          const entry = entries.get(tile);
          if (entry?.phase === "queued") settle(entry, aborted());
        },
      };
      const entry: Entry = {
        item: this,
        tile,
        time,
        original,
        ticket,
        interests,
        phase: "queued",
        start,
        finish,
        rejectStart,
        rejectFinish,
      };
      tile.loading = true;
      tile.tiledImage = this;
      entries.set(tile, entry);
      tickets.set(tile, ticket);
      schedule();
      return ticket;
    };
    item._loadTile = wrapped;
    images.set(item, { original, wrapped });
    Object.defineProperty(item.source, "terrainAdmissionStats", {
      configurable: true,
      get: () => stats,
    });
  };
  const remove = ({ item }: any) => {
    const image = images.get(item);
    if (!image) return;
    if (item._loadTile === image.wrapped) item._loadTile = image.original;
    images.delete(item);
    for (const entry of entries.values())
      if (entry.item === item) settle(entry, aborted());
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    timer = undefined;
    for (const item of [...images.keys()]) remove({ item });
    viewer.world.removeHandler("add-item", add);
    viewer.world.removeHandler("remove-item", remove);
    viewer.removeHandler("tile-loaded", loaded);
    viewer.removeHandler("tile-load-failed", failed);
    for (const name of [
      "pan",
      "zoom",
      "resize",
      "animation",
      "animation-finish",
    ])
      viewer.removeHandler(name, schedule);
    viewer.removeHandler("before-destroy", dispose);
    installed.delete(viewer);
  };
  viewer.world.addHandler("add-item", add);
  viewer.world.addHandler("remove-item", remove);
  viewer.addHandler("tile-loaded", loaded);
  viewer.addHandler("tile-load-failed", failed);
  for (const name of ["pan", "zoom", "resize", "animation", "animation-finish"])
    viewer.addHandler(name, schedule);
  viewer.addHandler("before-destroy", dispose);
  installed.set(viewer, dispose);
  for (let i = 0; i < viewer.world.getItemCount(); i++)
    add({ item: viewer.world.getItemAt(i) });
  return dispose;
}
