import { getMapMemoryBudget, type MapMemoryBudget } from '../map-memory-budget';
import { clipTerrainPresentation } from './terrain-presentation-clip';
declare const OpenSeadragon: any;

export interface ViewportTerrainBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** World-space rectangle and its uniform physical-pixel sampling grid. */
export interface InstantTerrainViewportPlan extends ViewportTerrainBounds {
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
}

type DirectLayerHook = {
  viewer: any;
  drawer: any;
  original: (...args: any[]) => any;
  wrapper: (...args: any[]) => any;
  sources: Map<any, { original: (...args: any[]) => any; wrapper: (...args: any[]) => any }>;
  items: Map<any, {
    original: (...args: any[]) => any; wrapper: (...args: any[]) => any;
    update: (...args: any[]) => any; updateWrapper: (...args: any[]) => any;
  }>;
  added: (event: any) => void;
  removed: (event: any) => void;
  destroy: () => void;
};
const layerHooks = new WeakMap<object, DirectLayerHook>();

function restoreLayerHook(hook: DirectLayerHook): void {
  if (layerHooks.get(hook.viewer) !== hook) return;
  layerHooks.delete(hook.viewer);
  if (hook.drawer._drawTiles === hook.wrapper) hook.drawer._drawTiles = hook.original;
  for (const [item, entry] of hook.items) {
    if (item.setDrawn === entry.wrapper) item.setDrawn = entry.original;
    if (item._updateLevelsForViewport === entry.updateWrapper) item._updateLevelsForViewport = entry.update;
  }
  for (const [source, entry] of hook.sources)
    if (source.destroy === entry.wrapper) source.destroy = entry.original;
  hook.items.clear();
  hook.sources.clear();
  hook.viewer.world?.removeHandler?.('add-item', hook.added);
  hook.viewer.world?.removeHandler?.('remove-item', hook.removed);
  hook.viewer.removeHandler?.('before-destroy', hook.destroy);
}

function registerSource(hook: DirectLayerHook, source: any): void {
  if (hook.sources.has(source)) return;
  const original = source.destroy ?? (() => {});
  const wrapper = function(this: any, ...args: any[]) {
    try { return original.apply(this, args); }
    finally {
      hook.sources.delete(source);
      for (const [item, entry] of hook.items) if (item.source === source) {
        if (item.setDrawn === entry.wrapper) item.setDrawn = entry.original;
        if (item._updateLevelsForViewport === entry.updateWrapper) item._updateLevelsForViewport = entry.update;
        hook.items.delete(item);
      }
      if (source.destroy === wrapper) source.destroy = original;
      if (!hook.sources.size && !hook.items.size) restoreLayerHook(hook);
    }
  };
  hook.sources.set(source, { original, wrapper });
  source.destroy = wrapper;
}

function registerItem(hook: DirectLayerHook, item: any): void {
  const source = item?.source;
  if (typeof source?.__drawViewport !== 'function') return;
  registerSource(hook, source);
  if (hook.items.has(item) || typeof item.setDrawn !== 'function') return;
  // OSD assumes an image with zero drawn tiles still needs its first tile.
  // A viewport layer has no tiles; retaining that rule spins idle redraws.
  const original = item.setDrawn;
  const wrapper = function(this: any) { this._needsDraw = false; return false; };
  const update = item._updateLevelsForViewport;
  const updateWrapper = function(this: any) {
    this._lastDrawn = [];
    this._tilesToDraw = [];
    this._isBlending = this._wasBlending = false;
    return true;
  };
  hook.items.set(item, { original, wrapper, update, updateWrapper });
  item.setDrawn = wrapper;
  item._updateLevelsForViewport = updateWrapper;
}

/** Draw direct layers at their normal position in OSD's ordered canvas pass.
 * Optional source registration covers the interval before addTiledImage lands.
 * A layer may return false to use the ordinary CanvasDrawer implementation. */
