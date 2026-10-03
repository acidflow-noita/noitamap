import { mountTerrainViewport, renderTerrainFrame, type TerrainRegion } from "./terrain-viewport";
import { LiveTerrainView, LiveTerrainUnavailable } from './live-terrain-view';
import { LiveTerrainClient } from './live-terrain-client';
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
  let live: LiveTerrainView | LiveTerrainClient | undefined;
  let useFallback = false;
  const reset = () => { live?.dispose(); window.removeEventListener('fullPixelTerrainReset', reset); };
  if (isCurrent()) {
    window.addEventListener('fullPixelTerrainReset', reset);
    let painted = false;
    const visiblePaint = () => { if (!painted) { painted = true; firstPaint?.(); } };
    const extent = (plane: number) => ({ x: -width * 256 + Math.min(...pws) * w,
      y: WORLD_TOP + plane * h, width: (Math.max(...pws) - Math.min(...pws) + 1) * w, height: h });
    // Main-world GPU pixels can be displayed as soon as ready. Each vertical
    // plane has its own cancellable work; neither can hold the main frame.
    mountTerrainViewport(viewer, async (bounds, scale, signal, publish) => {
      try {
        if (useFallback) throw new LiveTerrainUnavailable();
        live ??= typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined'
          ? new LiveTerrainClient(generation) : new LiveTerrainView(generation, deps);
        return await live.render(bounds, scale, signal, publish);
      } catch (error) {
        if (!(error instanceof LiveTerrainUnavailable)) throw error;
        if (!useFallback) console.warn('[TerrainView] WebGL2 unavailable; using the CPU worker renderer', error.message);
        useFallback = true; live?.dispose(); live = undefined;
        return renderTerrainFrame(fallbackRegions, bounds, scale, signal, publish);
      }
    }, isCurrent, onItem, visiblePaint, extent(0));
    for (const plane of [-1, 1]) {
      const region = regions.filter(r => r.y === WORLD_TOP + plane * h);
      mountTerrainViewport(viewer, (bounds, scale, signal, publish) => renderTerrainFrame(region, bounds, scale, signal, publish),
        isCurrent, onItem, visiblePaint, extent(plane));
    }
  }
}
