import { releaseTerrainImage } from "./terrain-frame";

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

export function planInstantTerrainViewport(viewport: any, bounds: ViewportTerrainBounds): InstantTerrainViewportPlan | null {
  const current = viewport.getBounds(true);
  const visible = current.getBoundingBox?.() ?? current;
  const pixelsPerWorld = Math.abs(viewport.deltaPixelsFromPointsNoRotate(new OpenSeadragon.Point(1, 0), true).x) * density();
  const x = Math.max(bounds.x, visible.x), y = Math.max(bounds.y, visible.y);
  const right = Math.min(bounds.x + bounds.width, visible.x + visible.width);
  const bottom = Math.min(bounds.y + bounds.height, visible.y + visible.height);
  if (![x, y, right, bottom, pixelsPerWorld].every(Number.isFinite) || right <= x || bottom <= y || pixelsPerWorld <= 0) return null;
  const scale = 1 / pixelsPerWorld;
  const pixelWidth = Math.max(1, Math.ceil((right - x) * pixelsPerWorld));
  const pixelHeight = Math.max(1, Math.ceil((bottom - y) * pixelsPerWorld));
  // Round outward by less than one physical pixel. Drawing clips this small
  // overscan to the map bounds, preserving uniform sampling and full coverage.
  return { x, y, width: pixelWidth * scale, height: pixelHeight * scale, scale, pixelWidth, pixelHeight };
}

const releaseImage = releaseTerrainImage;

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

/** One bounded fallback for areas this seed's camera has not visited yet. */
function initialOverviewPlan(bounds: ViewportTerrainBounds, view: InstantTerrainViewportPlan,
  maxPixels: number): InstantTerrainViewportPlan | null {
  if (!outside(bounds, [view]).length) return null;
  const edge = Math.min(1024, Math.max(view.pixelWidth, view.pixelHeight), Math.floor(Math.sqrt(maxPixels)));
  if (!(edge >= 1)) return null;
  const scale = Math.max(bounds.width, bounds.height) / edge;
  const pixelWidth = Math.min(edge, Math.ceil(bounds.width / scale));
  const pixelHeight = Math.min(edge, Math.ceil(bounds.height / scale));
  return { x: bounds.x, y: bounds.y, width: pixelWidth * scale, height: pixelHeight * scale,
    scale, pixelWidth, pixelHeight };
}

/** Present complete physical-resolution frames while retaining bounded earlier
 * coverage around them. Navigation coalesces to one pending camera. */