export function installViewportLayerDrawing(viewer: any, source?: any): boolean {
  const osd = viewer.viewer || viewer;
  const drawer = osd.drawer;
  if (drawer?.getType?.() !== 'canvas' || typeof drawer._drawTiles !== 'function' || !drawer.context)
    return false;
  let hook = layerHooks.get(osd);
  if (hook && hook.drawer !== drawer) { restoreLayerHook(hook); hook = undefined; }
  if (!hook) {
    const original = drawer._drawTiles;
    const created: DirectLayerHook = {
      viewer: osd, drawer, original, sources: new Map(), items: new Map(),
      wrapper(this: any, item: any, ...args: any[]) {
        registerItem(created, item);
        const draw = item.source?.__drawViewport;
        if (typeof draw === 'function') {
          if (draw.call(item.source, this.context, item, this.viewport) !== false) return;
          created.items.get(item)?.update?.call(item);
        }
        return original.call(this, item, ...args);
      },
      added: event => registerItem(created, event.item),
      removed: event => {
        const entry = created.items.get(event.item);
        if (entry && event.item.setDrawn === entry.wrapper) event.item.setDrawn = entry.original;
        if (entry && event.item._updateLevelsForViewport === entry.updateWrapper) event.item._updateLevelsForViewport = entry.update;
        created.items.delete(event.item);
        if (!created.sources.size && !created.items.size) restoreLayerHook(created);
      },
      destroy: () => {
        for (const registered of [...created.sources.keys()]) registered.destroy();
        restoreLayerHook(created);
      },
    };
    hook = created;
    layerHooks.set(osd, hook);
    drawer._drawTiles = hook.wrapper;
    osd.world?.addHandler?.('add-item', hook.added);
    osd.world?.addHandler?.('remove-item', hook.removed);
    osd.addHandler?.('before-destroy', hook.destroy);
    for (let i = 0; i < (osd.world?.getItemCount?.() ?? 0); i++) registerItem(hook, osd.world.getItemAt(i));
  }
  if (source) registerSource(hook, source);
  return true;
}

function density(): number {
  return OpenSeadragon.pixelDensityRatio || globalThis.devicePixelRatio || 1;
}

type SamplingBudget = Pick<MapMemoryBudget, 'viewportMaxPixels' | 'viewportMaxDimension'>;

export function planInstantTerrainViewport(viewport: any, bounds: ViewportTerrainBounds,
  budget: SamplingBudget = getMapMemoryBudget()): InstantTerrainViewportPlan | null {
  const current = viewport.getBounds(true);
  const visible = current.getBoundingBox?.() ?? current;
  const pixelsPerWorld = Math.abs(viewport.deltaPixelsFromPointsNoRotate(new OpenSeadragon.Point(1, 0), true).x) * density();
  return sampleViewport(visible, pixelsPerWorld, bounds, budget);
}

function sampleViewport(visible: ViewportTerrainBounds, pixelsPerWorld: number,
  bounds: ViewportTerrainBounds, budget: SamplingBudget, margin = 0): InstantTerrainViewportPlan | null {
  const x = Math.max(bounds.x, visible.x), y = Math.max(bounds.y, visible.y);
  const right = Math.min(bounds.x + bounds.width, visible.x + visible.width);
  const bottom = Math.min(bounds.y + bounds.height, visible.y + visible.height);
  if (![x, y, right, bottom, pixelsPerWorld].every(Number.isFinite) || right <= x || bottom <= y || pixelsPerWorld <= 0) return null;
  // This bounds temporary presentation buffers, not canonical native terrain.
  // High-DPI phones and rotated views must not allocate a device-sized bitmap
  // in every compositor/cache stage without a pixel and dimension ceiling.
  const maxWidth = right - x, maxHeight = bottom - y;
  let sampleDensity = Math.min(pixelsPerWorld,
    Math.sqrt(budget.viewportMaxPixels / (maxWidth * maxHeight)),
    (budget.viewportMaxDimension - 2 * margin) / maxWidth, (budget.viewportMaxDimension - 2 * margin) / maxHeight);
  // Ceil-to-cover may exceed the area limit by one row/column. Tighten the
  // uniform grid until even its outward-rounded allocation fits the budget.
  const allocation = () => (Math.ceil(maxWidth * sampleDensity) + 2 * margin) * (Math.ceil(maxHeight * sampleDensity) + 2 * margin);
  while (allocation() > budget.viewportMaxPixels)
    sampleDensity *= Math.sqrt(budget.viewportMaxPixels /
      allocation()) * (1 - 1e-9);
  const scale = 1 / sampleDensity;
  const pixelWidth = Math.max(1, Math.ceil(maxWidth * sampleDensity));
  const pixelHeight = Math.max(1, Math.ceil(maxHeight * sampleDensity));
  // Round outward by less than one physical pixel. Drawing clips this small
  // overscan to the map bounds, preserving uniform sampling and full coverage.
  return { x, y, width: pixelWidth * scale, height: pixelHeight * scale, scale, pixelWidth, pixelHeight };
}

