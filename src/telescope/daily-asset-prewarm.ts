import { reportTerrainStorageUsage } from "./terrain-storage-usage";
import { useRenderPerfGeneration } from "../renderer_settings";
import { prepareDailyAssetsOffThread } from './daily-asset-worker-client';

export interface DailyAssetWarmupOptions {
  viewer: any;
  isCurrent(): boolean;
  /** All expected DZI items must have attached, including offscreen worlds. */
  expectedBakedImages?: number;
  /** Resolves when seed metadata, presentation and POI setup finish. */
  metadataReady?: Promise<unknown>;
  /** Injectable stages keep scheduling/lifecycle tests independent of WebGL. */
  stages?: (() => Promise<unknown> | void)[];
  yieldTask?: (signal: AbortSignal) => Promise<void>;
  onFailure?: (error: unknown) => void;
}

/** Arm before baked DZIs are added. Wait for the visible map to finish loading
 * and paint before immutable preparation starts in a dedicated asset worker.
 * Cancellation terminates only this optional worker, never a foreground load. */
export function scheduleDailyAssetWarmup(
  options: DailyAssetWarmupOptions,
): () => void {
  const viewer = options.viewer.viewer ?? options.viewer;
  const controller = new AbortController();
  const current = () => !controller.signal.aborted && options.isCurrent();
  const yieldTask = options.yieldTask ?? (() => Promise.resolve());
  let started = false;
  let painted = false;
  let metadataReady = !options.metadataReady;
  let queued = false;
  const watched = new Set<any>();
  const viewerEvents = ['viewport-change', 'animation-finish', 'update-viewport'];
  let startedAt: number | undefined;
  let ended = false;
  let failures = 0;
  const finish = (state: 'finished' | 'cancelled' | 'failed') => {
    if (startedAt === undefined || ended) return;
    ended = true;
    detach();
    const finishedAt = performance.now();
    const elapsedMs = finishedAt - startedAt;
    console.info(`[Dynamic assets] Daily warmup ${state} in ${(elapsedMs / 1000).toFixed(2)} seconds`, {
      elapsedMs,
      sinceNavigationMs: finishedAt,
      failures,
      scope: 'Worker archive validation and immutable asset prefetch; seed-specific terrain cooking is separate',
      persistence: 'Optional cache writes settled or unavailable; decoded worlds are not retained',
    });
  };
  const detach = () => {
    viewer.removeHandler?.("tile-drawn", drawn);
    for (const name of viewerEvents) viewer.removeHandler?.(name, changed);
    viewer.removeHandler?.('viewport-change', cancel);
    viewer.removeHandler?.('before-destroy', cancel);
    viewer.world?.removeHandler?.('add-item', added);
    viewer.world?.removeHandler?.('remove-item', removed);
    for (const item of watched) unwatch(item);
    document.removeEventListener('visibilitychange', changed);
  };
  const cancel = () => {
    controller.abort();
    detach();
    finish('cancelled');
  };
  const run = async () => {
    await yieldTask(controller.signal);
    if (!current()) { cancel(); return; }
    // Events may change the camera/readiness before this continuation runs.
    if (!ready()) {
      started = false;
      return;
    }
    detach();
    // Navigation makes DZI refinement foreground work again. Terminating
    // this optional worker also stops its archive downloads and validation.
    viewer.addHandler?.('viewport-change', cancel);
    viewer.addHandler?.('before-destroy', cancel);
    startedAt = performance.now();
    console.info('[Dynamic assets] Daily warmup started', { sinceNavigationMs: startedAt });
    const failure = (error: unknown) => {
      failures++;
      if (current()) (options.onFailure ?? ((e) =>
        console.warn('[Dynamic assets] Optional preparation failed:', e)))(error);
    };
    const stages = options.stages ?? [
      () => prepareDailyAssetsOffThread({
        baseUrl: new URL('./', document.baseURI || location.href).href,
        fullPixels: useRenderPerfGeneration(),
      }, controller.signal, failure),
    ];
    // Even worker-side GL compilation can contend with the browser's GPU
    // process/compositor. Daily preparation caches bytes only; live requests
    // own context creation and shader compilation.
    for (const [index, stage] of stages.entries()) {
      if (index) await yieldTask(controller.signal);
      if (!current()) { finish('cancelled'); return; }
      try {
        await stage();
      } catch (error) {
        if (current()) failure(error);
      }
    }
    finish(current() ? 'finished' : 'cancelled');
    if (current()) void reportTerrainStorageUsage(controller.signal);
  };
  const ready = () => {
    if (document.hidden || viewer.isAnimating?.() || !metadataReady) return false;
    const world = viewer.world;
    if (!world) return false;
    let baked = 0;
    for (let i = 0; i < world.getItemCount(); i++) {
      const item = world.getItemAt(i);
      if (item.source?.__bakedDzi) baked++;
      // OSD's aggregate includes offscreen worlds that may never load. Check
      // only visible items, while separately waiting for every DZI to attach.
      if (item.getDrawArea() && (!item.getFullyLoaded()
        || (item.source?.__bakedDzi && item.needsDraw?.()))) return false;
    }
    return baked >= (options.expectedBakedImages ?? 1);
  };
  function check() {
    if (!current()) { cancel(); return; }
    if (started || !painted) return;
    if (!ready()) return;
    started = true;
    void run().catch(failed);
  }
  function failed(error: unknown) {
    detach();
    if (current()) {
      failures++;
      finish('failed');
      (options.onFailure ?? (e => console.warn('[Dynamic assets] Optional preparation failed:', e)))(error);
    } else finish('cancelled');
  }
  function changed() {
    if (queued || controller.signal.aborted) return;
    queued = true;
    // OSD emits tile/loading events inside its draw. Inspect state after that
    // draw has called setDrawn(), without a timer or a self-scheduling loop.
    queueMicrotask(() => { queued = false; check(); });
  }
  function watch(item: any) {
    if (watched.has(item)) return;
    watched.add(item);
    item.addHandler?.('fully-loaded-change', changed);
    item.addHandler?.('bounds-change', changed);
  }
  function unwatch(item: any) {
    item.removeHandler?.('fully-loaded-change', changed);
    item.removeHandler?.('bounds-change', changed);
    watched.delete(item);
  }
  function added(event: any) {
    watch(event.item);
    changed();
  }
  function removed(event: any) {
    unwatch(event.item);
    changed();
  }
  function drawn(event: any) {
    if (!current()) {
      cancel();
      return;
    }
    if (started || !event.tiledImage?.source?.__bakedDzi) return;
    painted = true;
    changed();
  }
  viewer.addHandler?.("tile-drawn", drawn);
  for (const name of viewerEvents) viewer.addHandler?.(name, changed);
  viewer.addHandler?.('before-destroy', cancel);
  viewer.world?.addHandler?.('add-item', added);
  viewer.world?.addHandler?.('remove-item', removed);
  document.addEventListener('visibilitychange', changed);
  for (let i = 0; i < (viewer.world?.getItemCount() ?? 0); i++) watch(viewer.world.getItemAt(i));
  options.metadataReady?.then(() => {
    metadataReady = true;
    changed();
  }, error => { failed(error); cancel(); });
  return cancel;
}
