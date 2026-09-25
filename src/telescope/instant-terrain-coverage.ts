import { WORLD_HEIGHT, WORLD_TOP } from "./terrain-policy";
import { getTerrainTileAdmission } from "../osd-terrain-admission";

declare const OpenSeadragon: any;

export const INSTANT_COVERAGE_EXTRA_LEVELS = 2;
const SETTLE_MS = 120;
const MAX_ADAPTIVE_TILES = 48;
const MAX_RESIDENT_TILES = 160;
const MAX_RESIDENT_BYTES = 40 * 1024 * 1024;
type Entry = { item: any; tile: any; base: boolean; ready: boolean };
type Region = {
  item: any;
  base: Entry[];
  rank: number;
  cutoff: number;
  baseEnd: number;
};
type Pending = {
  item: any;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};
type Area = { x: number; y: number; width: number; height: number };

function tileBytes(source: any, level: number, x: number, y: number): number {
  // Scene tiles keep a full canvas at the image edge; terrain crops its canvas.
  // Bounds alone would undercount resident scene pixels by up to four times.
  const allocated = source.instantCoverageTileBytes?.(level, x, y);
  if (Number.isSafeInteger(allocated) && allocated > 0) return allocated;
  const bounds = source.getTileBounds(level, x, y, true);
  return Math.ceil(bounds.width) * Math.ceil(bounds.height) * 4;
}

/** OSD's cache reads beingDrawn when selecting eviction candidates. Preserve
 * its actual frame flag separately: neither OSD nor continuity can unpin a
 * retained tile by writing false. Explicit unload/destruction still works.
 * This owns no pixels and never changes the global cache eviction cutoff. */
function createResidency() {
  const entries = new Map<
    any,
    { bytes: number; base: boolean; release: () => void }
  >();
  let bytes = 0;
  return {
    retain(entry: Entry) {
      if (entries.has(entry.tile)) return;
      const tile = entry.tile;
      const size = tileBytes(entry.item.source, tile.level, tile.x, tile.y);
      if (
        entries.size >= MAX_RESIDENT_TILES ||
        bytes + size > MAX_RESIDENT_BYTES
      )
        return;
      const descriptor = Object.getOwnPropertyDescriptor(tile, "beingDrawn");
      if (!descriptor?.configurable || !("value" in descriptor)) return;
      let drawn = descriptor.value;
      const get = () => drawn || tile.loaded;
      Object.defineProperty(tile, "beingDrawn", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get,
        set(value) {
          drawn = value;
        },
      });
      entries.set(tile, {
        bytes: size,
        base: entry.base,
        release() {
          if (Object.getOwnPropertyDescriptor(tile, "beingDrawn")?.get === get)
            Object.defineProperty(tile, "beingDrawn", {
              ...descriptor,
              value: drawn,
            });
        },
      });
      bytes += size;
    },
    release(tile: any) {
      const entry = entries.get(tile);
      if (!entry) return;
      entry.release();
      entries.delete(tile);
      bytes -= entry.bytes;
    },
    clear() {
      for (const entry of entries.values()) entry.release();
      entries.clear();
      bytes = 0;
    },
    get remainingBytes() {
      return MAX_RESIDENT_BYTES - bytes;
    },
    get remainingTiles() {
      return MAX_RESIDENT_TILES - entries.size;
    },
    get stats() {
      let residentBaseTiles = 0,
        residentAdaptiveTiles = 0,
        residentBytes = 0;
      for (const [tile, entry] of entries)
        if (tile.loaded) {
          if (entry.base) residentBaseTiles++;
          else residentAdaptiveTiles++;
          residentBytes += entry.bytes;
        }
      return {
        residentBaseTiles,
        residentAdaptiveTiles,
        residentBytes,
        maxResidentTiles: MAX_RESIDENT_TILES,
        maxResidentBytes: MAX_RESIDENT_BYTES,
      };
    },
  };
}

function intersects(a: Area, b: Area): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Reuse OSD's transforms, including translated parallel worlds. Rectangles
 * below use OSD's normalized image-width units, including the Y coordinate. */
