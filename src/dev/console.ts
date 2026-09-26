import { getLastGenerationResult } from '../dynamic-map';
import { exportBiomeRegionImages, prepareDecorationExport, exportDecorationCell, releaseDecorationExport } from '../telescope/telescope-osd-bridge';
import { getStoredRenderer, setStoredRenderer, clearStoredRenderer } from '../renderer_settings';

/** Console and browser-baker hooks. Loaded only on development hosts. */
export function installDevCommands(): void {
  (window as any).noitamap = {
    enableDrawing: () => {
      localStorage.setItem("noitamap-dev-drawing", "1");
      console.log("Drawing dev mode enabled. Refresh and open the sidebar.");
    },
    disableDrawing: () => {
      localStorage.removeItem("noitamap-dev-drawing");
      console.log("Drawing dev mode disabled. Refresh to hide the sidebar.");
    },
    exportData: () => {
      const result = getLastGenerationResult();
      if (!result) {
        console.warn("No dynamic generation data available to export.");
        return;
      }
      // Prepare serializable copy
      const exportable = {
        seed: result.seed,
        ngPlus: result.ngPlus,
        isNGP: result.isNGP,
        worldSize: result.worldSize,
        worldCenter: result.worldCenter,
        poisByPW: Object.entries(result.poisByPW).reduce((acc, [pw, pois]) => {
          acc[pw] = pois.map((p) => {
            const { x, y, type, ...rest } = p;
            return { x, y, type, data: rest };
          });
          return acc;
        }, {} as any),
        pixelScenesByPW: Object.entries(result.pixelScenesByPW).reduce((acc, [pw, scenes]) => {
          acc[pw] = scenes.map((s) => ({ x: s.x, y: s.y, name: s.name, key: s.key }));
          return acc;
        }, {} as any),
        eyes: result.eyes,
        parallelWorlds: result.parallelWorlds,
        biomes: result.tileLayers.map((l) => ({ name: l.biomeName, x: l.correctedX, y: l.correctedY, w: l.w, h: l.h })),
      };
      const blob = new Blob([JSON.stringify(exportable, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `noitamap-seed-${result.seed}.json`;
      a.click();
      URL.revokeObjectURL(url);
      console.log(`Exported data for seed ${result.seed}`);
    },
    // Biomes are ready once a full render has completed (lastResult is set
    // after renderGenerationResult, which awaits the biome pass). Used by
    // build-daily-seed-images.cjs to wait for biomes, not POIs.
    biomesReady: () => {
      const r = getLastGenerationResult();
      return !!(r && r.tileLayers && r.tileLayers.length);
    },
    /** Raw generation result, for console inspection and debug harnesses. */
    getGeneration: () => getLastGenerationResult(),
    exportBiomeRegions: async () => {
      const result = getLastGenerationResult();
      if (!result) return null;
      return exportBiomeRegionImages(result);
    },
    // Serialized generation result (POIs, pixel scenes, biome map) for the
    // bake pipeline. build-daily-seed-images.cjs writes this as
    // generation.json; stitch-dzis.cjs splits it per world; the live map
    // loads it from the static workers and skips telescope entirely.
    exportGenerationData: async () => {
      const result = getLastGenerationResult();
      if (!result) return null;
      const { serializeGenerationForBake } = await import("../telescope/baked-generation");
      return serializeGenerationForBake(result);
    },
    // Decoration bake (pixel scenes + POI marker sprites) at native scale.
    // build-daily-seed-images.cjs calls prepareDecorationExport() once, then
    // exportDecorationCell(cx, cy) per non-empty 2048px world-grid cell; the
    // upscale step composites those cells onto the region fulls before stitch,
    // so the deployed pyramids carry scenes + creatures in their pixels.
    prepareDecorationExport: async () => {
      const result = getLastGenerationResult();
      if (!result) return null;
      return prepareDecorationExport(result);
    },
    exportDecorationCell: (cx: number, cy: number) => exportDecorationCell(cx, cy),
    releaseDecorationExport: () => releaseDecorationExport(),
    // Dev-only OSD drawer override. Default everywhere is "canvas" (the prod
    // setting in renderer_settings.ts). On localhost/dev.noitamap.com this
    // hook flips it via localStorage so we can A/B test perf and baked-DZI
    // edge fringing at zoom without shipping webgl to users.
    //   noitamap.setRenderer("webgl")  -> opt in, reload page
    //   noitamap.setRenderer("canvas") -> opt back to default, reload
    //   noitamap.getRenderer()         -> see what the next reload will use
    //   noitamap.clearRenderer()       -> wipe override, fall back to default
    setRenderer: (r: "canvas" | "webgl") => {
      if (r !== "canvas" && r !== "webgl") {
        console.warn('Use "canvas" or "webgl"'); return;
      }
      setStoredRenderer(r);
      console.log(`[Noitamap] Renderer set to "${r}". Reload the page to apply.`);
    },
    getRenderer: () => getStoredRenderer(),
    clearRenderer: () => {
      clearStoredRenderer();
      console.log("[Noitamap] Renderer override cleared. Reload to use the default.");
    },
  };
  console.log('[Noitamap] Dev mode detected, "noitamap" commands available.');
}

