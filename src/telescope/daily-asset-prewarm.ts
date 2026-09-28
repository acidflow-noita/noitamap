import { backgroundAssetYield } from "./background-idle";
import { reportTerrainStorageUsage } from "./terrain-storage-usage";
import {
  prewarmMapPresentation,
  prefetchAllSceneBitmaps,
} from "./telescope-osd-bridge";
import {
  isInstantTerrainEnabled,
  useRenderPerfGeneration,
} from "../renderer_settings";

export interface DailyAssetWarmupOptions {
  viewer: any;
  isCurrent(): boolean;
  /** Injectable stages keep scheduling/lifecycle tests independent of WebGL. */
  stages?: (() => Promise<unknown> | void)[];
  yieldTask?: (signal: AbortSignal) => Promise<void>;
  onFailure?: (error: unknown) => void;
}

function sharedAssetStages(
  isCurrent: () => boolean,
): (() => Promise<unknown> | void)[] {
  return [
    ...["main", "wang_tiles", "pixel_scenes"].map((key) => async () => {
      const { getZip } = await import("../data-archive");
      if (!(await getZip(key, true)))
        throw new Error(`Cannot prepare ${key} archive`);
    }),
    async () => {
      const { initTelescope } = await import("./telescope-adapter");
      await initTelescope({ background: true });
    },
    async () => {
      // Tables/decoded Wang inputs are reused by the next seed in this tab.
      // Their versioned source packs/ZIPs survive reloads in optional storage.
      const outcomes = await prewarmMapPresentation();
      const failed = outcomes.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      if (useRenderPerfGeneration()) {
        const { loadTelescopeModules } = await import("./load-telescope");
        const modules = await loadTelescopeModules();
        await modules.materialAtlasMod.initMaterialAtlas();
        const { initEdgeDecalAtlas } =
          await import("../../lib/noita-telescope-vm/js/edge_decals.js");
        await initEdgeDecalAtlas();
      }
    },
    async () => {
      // Compile only the reusable program. No generated world resources,
      // native tiles, POI scans, or additional PW scene copies are created.
      if (isInstantTerrainEnabled()) {
        const api = await import("./instant-terrain-backend");
        if (!(await api.prewarmInstantTerrain()))
          throw new Error(
            "GPU warmup unavailable; reusable assets remain ready",
          );
      }
    },
    async () => {
      await prefetchAllSceneBitmaps(isCurrent);
    },
  ];
}

/** Arm before baked DZIs are added. Their first real drawn tile owns startup
 * priority; immutable preparation starts in a later idle/task opportunity.
 * Cancelling only stops future stages, never another caller's shared fetch. */
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
      scope: 'Reusable asset preparation and prefetch, including idle waits; seed-specific terrain cooking is separate',
      persistence: 'Optional cache writes may still be pending or unavailable',
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
    for (const stage of options.stages ?? sharedAssetStages(current)) {
      await yieldTask(controller.signal);
      if (!current()) { finish('cancelled'); return; }
      try {
        await stage();
      } catch (error) {
        failures++;
        if (current())
          (
            options.onFailure ??
            ((e) =>
              console.warn("[Dynamic assets] Optional preparation failed:", e))
          )(error);
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