/** An expanding camera needs the actual OSD destination, not a succession of
 * smaller animation samples that are already obsolete when a worker finishes. */
function navigationPlan(viewport: any, bounds: ViewportTerrainBounds, budget: SamplingBudget, margin = 0) {
  const view = viewport.getBounds(true);
  const current = sampleViewport(view.getBoundingBox?.() ?? view,
    Math.abs(viewport.deltaPixelsFromPointsNoRotate(new OpenSeadragon.Point(1, 0), true).x) * density(), bounds, budget, margin);
  const presentDensity = Math.abs(viewport.deltaPixelsFromPointsNoRotate(new OpenSeadragon.Point(1, 0), true).x);
  const targetDensity = Math.abs(viewport.deltaPixelsFromPointsNoRotate(new OpenSeadragon.Point(1, 0), false).x);
  if (!current || !Number.isFinite(targetDensity) || targetDensity <= 0
    || targetDensity >= presentDensity * (1 - 1e-10)) return current;
  const destination = viewport.getBounds(false);
  const target = destination.getBoundingBox?.() ?? destination;
  const x = Math.min(current.x, target.x), y = Math.min(current.y, target.y);
  const right = Math.max(current.x + current.width, target.x + target.width);
  const bottom = Math.max(current.y + current.height, target.y + target.height);
  return sampleViewport({ x, y, width: right - x, height: bottom - y },
    targetDensity * density(), bounds, budget, margin);
}

function releaseImage(image: CanvasImageSource): void {
  const owned = image as any;
  if (typeof owned.close === 'function') owned.close();
  else if (typeof owned.getContext === 'function') owned.width = owned.height = 0;
}

/** Split coverage instead of painting an old frame beneath a newer one: air
 * in the newer frame must reveal the biome background, never old terrain. */
function outside(rectangle: ViewportTerrainBounds, covers: ViewportTerrainBounds[]): ViewportTerrainBounds[] {
  let remaining = [rectangle];
  for (const cover of covers) {
    const next: ViewportTerrainBounds[] = [];
    for (const part of remaining) {
      const left = Math.max(part.x, cover.x), top = Math.max(part.y, cover.y);
      const right = Math.min(part.x + part.width, cover.x + cover.width);
      const bottom = Math.min(part.y + part.height, cover.y + cover.height);
      if (right <= left || bottom <= top) { next.push(part); continue; }
      if (left > part.x) next.push({ ...part, width: left - part.x });
      if (right < part.x + part.width) next.push({ ...part, x: right, width: part.x + part.width - right });
      if (top > part.y) next.push({ x: left, y: part.y, width: right - left, height: top - part.y });
      if (bottom < part.y + part.height) next.push({ x: left, y: bottom, width: right - left, height: part.y + part.height - bottom });
    }
    remaining = next;
    if (!remaining.length) break;
  }
  return remaining;
}

/** Present complete physical-resolution frames while retaining bounded earlier
 * coverage around them. Navigation coalesces to one pending camera. */
