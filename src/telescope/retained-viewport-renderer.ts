import { scheduleTerrainWork } from './terrain-work-queue';
import type { TerrainViewportPlan } from './terrain-viewport-compositor';
import type { RetainedTerrainRegion, RetainedView, RetainedViewCoverage } from './retained-terrain';
import { InstantTerrainCache } from './instant-terrain-cache';
import { clipTerrainPixels } from './terrain-pixel-clip';

type Region = { region: { x: number; y: number; width: number; height: number }; retention: RetainedTerrainRegion };
let nextRendererId = 0;

/** Disjoint row spans bound metadata to visible coverage, rather than keeping
 * the repeated overlapping rectangles accumulated over camera history. */
function mergeCoverage(rectangles: RetainedViewCoverage[], view: TerrainViewportPlan): RetainedViewCoverage[] {
  const events = new Map<number, Array<{ id: number; rectangle?: RetainedViewCoverage }>>();
  const event = (y: number, value: { id: number; rectangle?: RetainedViewCoverage }) => {
    const row = events.get(y) ?? []; row.push(value); events.set(y, row);
  };
  for (let id = 0; id < rectangles.length; id++) {
    const r = rectangles[id], x = Math.max(view.x, r.x), y = Math.max(view.y, r.y);
    const right = Math.min(view.x + view.width, r.x + r.width), bottom = Math.min(view.y + view.height, r.y + r.height);
    if (right <= x || bottom <= y) continue;
    event(y, { id, rectangle: { x, y, width: right - x, height: bottom - y } });
    event(bottom, { id });
  }
  const rows = [...events.keys()].sort((a, b) => a - b), active = new Map<number, RetainedViewCoverage>();
  const result: RetainedViewCoverage[] = [];
  let previous = new Map<string, RetainedViewCoverage>();
  for (let i = 0; i + 1 < rows.length; i++) {
    const y = rows[i], bottom = rows[i + 1];
    for (const entry of events.get(y)!) {
      if (entry.rectangle) active.set(entry.id, entry.rectangle); else active.delete(entry.id);
    }
    const spans: { x: number; right: number }[] = [];
    for (const rect of [...active.values()].sort((a, b) => a.x - b.x)) {
      const last = spans.at(-1), right = rect.x + rect.width;
      if (last && rect.x <= last.right) last.right = Math.max(last.right, right);
      else spans.push({ x: rect.x, right });
    }
    const current = new Map<string, RetainedViewCoverage>();
    for (const span of spans) {
      const key = `${span.x}/${span.right}`, prior = previous.get(key);
      const rect = prior ?? { x: span.x, y, width: span.right - span.x, height: 0 };
      rect.height += bottom - y;
      if (!prior) result.push(rect);
      current.set(key, rect);
    }
    previous = current;
  }
  return result;
}

/** Foreground frames never reserve persistence capacity or await cache writes.
 * Finished native pixels remain authoritative, including their transparent
 * holes. A stationary view reuses its GPU frame while cooking fills those in. */