export function createInstantTerrainViewport(options: {
  viewer: any;
  bounds: ViewportTerrainBounds;
  signal: AbortSignal;
  renderFrame: (plan: InstantTerrainViewportPlan, signal: AbortSignal, preparingOverview?: boolean) => Promise<CanvasImageSource>;
  firstPaint: () => void;
  /** No terrain intersects the camera; readiness must not wait for a tile. */
  emptyView?: () => void;
  onFailure: (error: unknown) => void;
  revision?: () => number;
  /** Extra decoded pixels, excluding the currently displayed complete frame. */
  maxRetainedPixels?: number;
  /** Prepare same-seed coverage before revealing a first close-up frame. */
  initialOverview?: boolean;
  /** Ready GPU state can draw the current camera before the Canvas pass. */
  renderFrameNow?: (plan: InstantTerrainViewportPlan) => CanvasImageSource;
}) {
  const { bounds, signal } = options;
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
  const stats = { frames: 0, discarded: 0, renderMs: 0, firstDrawMs: 0, shadedPixels: 0, overviewMs: 0 };
  const started = performance.now();
  type Request = { plan: InstantTerrainViewportPlan; key: string; revision: number };
  type Frame = Request & { image: CanvasImageSource; borrowed?: boolean };
  let frame: Frame | undefined;
  let overview: Frame | undefined;
  let overviewReady = !options.initialOverview;
  let retained: Frame[] = [];
  const maxRetainedPixels = Math.max(0, options.maxRetainedPixels ?? 8 * 1024 * 1024);
  const overviewPixels = () => overview ? overview.plan.pixelWidth * overview.plan.pixelHeight : 0;
  Object.defineProperties(stats, {
    retainedFrames: { enumerable: true, get: () => retained.length + Number(!!overview) },
    retainedBytes: { enumerable: true, get: () => (overviewPixels() + retained.reduce((sum, entry) => sum + entry.plan.pixelWidth * entry.plan.pixelHeight, 0)) * 4 },
  });
  let pending: Request | undefined;
  let active: Request | undefined;
  let desiredKey: string | undefined;
  let controller: AbortController | undefined;
  let destroyed = false, failed = false, painted = false;
  const revision = () => options.revision?.() ?? 0;
  const events = ['pan', 'viewport-change', 'animation', 'animation-finish', 'resize', 'rotate', 'flip'];

  function remember(previous: Frame): void {
    const candidates = [...retained, previous];
    const useful = candidates.filter(entry => {
      // Only current coverage is guaranteed to survive the budget selection.
      // Older frames may cover each other but either could be evicted below.
      if (outside(entry.plan, [frame!.plan]).length) return true;
      releaseImage(entry.image);
      return false;
    });
    // Keep recent nearby detail for small zoom-outs. Ranking every slot by
    // area discarded the previous close-up and magnified distant overviews.
    const overlaps = (plan: ViewportTerrainBounds) => plan.x < frame!.plan.x + frame!.plan.width
      && plan.x + plan.width > frame!.plan.x && plan.y < frame!.plan.y + frame!.plan.height
      && plan.y + plan.height > frame!.plan.y;
    const overlapOrder = (a: Frame, b: Frame) => Number(overlaps(b.plan)) - Number(overlaps(a.plan));
    const ranked = [...useful].reverse().sort(overlapOrder);
    // A dedicated full-map overview already protects large jumps. Without
    // one, reserve just the broadest fallback, even under a one-frame budget.
    if (!overview && ranked.length) {
      const broadest = [...ranked].sort((a, b) => overlapOrder(a, b)
        || b.plan.width * b.plan.height - a.plan.width * a.plan.height)[0];
      ranked.splice(ranked.indexOf(broadest), 1);
      ranked.unshift(broadest);
    }
    const kept = new Set<Frame>();
    let pixels = overviewPixels();
    for (const entry of ranked) {
      const size = entry.plan.pixelWidth * entry.plan.pixelHeight;
      if (kept.size < 3 && pixels + size <= maxRetainedPixels) { kept.add(entry); pixels += size; }
      else releaseImage(entry.image);
    }
    retained = useful.filter(entry => kept.has(entry));
  }

  function stop(): void {
    // Preserve the outgoing map before its GPU resources are retired/reused.
    if (!destroyed && frame?.borrowed && options.renderFrameNow) {
      try {
        const image = options.renderFrameNow(frame.plan);
        const copy = document.createElement('canvas');
        copy.width = frame.plan.pixelWidth; copy.height = frame.plan.pixelHeight;
        copy.getContext('2d')!.drawImage(image, 0, 0);
        frame = { ...frame, image: copy, borrowed: false };
      } catch { frame = undefined; }
    }
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
    if (active || !pending || destroyed || failed || signal.aborted) return;
    const fallbackPlan = overviewReady ? null : initialOverviewPlan(bounds, pending.plan, maxRetainedPixels);
    const request = fallbackPlan ? { plan: fallbackPlan, key: 'initial-overview', revision: pending.revision } : pending;
    if (!fallbackPlan) pending = undefined;
    active = request;
    const drawController = controller = new AbortController();
    const began = performance.now();
    void Promise.resolve().then(() => {
      drawController.signal.throwIfAborted();
      return options.renderFrame(request.plan, drawController.signal, !!fallbackPlan);
    }).then(image => {
      if ((painted && options.renderFrameNow) || destroyed || signal.aborted || drawController.signal.aborted || request.revision !== revision()
        || (!fallbackPlan && frame?.key === desiredKey && request.key !== desiredKey)) {
        releaseImage(image);
        stats.discarded++;
        return;
      }
      if (!image) throw new Error('Viewport terrain returned no frame');
      if (fallbackPlan) {
        overview = { ...request, image };
        overviewReady = true;
        stats.overviewMs += performance.now() - began;
      } else {
        const previous = frame;
        frame = { ...request, image };
        if (!outside(bounds, [request.plan]).length) overviewReady = true;
        if (previous) remember(previous);
      }
      stats.frames++;
      stats.renderMs += performance.now() - began;
      stats.shadedPixels += request.plan.pixelWidth * request.plan.pixelHeight;
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
      const plan = planInstantTerrainViewport(osd.viewport, bounds);
      if (!plan) {
        pending = undefined; desiredKey = undefined;
        options.emptyView?.();
        return;
      }
      const version = revision();
      const key = [plan.x, plan.y, plan.pixelWidth, plan.pixelHeight, plan.scale, version].join('/');
      desiredKey = key;
      if (painted && options.renderFrameNow) { pending = undefined; return; }
      if (key === active?.key || key === frame?.key) { pending = undefined; return; }
      pending = { plan, key, revision: version };
      pump();
    } catch (error) { fail(error); }
  }
  source.__drawViewport = (context: CanvasRenderingContext2D, item: any, viewport: any): boolean => {
    if (destroyed) return true;
    refresh();
    if (painted && options.renderFrameNow && !signal.aborted && !failed) {
      const plan = planInstantTerrainViewport(viewport, bounds);
      if (!plan) return true;
      try {
        const start = performance.now();
        const image = options.renderFrameNow(plan);
        if (frame && !frame.borrowed) releaseImage(frame.image);
        retained.forEach(entry => releaseImage(entry.image)); retained = [];
        frame = { plan, image, key: desiredKey!, revision: revision(), borrowed: true };
        stats.frames++; stats.renderMs += performance.now() - start;
        stats.shadedPixels += plan.pixelWidth * plan.pixelHeight;
      } catch (error) { fail(error); return true; }
    }
    if (!frame) return true;
    // Clip fallback coverage out of every newer frame, including transparent
    // pixels. It cannot overwrite sharp terrain or resurrect erased material.
    const frames = [...(overview ? [overview] : []), ...retained, frame];
    const ratio = density();
    const point = (x: number, y: number) => viewport.pixelFromPoint(new OpenSeadragon.Point(x, y), true);
    for (let index = 0; index < frames.length; index++) {
      const { plan, image } = frames[index];
      const visible = outside(plan, frames.slice(index + 1).map(entry => entry.plan));
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
        context.beginPath();
        context.rect((bounds.x - plan.x) / plan.scale, (bounds.y - plan.y) / plan.scale, bounds.width / plan.scale, bounds.height / plan.scale);
        context.clip();
        context.beginPath();
        for (const part of visible) context.rect((part.x - plan.x) / plan.scale, (part.y - plan.y) / plan.scale,
          part.width / plan.scale, part.height / plan.scale);
        context.clip();
        context.globalAlpha *= item.opacity ?? 1;
        context.globalCompositeOperation = item.compositeOperation || 'source-over';
        context.imageSmoothingEnabled = false;
        context.drawImage(image, 0, 0);
      } finally { context.restore(); }
    }
    if (!painted && !signal.aborted && frame.key === desiredKey) {
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
    if (frame && !frame.borrowed) releaseImage(frame.image);
    frame = undefined;
    if (overview) releaseImage(overview.image);
    overview = undefined;
    for (const entry of retained) releaseImage(entry.image);
    retained = [];
  };
  Object.defineProperty(source, 'isDisposed', { get: () => destroyed });
  source.isInstantTerrainBusy = () => !destroyed && !signal.aborted && (!!active || !!pending);
  source.instantViewportStats = stats;
  if (!installViewportLayerDrawing(osd, source)) throw new Error('Viewport terrain requires the OSD canvas drawer');
  if (!signal.aborted) {
    signal.addEventListener('abort', stop, { once: true });
    for (const name of events) osd.addHandler?.(name, refresh);
    refresh();
  }
  return { source, refresh, isBusy: () => !!active || !!pending,
    hasVisibleTerrain: () => desiredKey !== undefined, stats };
}
