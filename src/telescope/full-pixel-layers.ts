import { mountTerrainViewport, renderTerrainFrame, type TerrainRegion } from "./terrain-viewport";
import { LiveTerrainView, LiveTerrainUnavailable } from './live-terrain-view';
import { prepareTerrainPlane } from "./terrain-planes";
import {
  WORLD_HEIGHT,
  WORLD_TOP,
  type VerticalPlane,
} from "./terrain-policy";
import {
  clearGLTerrain,
  ensureGLTerrain,
  createGLTerrainTileSource,
  type GLTerrainGeneration,
  type GLTerrainDeps,
} from "./gl-terrain-tile-source";
export { clearGLTerrain };

/** The same three planes and ownership masks as the native daily renderer. */
export async function addFullPixelLayers(
  viewer: any,
  generation: GLTerrainGeneration & { parallelWorlds?: number[] },
  deps: GLTerrainDeps,
  isCurrent: () => boolean,
  onItem: (item: any, removed?: boolean) => void,
  firstPaint?: () => void,
) {
  clearGLTerrain();
  const osd = viewer.viewer || viewer;
  const width = deps.getWorldSize(generation.isNGP, generation.gameMode);
  const w = width * 512,
    h = WORLD_HEIGHT;
  const pws = [...(generation.parallelWorlds ?? [0, -1, 1])].sort(
    (a, b) => Math.abs(a) - Math.abs(b),
  );
  const regions: TerrainRegion[] = [];
  const fallbackRegions: TerrainRegion[] = [];
  // Prepare only planes the current camera actually needs. The renderer setup
  // uses shared GPU state, so different planes initialize in order, not at once.
  let initialization: Promise<unknown> = Promise.resolve();
  // Vertical worlds have host-only geometry and elevator rules. Retain their
  // renderer until those rules are available in TerrainView; the main world
  // never enters this native tile path.
  for (const plane of [0, -1, 1] as VerticalPlane[]) {
    let ready: Promise<Map<number, any>> | undefined;
    const sources = () => {
      if (ready) return ready;
      const job = initialization.then(async () => {
        const gen = await prepareTerrainPlane(generation, plane);
        if (!isCurrent()) throw new DOMException("Seed changed", "AbortError");
        if (!(await ensureGLTerrain(deps, gen)))
          throw new Error(`Full-resolution terrain failed for vertical plane ${plane}`);
        if (!isCurrent()) throw new DOMException("Seed changed", "AbortError");
        return new Map(pws.map(pw => [pw, createGLTerrainTileSource({
          deps, gen, pw, worldX: -width * 256 + pw * w,
          worldY: WORLD_TOP + plane * h, worldW: w, worldH: h,
          getFocus: () => osd.viewport.getCenter(true),
        })]));
      });
      // One failed initialization must not poison all later planes or retries.
      initialization = job.catch(() => {});
      ready = job.catch(error => { ready = undefined; throw error; });
      return ready;
    };
    for (const pw of pws) {
      (plane === 0 ? fallbackRegions : regions).push({
        nativeOnly: true,
        x: -width * 256 + pw * w, y: WORLD_TOP + plane * h, width: w, height: h,
        source: {
          maxLevel: Math.ceil(Math.log2(Math.max(w, h))),
          async getFinalTile(level, x, y, signal) {
            signal.throwIfAborted();
            const source = (await sources()).get(pw);
            signal.throwIfAborted();
            return source.getFinalTile(level, x, y, signal);
          },
        },
      });
    }
  }
  let live: LiveTerrainView | undefined;
  let useFallback = false;
  const reset = () => { live?.dispose(); window.removeEventListener('fullPixelTerrainReset', reset); };
  if (isCurrent()) {
    window.addEventListener('fullPixelTerrainReset', reset);
    mountTerrainViewport(viewer, async (bounds, scale, signal) => {
      const frame = document.createElement('canvas');
      frame.width = Math.max(1, Math.ceil(bounds.width * scale));
      frame.height = Math.max(1, Math.ceil(bounds.height * scale));
      const context = frame.getContext('2d')!;
      const top = Math.max(0, Math.floor((WORLD_TOP - bounds.y) * scale));
      const bottom = Math.min(frame.height, Math.ceil((WORLD_TOP + h - bounds.y) * scale));
      if (bottom > top) {
        const mainBounds = { ...bounds, y: bounds.y + top / scale, height: (bottom - top) / scale };
        let main: HTMLCanvasElement;
        try {
          if (useFallback) throw new LiveTerrainUnavailable();
          live ??= new LiveTerrainView(generation, deps);
          main = await live.render(mainBounds, scale, signal);
        } catch (error) {
          if (!(error instanceof LiveTerrainUnavailable)) throw error;
          if (!useFallback) console.warn('[TerrainView] WebGL2 unavailable; using the CPU worker renderer', error.message);
          useFallback = true; live?.dispose(); live = undefined;
          main = await renderTerrainFrame(fallbackRegions, mainBounds, scale, signal);
        }
        signal.throwIfAborted();
        context.save(); context.beginPath();
        for (const pw of pws) context.rect((-width * 256 + pw * w - bounds.x) * scale,
          (WORLD_TOP - bounds.y) * scale, w * scale, h * scale);
        context.clip(); context.drawImage(main, 0, top); context.restore();
      }
      if (bounds.y < WORLD_TOP || bounds.y + bounds.height > WORLD_TOP + h) {
        const vertical = await renderTerrainFrame(regions, bounds, scale, signal);
        signal.throwIfAborted(); context.drawImage(vertical, 0, 0);
      }
      return frame;
    }, isCurrent, onItem, firstPaint);
  }
}
