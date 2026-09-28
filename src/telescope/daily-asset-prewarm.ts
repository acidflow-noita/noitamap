import { backgroundAssetYield } from "./background-idle";
import { reportTerrainStorageUsage } from "./terrain-storage-usage";
import { isInstantTerrainEnabled, useRenderPerfGeneration } from "../renderer_settings";
import { prepareDailyAssetsOffThread } from './daily-asset-worker-client';

export interface DailyAssetWarmupOptions {
  viewer: any;
  isCurrent(): boolean;
  /** Injectable stages keep scheduling/lifecycle tests independent of WebGL. */
  stages?: (() => Promise<unknown> | void)[];
  yieldTask?: (signal: AbortSignal) => Promise<void>;
  onFailure?: (error: unknown) => void;
}

/** Arm before baked DZIs are added. Their first real drawn tile owns startup
 * priority; immutable preparation runs in a dedicated worker after that paint.
 * Cancellation terminates only this optional worker, never a foreground load. */
export function scheduleDailyAssetWarmup(
  options: DailyAssetWarmupOptions,
): () => void {
  const viewer = options.viewer.viewer ?? options.viewer;
  const controller = new AbortController();
  const current = () => !controller.signal.aborted && options.isCurrent();
  const yieldTask = options.yieldTask ?? backgroundAssetYield;
  let started = false;
  let startedAt: number | undefined;
  let ended = false;
  let failures = 0;
  const finish = (state: 'finished' | 'cancelled' | 'failed') => {
    if (startedAt === undefined || ended) return;
    ended = true;
    const finishedAt = performance.now();
    const elapsedMs = finishedAt - startedAt;
    console.info(`[Dynamic assets] Daily warmup ${state} in ${(elapsedMs / 1000).toFixed(2)} seconds`, {
      elapsedMs,
      sinceNavigationMs: finishedAt,
      failures,
      scope: 'Worker archive validation and immutable asset prefetch, including idle waits; seed-specific terrain cooking is separate',
      persistence: 'Optional cache writes settled or unavailable; decoded worlds are not retained',
    });
  };
  const cancel = () => {
    controller.abort();
    viewer.removeHandler?.("tile-drawn", drawn);
    finish('cancelled');
  };
  const run = async () => {
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
      async () => {
        if (!isInstantTerrainEnabled()) return;
        const started = performance.now();
        console.info('[Dynamic assets] Worker shader preparation started');
        const { prewarmInstantTerrain } = await import('./instant-terrain-backend');
        if (!current()) return;
        const ready = await prewarmInstantTerrain({ workerOnly: true });
        console.info(`[Dynamic assets] Worker shader preparation ${ready ? 'finished' : 'unavailable'} in ${((performance.now() - started) / 1000).toFixed(2)} seconds`, {
          elapsedMs: performance.now() - started,
          scope: 'Reusable worker WebGL program; no main-thread compilation or generated terrain',
        });
      },
    ];
    for (const stage of stages) {
      await yieldTask(controller.signal);
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
  function drawn(event: any) {
    if (!current()) {
      cancel();
      return;
    }
    if (started || !event.tiledImage?.source?.__bakedDzi) return;
    started = true;
    viewer.removeHandler?.("tile-drawn", drawn);
    void run().catch((error) => {
      if (current()) {
        failures++;
        finish('failed');
        (options.onFailure ?? (e => console.warn('[Dynamic assets] Optional preparation failed:', e)))(error);
      } else finish('cancelled');
    });
  }
  viewer.addHandler?.("tile-drawn", drawn);
  return cancel;
}