export function createRetainedViewportRenderer(options: {
  regions: Region[];
  renderer: { renderViewport(plan: TerrainViewportPlan, signal: AbortSignal): Promise<CanvasImageSource> };
  signal: AbortSignal;
  complete(): boolean;
  refresh(): void;
  cache?: InstantTerrainCache;
}) {
  type Metadata = { plan: TerrainViewportPlan; canonical: RetainedViewCoverage[] };
  type Frame = Metadata & { key: string; canvas: HTMLCanvasElement };
  let base: Frame | undefined;
  const cache = options.cache ?? new InstantTerrainCache();
  const cameras = new Map<string, Metadata>();
  const prefix = `viewport/${nextRendererId++}/`;
  let hydratedKey: string | undefined;
  let hydrating = false;
  let hydratedRevision = 0, inheritedHydration = 0;
  const releaseBase = () => { if (base) base.canvas.width = base.canvas.height = 0; base = undefined; };
  const dispose = () => {
    releaseBase();
    cameras.clear();
    if (!options.cache) cache.clear();
  };
  options.signal.addEventListener('abort', dispose, { once: true });
  const stats = { gpuFrames: 0, retainedFrames: 0, reusedFrames: 0 };
  function visible(plan: TerrainViewportPlan) {
    const result: { entry: Region; view: RetainedView }[] = [];
    for (const entry of options.regions) {
      const r = entry.region;
      const x = Math.max(plan.x, r.x), y = Math.max(plan.y, r.y);
      const right = Math.min(plan.x + plan.width, r.x + r.width);
      const bottom = Math.min(plan.y + plan.height, r.y + r.height);
      if (right > x && bottom > y) result.push({ entry, view: {
        x: x - r.x, y: y - r.y, width: right - x, height: bottom - y, scale: plan.scale,
      } });
    }
    return result;
  }
  function canvas(plan: TerrainViewportPlan) {
    const out = document.createElement('canvas');
    out.width = plan.pixelWidth; out.height = plan.pixelHeight;
    const context = out.getContext('2d');
    if (!context) throw new Error('Viewport presentation canvas unavailable');
    context.imageSmoothingEnabled = false;
    return context;
  }
  function position(context: CanvasRenderingContext2D, plan: TerrainViewportPlan, entry: Region) {
    context.setTransform(1 / plan.scale, 0, 0, 1 / plan.scale,
      (entry.region.x - plan.x) / plan.scale, (entry.region.y - plan.y) / plan.scale);
  }
  function preserveDetail(context: CanvasRenderingContext2D, plan: TerrainViewportPlan, key: string, previous?: Frame) {
    const history = [...cameras].filter(([candidate, { plan: view }]) => {
      if (!cache.has(candidate)) { cameras.delete(candidate); return false; }
      return candidate !== previous?.key
        && view.x < plan.x + plan.width && view.x + view.width > plan.x
        && view.y < plan.y + plan.height && view.y + view.height > plan.y;
    }).map(([candidate, meta]) => ({ key: candidate, ...meta,
      canvas: candidate === key ? base!.canvas : undefined as HTMLCanvasElement | undefined }));
    // The currently displayed frame survives optional/shared cache eviction.
    if (previous) history.push(previous);
    const canonical: RetainedViewCoverage[] = [...base!.canonical];
    context.save();
    context.setTransform(1 / plan.scale, 0, 0, 1 / plan.scale, -plan.x / plan.scale, -plan.y / plan.scale);
    const paint = (saved: typeof history[number]) => {
      context.save();
      clipTerrainPixels(context, [saved.plan], 'inside');
      context.imageSmoothingEnabled = saved.plan.scale < plan.scale;
      context.imageSmoothingQuality = 'low';
      const { x, y, width, height } = saved.plan;
      if (saved.canvas) {
        context.clearRect(x, y, width, height);
        context.drawImage(saved.canvas, x, y, width, height);
      } else cache.paint(saved.key, context, x, y, width, height);
      context.restore();
    };
    // Newer compositions already contain older detail. Replaying a finer but
    // older provisional frame over one would resurrect corrected terrain.
    for (const saved of history) if (saved.plan.scale <= plan.scale) paint(saved);
    // Coverage says where native pixels contributed, not how many of those
    // pixels this screen-sized image retained. A downsampled frame cannot
    // overwrite a closer view: doing so permanently caches blurred 256px
    // blocks (and their coarse alpha edges) over the fresh shader result.
    // Native-density frames remain exact when magnified beyond 1:1.
    for (const saved of [...history].sort((a, b) => b.plan.scale - a.plan.scale)) if (
      saved.canonical.length && saved.plan.scale <= Math.max(1, plan.scale)
    ) {
      context.save();
      clipTerrainPixels(context, saved.canonical);
      paint(saved); context.restore();
      canonical.push(...saved.canonical);
    }
    context.restore();
    return canonical;
  }
  return {
    stats,
    async render(plan: TerrainViewportPlan, requestSignal: AbortSignal): Promise<CanvasImageSource> {
      requestSignal.throwIfAborted(); options.signal.throwIfAborted();
      const controller = new AbortController(), signal = controller.signal;
      const cancelRequest = () => controller.abort(requestSignal.reason);
      const cancelLifetime = () => controller.abort(options.signal.reason);
      requestSignal.addEventListener('abort', cancelRequest, { once: true });
      options.signal.addEventListener('abort', cancelLifetime, { once: true });
      let context: CanvasRenderingContext2D | undefined;
      let previous: Frame | undefined;
      try {
        const views = visible(plan);
        const key = prefix + [plan.x, plan.y, plan.scale, plan.pixelWidth, plan.pixelHeight].join('/');
        const sameCamera = base?.key === key;
        let canonical: RetainedViewCoverage[] = sameCamera ? base!.canonical : [];
        context = canvas(plan);
        const resident = views.every(({ entry, view }) => entry.retention.hasCompleteView(view));
        if (!resident && options.complete()) {
          // Once the whole map is complete, replay its saved pixels rather
          // than procedurally regenerating an evicted part on navigation.
          let complete = true;
          for (const { entry, view } of views) {
            signal.throwIfAborted();
            position(context, plan, entry);
            if (!await entry.retention.paintStoredView(context, view, signal)) complete = false;
          }
          signal.throwIfAborted();
          if (complete) { stats.retainedFrames++; return context.canvas; }
          context.resetTransform(); context.clearRect(0, 0, plan.pixelWidth, plan.pixelHeight);
        }
        if (!resident) {
          if (base?.key !== key) {
            const cached = cache.get(key);
            if (cached) {
              previous = base;
              base = { key, plan, canvas: cached.canvas, canonical: cameras.get(key)?.canonical ?? [] };
              stats.reusedFrames++;
            } else {
              const captured = await scheduleTerrainWork(
                () => options.renderer.renderViewport(plan, signal), signal, () => -1e12,
              );
              try {
                signal.throwIfAborted(); options.signal.throwIfAborted();
                const saved = canvas(plan);
                saved.drawImage(captured, 0, 0);
                previous = base;
                base = { key, plan, canvas: saved.canvas, canonical: [] };
                stats.gpuFrames++;
              } finally { (captured as ImageBitmap).close?.(); }
            }
          } else stats.reusedFrames++;
          context.drawImage(base!.canvas, 0, 0);
          if (!sameCamera || inheritedHydration !== hydratedRevision) {
            canonical = preserveDetail(context, plan, key, previous ?? base);
            inheritedHydration = hydratedRevision;
          }
        } else stats.retainedFrames++;
        for (const { entry, view } of views) {
          position(context, plan, entry);
          for (const rect of entry.retention.paintResidentView(context, view)) canonical.push({ ...rect,
            x: rect.x + entry.region.x, y: rect.y + entry.region.y });
        }
        // Save the composition, not its provisional shader base. Coarser
        // cameras inherit already viewed detail before current canonical cells
        // are applied above, including newly completed transparent pixels.
        if (!base || base.key !== key) { previous = base; base = { key, plan, canvas: canvas(plan).canvas, canonical: [] }; }
        const saved = base.canvas.getContext('2d')!;
        saved.resetTransform();
        saved.clearRect(0, 0, plan.pixelWidth, plan.pixelHeight);
        saved.drawImage(context.canvas, 0, 0);
        base.canonical = resident ? [{ ...plan }] : mergeCoverage(canonical, plan);
        cache.set(key, saved);
        cameras.delete(key); cameras.set(key, { plan, canonical: base.canonical });
        for (const candidate of cameras.keys()) if (!cache.has(candidate)) cameras.delete(candidate);
        // Optional reads run alongside later interaction and never gate this
        // frame. Only one view's hydration runs at a time during fast panning.
        if (!resident && !hydrating && hydratedKey !== key) {
          hydrating = true; hydratedKey = key;
          // Stream optional saved pages into one bounded output, not just RAM:
          // a viewport can contain more pages than the decoded page budget.
          const replay = canvas(plan), replayCoverage = [...base.canonical];
          replay.drawImage(context.canvas, 0, 0);
          let published = false;
          let readNativePixels = false;
          void Promise.resolve().then(async () => {
            for (const { entry, view } of views) {
              if (options.signal.aborted) return;
              position(replay, plan, entry);
              await entry.retention.paintStoredView(replay, view, options.signal, rect => {
                readNativePixels = true;
                replayCoverage.push({ ...rect, x: rect.x + entry.region.x, y: rect.y + entry.region.y });
              });
            }
            if (options.signal.aborted) return;
            if (base?.key !== key) {
              // Panning does not invalidate these world pixels. Save the
              // finished read so the next camera can inherit its overlap;
              // otherwise continuous motion discards every disk hydration.
              if (readNativePixels && cache.set(key, replay)) {
                cameras.delete(key);
                cameras.set(key, { plan, canonical: mergeCoverage(replayCoverage, plan) });
                for (const candidate of cameras.keys()) if (!cache.has(candidate)) cameras.delete(candidate);
                hydratedRevision++;
              }
              return;
            }
            // New native captures may have arrived during the reads. Keep the
            // current composition's canonical cells, then apply fresh RAM data.
            replay.setTransform(1 / plan.scale, 0, 0, 1 / plan.scale, -plan.x / plan.scale, -plan.y / plan.scale);
            replay.save();
            clipTerrainPixels(replay, base.canonical);
            replay.clearRect(plan.x, plan.y, plan.width, plan.height);
            replay.drawImage(base.canvas, plan.x, plan.y, plan.width, plan.height); replay.restore();
            replayCoverage.push(...base.canonical);
            for (const { entry, view } of views) {
              position(replay, plan, entry);
              for (const rect of entry.retention.paintResidentView(replay, view)) replayCoverage.push({ ...rect,
                x: rect.x + entry.region.x, y: rect.y + entry.region.y });
            }
            releaseBase();
            base = { key, plan, canvas: replay.canvas, canonical: mergeCoverage(replayCoverage, plan) };
            published = true;
            cache.set(key, replay);
            cameras.delete(key); cameras.set(key, { plan, canonical: base.canonical });
          }).catch(() => {}).finally(() => {
            if (!published) replay.canvas.width = replay.canvas.height = 0;
            hydrating = false;
            if (!options.signal.aborted) options.refresh();
          });
        }
        return context.canvas;
      } catch (error) { if (context) context.canvas.width = context.canvas.height = 0; throw error; }
      finally {
        if (previous) previous.canvas.width = previous.canvas.height = 0;
        requestSignal.removeEventListener('abort', cancelRequest);
        options.signal.removeEventListener('abort', cancelLifetime);
      }
    },
  };
}