export function createInstantTerrainViewport(options: {
  viewer: any;
  bounds: ViewportTerrainBounds;
  signal: AbortSignal;
  renderFrame: (plan: InstantTerrainViewportPlan, signal: AbortSignal) => Promise<CanvasImageSource>;
  firstPaint: () => void;
  onFailure: (error: unknown) => void;
  revision?: () => number;
  /** Extra decoded pixels, excluding the currently displayed complete frame. */
  maxRetainedPixels?: number;
  /** Same-shader coverage for world areas no foreground camera has visited.
   * Reserved inside maxRetainedPixels, not added to that memory allowance. */
  overviewMaxPixels?: number;
  /** Actual neighbouring samples protect frame edges during reprojection. */
  frameMarginPixels?: number;
}) {
  const { bounds, signal } = options;
  const memory = getMapMemoryBudget();
  const margin = Math.max(0, Math.floor(options.frameMarginPixels ?? 0));
  const framePixels = (plan: InstantTerrainViewportPlan) => (plan.pixelWidth + 2 * margin) * (plan.pixelHeight + 2 * margin);
  const osd = options.viewer.viewer || options.viewer;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0)
    throw new RangeError('Invalid viewport terrain bounds');
  // A single permanently absent tile avoids traversing a synthetic pyramid.
  const source = new OpenSeadragon.TileSource({ ...bounds,
    tileSize: Math.ceil(Math.max(bounds.width, bounds.height)), minLevel: 0, maxLevel: 0 });
  source.__instantViewport = true;
  source.hasTransparency = () => true;
  source.tileExists = () => false;
  source.getTileUrl = () => 'instant-viewport://no-tiles';
  source.downloadTileStart = (job: any) => job.fail('Viewport terrain has no image tiles');
  const stats = { frames: 0, discarded: 0, renderMs: 0, firstDrawMs: 0, shadedPixels: 0 };
  const started = performance.now();
  type Request = { plan: InstantTerrainViewportPlan; key: string; revision: number; overview?: boolean };
  type Frame = Request & { image: CanvasImageSource };
  let frame: Frame | undefined;
  let retained: Frame[] = [];
  let overview: Frame | undefined;
  const maxRetainedPixels = Math.max(0, options.maxRetainedPixels ?? memory.retainedFramePixels);
  const overviewPixels = Math.max(0, Math.floor(Math.min(options.overviewMaxPixels ?? 0, maxRetainedPixels)));
  const overviewPlan = overviewPixels >= (1 + 2 * margin) ** 2 ? sampleViewport(bounds, 1, bounds, {
    viewportMaxPixels: overviewPixels, viewportMaxDimension: memory.viewportMaxDimension,
  }, margin) : null;
  const overviewSize = overviewPlan ? framePixels(overviewPlan) : 0;
  Object.defineProperties(stats, {
    overviewBytes: { enumerable: true, get: () => overview ? overviewSize * 4 : 0 },
    retainedFrames: { enumerable: true, get: () => retained.length },
    retainedBytes: { enumerable: true, get: () => retained.reduce((sum, entry) => sum + framePixels(entry.plan) * 4, overview ? overviewSize * 4 : 0) },
  });
  let pending: Request | undefined;
  let active: Request | undefined;
  let desiredKey: string | undefined;
  let controller: AbortController | undefined;
  let destroyed = false, failed = false, painted = false;
  const revision = () => options.revision?.() ?? 0;
  const events = ['zoom', 'pan', 'viewport-change', 'animation', 'animation-finish', 'resize', 'rotate', 'flip'];

  function remember(previous: Frame): void {
    const candidates = [...retained, previous];
    const useful = candidates.filter(entry => {
      // Only current coverage is guaranteed to survive the budget selection.
      // Older frames may cover each other but either could be evicted below.
      if (entry.plan.scale < frame!.plan.scale || outside(entry.plan, [frame!.plan]).length) return true;
      releaseImage(entry.image);
      return false;
    });
    // Preserve the broad surrounding view across many small zoom-in steps.
    // A plain FIFO would evict it just before the user zooms back out.
    const ranked = [...useful].reverse().sort((a, b) => {
      const overlaps = (plan: ViewportTerrainBounds) => plan.x < frame!.plan.x + frame!.plan.width
        && plan.x + plan.width > frame!.plan.x && plan.y < frame!.plan.y + frame!.plan.height
        && plan.y + plan.height > frame!.plan.y;
      const detail = (entry: Frame) => overlaps(entry.plan) && entry.plan.scale < frame!.plan.scale;
      return Number(detail(b)) - Number(detail(a))
        || Number(overlaps(b.plan)) - Number(overlaps(a.plan))
        || b.plan.width * b.plan.height - a.plan.width * a.plan.height;
    });
    const kept = new Set<Frame>();
    let pixels = 0;
    for (const entry of ranked) {
      const size = framePixels(entry.plan);
      if (kept.size < 3 && pixels + size <= maxRetainedPixels - overviewSize) { kept.add(entry); pixels += size; }
      else releaseImage(entry.image);
    }
    retained = useful.filter(entry => kept.has(entry));
  }

  function stop(): void {
    pending = undefined;
    controller?.abort();
    for (const name of events) osd.removeHandler?.(name, refresh);
    signal.removeEventListener('abort', stop);
  }
  function fail(error: unknown): void {
    if (failed || destroyed || signal.aborted) return;
    failed = true;
    stop();
    options.onFailure(error);
  }
  function pump(): void {
    if (active || destroyed || failed || signal.aborted) return;
    // The first visible camera wins the initial job. Complete bounded global
    // coverage next, before exposing this generation or starting its cooker.
    const request: Request | undefined = frame && overviewPlan && !overview
      ? { plan: overviewPlan, key: 'overview', revision: revision(), overview: true }
      : pending;
    if (!request) return;
    if (!request.overview) pending = undefined;
    active = request;
    const drawController = controller = new AbortController();
    const began = performance.now();
    void Promise.resolve().then(() => {
      drawController.signal.throwIfAborted();
      const p = request.plan;
      return options.renderFrame(margin ? { ...p, x: p.x - margin * p.scale, y: p.y - margin * p.scale,
        width: p.width + 2 * margin * p.scale, height: p.height + 2 * margin * p.scale,
        pixelWidth: p.pixelWidth + 2 * margin, pixelHeight: p.pixelHeight + 2 * margin } : p, drawController.signal);
    }).then(image => {
      // A retention revision adds exact pixels within this same generation.
      // It does not invalidate a finished camera frame. Discarding every draw
      // overtaken by background cooking can leave a zoomed-in camera showing
      // its old overview indefinitely. Publish, then refresh to the new revision.
      if (destroyed || signal.aborted || drawController.signal.aborted || (!request.overview && (
        frame?.key === desiredKey && request.key !== desiredKey))) {
        releaseImage(image);
        stats.discarded++;
        return;
      }
      if (!image) throw new Error('Viewport terrain returned no frame');
      if (request.overview) overview = { ...request, image };
      else {
        const previous = frame;
        frame = { ...request, image };
        if (previous) remember(previous);
      }
      stats.frames++;
      stats.renderMs += performance.now() - began;
      stats.shadedPixels += framePixels(request.plan);
      osd.forceRedraw?.();
    }).catch(error => {
      if (!drawController.signal.aborted) fail(error);
    }).finally(() => {
      active = undefined;
      if (controller === drawController) controller = undefined;
      // Camera changes can arrive without an animation event in the same task
      // as render completion. Re-read once rather than publish an obsolete FIFO.
      refresh();
    });
  }
  function refresh(): void {
    if (destroyed || failed || signal.aborted) return;
    try {
      const plan = navigationPlan(osd.viewport, bounds, memory, margin);
      if (!plan) { pending = undefined; desiredKey = undefined; return; }
      const version = revision();
      const key = [plan.x, plan.y, plan.pixelWidth, plan.pixelHeight, plan.scale, version].join('/');
      desiredKey = key;
      if (key === active?.key || key === frame?.key) { pending = undefined; pump(); return; }
      pending = { plan, key, revision: version };
      pump();
    } catch (error) { fail(error); }
  }
  // OSD's getFullyLoaded only understands tiled images. Replacement readiness
  // additionally requires this direct layer to have painted the latest camera.
  let drawnKey: string | undefined;
  let overviewDrawn = false;
  source.__viewportReady = () => {
    refresh();
    return !destroyed && !failed && !signal.aborted && (!overviewPlan || overviewDrawn) && (!desiredKey || drawnKey === desiredKey);
  };
  source.__drawViewport = (context: CanvasRenderingContext2D, item: any, viewport: any): boolean => {
    if (destroyed) return true;
    refresh();
    if (!frame) return true;
    const ratio = density();
    const point = (x: number, y: number) => viewport.pixelFromPoint(new OpenSeadragon.Point(x, y), true);
    const origin = point(0, 0), unitX = point(1, 0), unitY = point(0, 1), m = context.getTransform();
    const ax = (unitX.x - origin.x) * ratio, ay = (unitX.y - origin.y) * ratio;
    const bx = (unitY.x - origin.x) * ratio, by = (unitY.y - origin.y) * ratio;
    const a = m.a * ax + m.c * ay, b = m.b * ax + m.d * ay;
    const c = m.a * bx + m.c * by, d = m.b * bx + m.d * by;
    const determinant = Math.abs(a * d - b * c);
    if (![a, b, c, d, determinant].every(Number.isFinite) || !determinant) return true;
    const displayScale = 1 / Math.max(Math.hypot(a, b), Math.hypot(c, d));
    // A zoom-out destination can finish before the camera gets there. Keep
    // sharper frames above it while its samples would still be magnified.
    // Once both frames supply display resolution, prefer the newer one.
    const frames = [...(overview ? [overview] : []), ...retained, frame].sort((left, right) =>
      Math.max(right.plan.scale, displayScale) - Math.max(left.plan.scale, displayScale));
    const radiusX = (Math.abs(d) + Math.abs(c)) / (2 * determinant);
    const radiusY = (Math.abs(b) + Math.abs(a)) / (2 * determinant);
    // A previously close frame can shrink by much more than its one-sample
    // guard during zoom-out. Give its outer partial screen pixels back to the
    // broader frame, rather than antialiasing a transparent rectangular seam.
    const coverage = frames.map(({ plan }) => {
      const insetX = Math.max(0, radiusX * (1 - 1e-9) - margin * plan.scale);
      const insetY = Math.max(0, radiusY * (1 - 1e-9) - margin * plan.scale);
      return { x: plan.x + insetX, y: plan.y + insetY,
        width: Math.max(0, plan.width - 2 * insetX), height: Math.max(0, plan.height - 2 * insetY) };
    });
    for (let index = 0; index < frames.length; index++) {
      const { plan, image } = frames[index];
      const visible = outside(coverage[index], coverage.slice(index + 1));
      if (!visible.length) continue;
      const start = point(plan.x, plan.y), right = point(plan.x + plan.width, plan.y), bottom = point(plan.x, plan.y + plan.height);
      const matrix = [(right.x - start.x) * ratio / plan.pixelWidth, (right.y - start.y) * ratio / plan.pixelWidth,
        (bottom.x - start.x) * ratio / plan.pixelHeight, (bottom.y - start.y) * ratio / plan.pixelHeight, start.x * ratio, start.y * ratio];
      if (!matrix.every(Number.isFinite)) continue;
      context.save();
      try {
        // CanvasDrawer already carries viewport flip. Compose this affine camera
        // transform with it; pixelFromPoint supplies rotation but not flip.
        context.transform(...matrix as [number, number, number, number, number, number]);
        clipTerrainPresentation(context, [{ x: (bounds.x - plan.x) / plan.scale,
          y: (bounds.y - plan.y) / plan.scale, width: bounds.width / plan.scale, height: bounds.height / plan.scale }]);
        clipTerrainPresentation(context, visible.map(part => ({ x: (part.x - plan.x) / plan.scale,
          y: (part.y - plan.y) / plan.scale, width: part.width / plan.scale, height: part.height / plan.scale })));
        context.globalAlpha *= item.opacity ?? 1;
        context.globalCompositeOperation = item.compositeOperation || 'source-over';
        context.imageSmoothingEnabled = plan.scale < displayScale * (1 - 1e-9);
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, -margin, -margin);
      } finally { context.restore(); }
    }
    drawnKey = frame.key;
    overviewDrawn = !!overview;
    if (!painted && !signal.aborted && (!overviewPlan || overview) && frame.key === desiredKey) {
      painted = true;
      stats.firstDrawMs = performance.now() - started;
      // The bridge removes old world items here. Wait until CanvasDrawer has
      // finished iterating that same array, including the new scene/POI layers.
      queueMicrotask(() => { if (!destroyed && !signal.aborted) options.firstPaint(); });
    }
    return true;
  };
  source.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    stop();
    if (frame) releaseImage(frame.image);
    frame = undefined;
    if (overview) releaseImage(overview.image);
    overview = undefined;
    for (const entry of retained) releaseImage(entry.image);
    retained = [];
  };
  Object.defineProperty(source, 'isDisposed', { get: () => destroyed });
  source.instantViewportStats = stats;
  if (!installViewportLayerDrawing(osd, source)) throw new Error('Viewport terrain requires the OSD canvas drawer');
  if (!signal.aborted) {
    signal.addEventListener('abort', stop, { once: true });
    for (const name of events) osd.addHandler?.(name, refresh);
    refresh();
  }
  return { source, refresh, isBusy: () => !!active || !!pending, stats };
}