function viewportArea(
  item: any,
  current: boolean,
  expansion = 1,
): Area | undefined {
  const bounds = item.viewport.getBounds?.(current)?.getBoundingBox();
  if (!bounds) return undefined;
  const expanded = new OpenSeadragon.Rect(
    bounds.x - (bounds.width * (expansion - 1)) / 2,
    bounds.y - (bounds.height * (expansion - 1)) / 2,
    bounds.width * expansion,
    bounds.height * expansion,
  );
  const pixels = item
    .viewportToImageRectangle(expanded, current)
    .getBoundingBox();
  const width = item.source.dimensions.x;
  return {
    x: pixels.x / width,
    y: pixels.y / width,
    width: pixels.width / width,
    height: pixels.height / width,
  };
}

function union(a: Area | undefined, b: Area | undefined): Area | undefined {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function visibleArea(item: any): Area | undefined {
  return (
    union(viewportArea(item, true), viewportArea(item, false)) ??
    union(item.getDrawArea?.() || undefined, item.getLoadArea?.() || undefined)
  );
}

function desiredLevel(item: any): number {
  const source = item.source;
  const scale = item.getBounds(true).width;
  let best = source.minLevel,
    distance = Infinity;
  let previousRatio = source.getPixelRatio(source.maxLevel).x;
  // Match TiledImage._updateLevelsForViewport: eligibility uses the current
  // scale, priority uses absolute distance of the destination ratio from 1.
  // Logarithmic rounding is wrong at e.g. 0.69 versus its parent at 1.38.
  // getPixelRatio already incorporates actual device pixel density.
  for (let level = source.maxLevel; level >= source.minLevel; level--) {
    const pixelRatio = source.getPixelRatio(level);
    if (
      item.discardLevelsBelowDownsampleRatio > 1 &&
      level !== source.maxLevel &&
      pixelRatio.x / previousRatio < item.discardLevelsBelowDownsampleRatio
    )
      continue;
    previousRatio = pixelRatio.x;
    const current =
      item.viewport.deltaPixelsFromPointsNoRotate(pixelRatio, true).x * scale;
    if (level !== source.minLevel && current < item.minPixelRatio) continue;
    const target =
      item.viewport.deltaPixelsFromPointsNoRotate(pixelRatio, false).x * scale;
    const next = Math.abs(1 - target);
    if (next < distance) {
      best = level;
      distance = next;
    }
  }
  return best;
}

function tileRange(item: any, level: number, area?: Area) {
  const source = item.source,
    height = source.dimensions.y / source.dimensions.x;
  const x0 = Math.max(0, area?.x ?? 0),
    y0 = Math.max(0, area?.y ?? 0);
  const x1 = Math.min(1, area ? area.x + area.width : 1);
  const y1 = Math.min(height, area ? area.y + area.height : height);
  if (x1 <= x0 || y1 <= y0) return undefined;
  const first = source.getTileAtPoint(level, new OpenSeadragon.Point(x0, y0));
  const last = source.getTileAtPoint(level, new OpenSeadragon.Point(x1, y1));
  return {
    first,
    last,
    count: (last.x - first.x + 1) * (last.y - first.y + 1),
  };
}

function tileCoordinates(
  item: any,
  level: number,
  area?: Area,
): { x: number; y: number }[] {
  const range = tileRange(item, level, area);
  if (!range) return [];
  const { first, last } = range;
  const result = [];
  for (let y = first.y; y <= last.y; y++)
    for (let x = first.x; x <= last.x; x++) result.push({ x, y });
  return result;
}

/** Warm three useful base levels, then the next zoom-out viewport. Only one
 * background OSD request is dispatched at once, leaving demand loads queue
 * capacity. Replacing a plan removes undispatched requests; active OSD jobs
 * complete normally and are never marked failed because the camera moved.
 * No additional image layers or retained canvases are created here. */
export function createInstantCoverage(viewer: any, signal: AbortSignal) {
  const regions = new Map<any, Region>();
  const queued = new Set<Entry>();
  const adaptive = new Map<any, Entry>();
  const pending = new Map<any, Pending>();
  const residency = createResidency();
  const stats = {
    regions: 0,
    prepared: 0,
    restored: 0,
    failed: 0,
    cacheHits: 0,
    adaptiveTiles: 0,
    obsolete: 0,
  };
  Object.defineProperty(stats, "residency", {
    enumerable: true,
    get: () => residency.stats,
  });
  let started = false,
    running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let viewportKey = "";
  const abortError = () =>
    new DOMException("Terrain coverage cancelled", "AbortError");
  const report = (error: any) => {
    if (signal.aborted || error?.name === "AbortError") return;
    stats.failed++;
    console.warn("[Instant terrain] Coverage unavailable:", error);
  };
  const loaded = (event: any) => {
    const job = pending.get(event.tile);
    if (!job) return;
    // OSD awaits handlers before resolving this promise. Awaiting/returning it
    // in this handler would deadlock the real image loader.
    void Promise.resolve(event.promise).then(job.resolve, job.reject);
  };
  const failed = (event: any) => {
    pending
      .get(event.tile)
      ?.reject(new Error(event.message || "Terrain coverage load failed"));
  };
  function load(entry: Entry): Promise<void> {
    if (signal.aborted || !regions.has(entry.item))
      return Promise.reject(abortError());
    queued.delete(entry);
    if (!entry.tile.exists) return Promise.resolve();
    if (entry.tile.loaded) {
      if (!entry.ready) {
        entry.ready = true;
        stats.prepared++;
        stats.cacheHits++;
      }
      return Promise.resolve();
    }
    const existing = pending.get(entry.tile);
    if (existing) return existing.promise;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let releaseInterest = () => {};
    const armTimeout = () => {
      if (!timeout && pending.get(entry.tile) === job)
        timeout = setTimeout(
          () => reject(new Error("Terrain coverage load timed out")),
          35000,
        );
    };
    const job = { item: entry.item, promise, resolve, reject };
    pending.set(entry.tile, job);
    void promise
      .then(() => {
        if (signal.aborted || !regions.has(entry.item)) return;
        if (entry.ready) stats.restored++;
        else {
          entry.ready = true;
          stats.prepared++;
        }
        entry.item.redraw();
        viewer.forceRedraw?.();
      })
      .finally(() => {
        clearTimeout(timeout);
        releaseInterest();
        if (pending.get(entry.tile) === job) pending.delete(entry.tile);
      })
      .catch(() => {});
    try {
      if (!entry.tile.loading) {
        if (entry.item._tryFindTileCacheRecord?.(entry.tile)) stats.cacheHits++;
        else entry.item._loadTile(entry.tile, OpenSeadragon.now());
      }
      const admission = getTerrainTileAdmission(entry.tile);
      if (admission) {
        releaseInterest = admission.retain(
          () =>
            !signal.aborted &&
            regions.has(entry.item) &&
            (entry.base || adaptive.get(entry.tile) === entry),
        );
        // No load clock runs while the request is merely queued metadata.
        void admission.started.then(armTimeout, reject);
        void admission.finished.catch(reject);
      } else armTimeout();
    } catch (error) {
      reject(error);
    }
    return promise;
  }
  function rank(entry: Entry, area: Area | undefined, desired: number): number {
    const region = regions.get(entry.item)!;
    const bounds = entry.tile.bounds;
    const visible = !!area && intersects(bounds, area);
    const distance = area
      ? Math.hypot(
          bounds.x + bounds.width / 2 - area.x - area.width / 2,
          bounds.y + bounds.height / 2 - area.y - area.height / 2,
        )
      : 0;
    return (
      (visible ? (entry.base ? 1e6 : 0) : entry.base ? 3e6 : 2e6) +
      Math.abs(desired - (entry.base ? 0 : 1) - entry.tile.level) * 10000 +
      distance * 100 +
      region.rank
    );
  }
  function schedule() {
    if (!started || signal.aborted || timer || running || !queued.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      const views = new Map(
        [...regions.values()].map(({ item }) => [
          item,
          { area: visibleArea(item), desired: desiredLevel(item) },
        ]),
      );
      let entry: Entry | undefined,
        best = Infinity;
      for (const candidate of queued) {
        const view = views.get(candidate.item)!;
        const priority = rank(candidate, view.area, view.desired);
        if (priority < best) {
          entry = candidate;
          best = priority;
        }
      }
      if (!entry) return;
      running = true;
      void load(entry)
        .catch(report)
        .finally(() => {
          running = false;
          schedule();
        });
    }, 0);
  }
  function makeEntry(
    region: Region,
    level: number,
    x: number,
    y: number,
    base: boolean,
  ): Entry {
    const tile = region.item._getTile(
      x,
      y,
      level,
      OpenSeadragon.now(),
      region.item.source.getNumTiles(level),
    );
    return { item: region.item, tile, base, ready: false };
  }
  function clearAdaptive() {
    for (const entry of adaptive.values()) {
      if (queued.delete(entry)) stats.obsolete++;
      if (getTerrainTileAdmission(entry.tile))
        pending.get(entry.tile)?.reject(abortError());
      residency.release(entry.tile);
    }
    adaptive.clear();
    stats.adaptiveTiles = 0;
  }
  function plan() {
    settleTimer = undefined;
    if (!started || signal.aborted) return;
    clearAdaptive();
    const plans = [...regions.values()].map((region) => ({
      region,
      level: Math.max(region.baseEnd, desiredLevel(region.item) - 1),
      area: union(
        viewportArea(region.item, true, 2),
        viewportArea(region.item, false, 2),
      ),
    }));
    // Count ranges before allocating entries. Both tile count and actual
    // decoded bytes matter: scene tiles are 512px, terrain tiles are 256px.
    let candidates: { region: Region; level: number; x: number; y: number }[];
    while (true) {
      const count = plans.reduce(
        (sum, { region, level, area }) =>
          sum +
          (area && level > region.baseEnd
            ? (tileRange(region.item, level, area)?.count ?? 0)
            : 0),
        0,
      );
      if (count <= Math.min(MAX_ADAPTIVE_TILES, residency.remainingTiles)) {
        candidates = plans.flatMap(({ region, level, area }) =>
          area && level > region.baseEnd
            ? tileCoordinates(region.item, level, area).map((point) => ({
                region,
                level,
                ...point,
              }))
            : [],
        );
        const bytes = candidates.reduce(
          (sum, { region, level, x, y }) =>
            sum + tileBytes(region.item.source, level, x, y),
          0,
        );
        if (bytes <= residency.remainingBytes) break;
      }
      for (const plan of plans)
        plan.level = Math.max(plan.region.baseEnd, plan.level - 1);
    }
    for (const candidate of candidates) {
      const entry = makeEntry(
        candidate.region,
        candidate.level,
        candidate.x,
        candidate.y,
        false,
      );
      if (!entry.tile.exists) continue;
      adaptive.set(entry.tile, entry);
      residency.retain(entry);
      if (!entry.tile.loaded && !pending.has(entry.tile)) queued.add(entry);
    }
    stats.adaptiveTiles = adaptive.size;
    for (const region of regions.values())
      for (const entry of region.base) {
        // Warm offscreen base tiles once. Restores only follow a changed viewport,
        // never an unload event, avoiding mixed-source eviction/recache loops.
        const area = visibleArea(entry.item);
        if (
          !entry.tile.loaded &&
          !pending.has(entry.tile) &&
          (!entry.ready || (area && intersects(entry.tile.bounds, area)))
        )
          queued.add(entry);
      }
    schedule();
  }
  function changed() {
    if (!started || signal.aborted) return;
    clearAdaptive();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(plan, SETTLE_MS);
    schedule();
  }
  const visible = () => {
    if (!started || signal.aborted) return;
    const key = [true, false]
      .map((current) => {
        const b = viewer.viewport.getBounds?.(current);
        return b ? `${b.x},${b.y},${b.width},${b.height},${b.degrees}` : "";
      })
      .join(";");
    if (key !== viewportKey) {
      viewportKey = key;
      changed();
    }
  };
  const removed = (event: any) => {
    const region = regions.get(event.item);
    if (!region) return;
    regions.delete(event.item);
    for (const entry of region.base) residency.release(entry.tile);
    for (const entry of [...queued])
      if (entry.item === event.item) queued.delete(entry);
    for (const [tile, entry] of adaptive)
      if (entry.item === event.item) {
        residency.release(tile);
        adaptive.delete(tile);
      }
    for (const job of pending.values())
      if (job.item === event.item) job.reject(abortError());
  };
  const stop = () => {
    clearTimeout(timer);
    clearTimeout(settleTimer);
    timer = settleTimer = undefined;
    queued.clear();
    regions.clear();
    adaptive.clear();
    residency.clear();
    for (const job of pending.values()) job.reject(abortError());
    viewer.removeHandler("tile-loaded", loaded);
    viewer.removeHandler("tile-load-failed", failed);
    viewer.removeHandler("update-level", visible);
    for (const event of ["pan", "zoom", "resize", "animation-finish"])
      viewer.removeHandler(event, changed);
    viewer.world?.removeHandler?.("remove-item", removed);
    viewer.world?.removeHandler?.("add-item", added);
  };
  if (!signal.aborted) {
    viewer.addHandler("tile-loaded", loaded);
    viewer.addHandler("tile-load-failed", failed);
    viewer.addHandler("update-level", visible);
    for (const event of ["pan", "zoom", "resize", "animation-finish"])
      viewer.addHandler(event, changed);
    viewer.world?.addHandler?.("remove-item", removed);
    viewer.world?.addHandler?.("add-item", added);
    signal.addEventListener("abort", stop, { once: true });
  }
  function added(event: any) {
    add(event.item);
  }
  function add(item: any) {
    if (
      signal.aborted ||
      regions.has(item) ||
      !(item.source?.__instantTerrain || item.source?.__instantCoverage)
    )
      return;
    // A late scene/plane's base reservation takes precedence over the
    // replaceable adaptive plan. Changed() replans the remaining capacity.
    if (started) clearAdaptive();
    if (
      typeof item._getTile !== "function" ||
      typeof item._loadTile !== "function"
    )
      return;
    const cutoff = item.savedCutOffLevel ?? item.source.getClosestLevel();
    const bounds = item.source.instantRegion;
    const plane = bounds
      ? Math.round((bounds.y - WORLD_TOP) / WORLD_HEIGHT)
      : 0;
    const pw = bounds?.pw ?? 0;
    const region: Region = {
      item,
      base: [],
      cutoff,
      baseEnd: Math.min(
        cutoff +
          Math.max(
            0,
            Math.min(
              INSTANT_COVERAGE_EXTRA_LEVELS,
              item.source.instantCoverageExtraLevels ??
                INSTANT_COVERAGE_EXTRA_LEVELS,
            ),
          ),
        item.source.maxLevel,
      ),
      rank:
        Math.abs(plane) * 100 +
        (plane > 0 ? 50 : 0) +
        Math.abs(pw) * 2 +
        (pw > 0 ? 1 : 0),
    };
    regions.set(item, region);
    stats.regions++;
    for (let level = cutoff; level <= region.baseEnd; level++)
      for (const { x, y } of tileCoordinates(item, level)) {
        const entry = makeEntry(region, level, x, y, true);
        if (!entry.tile.exists) continue;
        region.base.push(entry);
        residency.retain(entry);
        queued.add(entry);
      }
    if (started) changed();
    schedule();
  }
  for (let i = 0; i < (viewer.world?.getItemCount?.() ?? 0); i++)
    add(viewer.world.getItemAt(i));
  return {
    stats,
    add,
    start() {
      if (signal.aborted || started) return;
      started = true;
      plan();
    },
  };
}
