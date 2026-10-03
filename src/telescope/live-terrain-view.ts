import Flatbush from 'flatbush';
// @ts-ignore upstream's supported embedding API
import { TerrainView, applyTerrainSettings, drawSpace } from 'noita-telescope-full-pixels/terrain_view.js';
// @ts-ignore upstream JavaScript
import { drawEdgeDecals } from 'noita-telescope-full-pixels/edge_decal_layer.js';
// @ts-ignore upstream JavaScript
import { reviveTerrainCpuResources } from 'noita-telescope-full-pixels/gl/terrain_cpu_resources.js';
// @ts-ignore upstream JavaScript
import { syncOverlayPoolMetadata, syncOverlayPoolWorld } from 'noita-telescope-full-pixels/overlay_worker_pool.js';
import { buildTerrainInWorker } from './terrain-resource-client';
import { createLiveBackground } from './live-terrain-background';
import { loadLiquidMaterialIds } from './liquid-surfaces';
import { createTerrainRenderer } from './terrain-context';
import { createPlaneOwnership } from './terrain-policy';
import type { GLTerrainGeneration, GLTerrainDeps } from './gl-terrain-tile-source';
import type { TerrainRect } from './terrain-viewport';
import { LiveTerrainUnavailable } from './live-terrain-error';
export { LiveTerrainUnavailable };

const canvas = (width: number, height: number) => {
  const value = document.createElement('canvas'); value.width = width; value.height = height; return value;
};
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 16));
const cameraIdle = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 200);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});
const measure = (name: string, start: number) => {
  performance.clearMeasures(name); performance.measure(name, { start });
};

/** One retained GPU world, shaded directly at the camera's screen resolution.
 * There are no native terrain leaves or pyramid ancestors on this path. */
export class LiveTerrainView {
  private view: any;
  private ready: Promise<void>;
  private worker?: Worker;
  private lifetime = new AbortController();
  private compose!: Awaited<ReturnType<typeof createLiveBackground>>;
  private queue: Promise<unknown> = Promise.resolve();
  private pws: number[];
  private width: number;
  private sceneIndex?: Flatbush;
  private frames = new Map<string, HTMLCanvasElement>();
  private frameBytes = 0;
  private ownership: ReturnType<typeof createPlaneOwnership>;
  constructor(private gen: GLTerrainGeneration & { parallelWorlds?: number[] }, private deps: GLTerrainDeps) {
    applyTerrainSettings({ engineTerrain: true, materialTextures: true, recolorMaterials: true, clearSpawnPixels: true, edgeDecals: true });
    this.view = new TerrainView();
    // Preserve the host's default-GPU retry when high-performance is refused.
    this.view.terrain = createTerrainRenderer(deps.GLTerrainRenderer, () => {});
    this.width = deps.getWorldSize(gen.isNGP, gen.gameMode);
    this.pws = gen.parallelWorlds ?? [0, -1, 1];
    this.ownership = createPlaneOwnership(gen.tileLayers, gen.biomeData.pixels, gen.biomeData.pixels, deps.GENERATOR_CONFIG, this.width);
    const scenes = gen.sceneData?.scenes ?? [];
    if (scenes.length) {
      this.sceneIndex = new Flatbush(scenes.length);
      for (const scene of scenes) this.sceneIndex.add(scene.x, scene.y, scene.x + scene.width, scene.y + scene.height);
      this.sceneIndex.finish();
    }
    this.ready = this.prepare();
    // Requests observe errors; preparing before the first camera is safe too.
    void this.ready.catch(() => {});
  }
  private async prepare() {
    const start = performance.now();
    const options = this.view.buildOptions({ engineTerrain: true });
    if (!options) throw new LiveTerrainUnavailable(this.view.failed || 'WebGL2 unavailable');
    const signal = this.lifetime.signal;
    const liquidIds = [...await loadLiquidMaterialIds()]; signal.throwIfAborted();
    measure('terrain:liquid-data', start);
    const worker = this.worker = new Worker(new URL('./live-terrain-worker.ts', import.meta.url), { type: 'module' });
    const build = buildTerrainInWorker(worker, {
      generation: { tileLayers: this.gen.tileLayers, biomeData: this.gen.biomeData,
        seed: this.gen.seed, isNGP: this.gen.isNGP, gameMode: this.gen.gameMode }, options, liquidIds,
    }, signal).finally(() => { if (this.worker === worker) this.worker = undefined; });
    const timed = async <T>(label: string, work: Promise<T>) => {
      const start = performance.now(); const value = await work;
      measure(label, start); return value;
    };
    const [resource, compose] = await Promise.all([timed('terrain:resources', build), timed('terrain:background', createLiveBackground(this.gen, this.deps))]);
    signal.throwIfAborted(); this.compose = compose;
    const scenes: Record<string, any[]> = {};
    // Empty neighbours let decal halos at the supported world's outer edge finish.
    for (let pw = Math.min(...this.pws) - 1; pw <= Math.max(...this.pws) + 1; pw++) scenes[`${pw},0`] = [];
    for (const scene of this.gen.sceneData?.scenes ?? []) {
      const pw = Math.floor((scene.x + this.width * 256) / (this.width * 512));
      (scenes[`${pw},0`] ??= []).push(scene);
    }
    this.view.setWorld({ ...this.gen, ngPlusCount: this.gen.ngPlus ?? 0,
      generatorConfig: this.deps.GENERATOR_CONFIG, scenes,
      terrainResources: reviveTerrainCpuResources(resource.cpu) });
    syncOverlayPoolMetadata();
    syncOverlayPoolWorld(this.gen.biomeData);
    await this.view.prepare({ engineTerrain: true }); signal.throwIfAborted();
    if (!this.view.ready) throw new Error(this.view.failed || 'TerrainView preparation failed');
    const terrain = this.view.terrain, gl = terrain.gl;
    const uniform = gl.getUniformLocation(terrain.program, 'u_hostTable');
    if (uniform === null) throw new Error('Host terrain policy shader was not installed');
    gl.useProgram(terrain.program); gl.uniform1i(uniform, resource.hostTable);
    measure('terrain:prepare', start);
    // Retain the packed resources for context restoration as well as reseeding.
  }
  render(bounds: TerrainRect, scale: number, signal: AbortSignal, publish?: (frame: HTMLCanvasElement) => void) {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    // TerrainView owns mutable GPU state. A superseded camera exits before the
    // next one can use it; aborted work never disposes the retained world.
    const result = this.queue.then(async () => {
      await this.ready; combined.throwIfAborted();
      const key = [bounds.x, bounds.y, bounds.width, bounds.height, scale].join('/');
      const cached = this.frames.get(key);
      if (cached) { this.frames.delete(key); this.frames.set(key, cached); return cached; }
      const frame = await this.frame(bounds, scale, combined, publish);
      const bytes = frame.width * frame.height * 4, budget = 32 * 1024 * 1024;
      if (bytes <= budget) {
        this.frames.set(key, frame); this.frameBytes += bytes;
        while (this.frameBytes > budget || this.frames.size > 8) {
          const oldest = this.frames.keys().next().value!, image = this.frames.get(oldest)!;
          this.frameBytes -= image.width * image.height * 4; this.frames.delete(oldest);
        }
      }
      return frame;
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private async frame(bounds: TerrainRect, scale: number, signal: AbortSignal, publish?: (frame: HTMLCanvasElement) => void) {
    const width = Math.max(1, Math.ceil(bounds.width * scale)), height = Math.max(1, Math.ceil(bounds.height * scale));
    const offset = drawSpace(this.gen.isNGP, this.gen.gameMode);
    const camera = { width, height, camX: bounds.x + width / scale / 2 + offset.x,
      camY: bounds.y + height / scale / 2 + offset.y, camZ: scale,
      worlds: this.pws.map(pw => `${pw},0`), detailZoom: Infinity,
      materialTextures: true, engineTerrain: true, offscreen: true, edgeDecals: false };
    let progressedAt = performance.now(), lastProgress = '';
    const check = (progress?: string) => {
      signal.throwIfAborted();
      if (progress !== undefined && progress !== lastProgress) { lastProgress = progress; progressedAt = performance.now(); }
      if (performance.now() - progressedAt > 120_000) throw new Error('Terrain detail stopped progressing while waiting for scene/decal data');
    };
    let lastPublished = -Infinity;
    const snapshot = (source: HTMLCanvasElement, decals?: HTMLCanvasElement) => {
      const start = performance.now();
      const image = canvas(width, height), context = image.getContext('2d')!;
      context.drawImage(source, 0, 0);
      if (decals) context.drawImage(decals, 0, 0);
      const value = this.compose(image, bounds, scale);
      measure('terrain:compose', start); return value;
    };
    const show = (source: HTMLCanvasElement, decals?: HTMLCanvasElement) => {
      if (!publish || performance.now() - lastPublished < 150) return;
      signal.throwIfAborted();
      publish(snapshot(source, decals));
      lastPublished = performance.now();
    };
    // Terrain shading is already final-resolution here. Scene/decal workers
    // refine it independently; do not hide terrain until every worker finishes.
    if (publish) {
      const start = performance.now();
      const base = this.view.render({ ...camera, scenes: false });
      measure('terrain:base', start);
      if (!base) throw new Error(this.view.failed || 'TerrainView render failed');
      show(base.canvas);
      await cameraIdle(signal);
    }
    let result: any;
    do {
      check(); result = this.view.render(camera);
      if (!result) throw new Error(this.view.failed || 'TerrainView render failed');
      check(`scenes/${result.detail.sceneStandIns}/${result.detail.scenesMissing}/${this.view.scenes.bytes}`);
      show(result.canvas);
      if (!result.detail.sceneStandIns && !result.detail.scenesMissing && !this.view.sceneUploadsPending) break;
      await tick();
    } while (true);
    const foreground = canvas(width, height), fg = foreground.getContext('2d')!;
    fg.drawImage(result.canvas, 0, 0);

    // Keep completed decals in screen space while native cache slots recycle.
    // Otherwise a zoomed-out view larger than 768 tiles can NEVER be complete.
    const accumulated = canvas(width, height), ctx = accumulated.getContext('2d')!;
    const seen = new Set<string>(), decals = this.view.decals;
    const has = decals.has.bind(decals), draw = decals.draw.bind(decals);
    const needed = (key: string) => {
      const [tx, ty] = key.split(',').map(Number), x = tx * 256, y = ty * 256;
      if (y + 256 <= -7168 || y >= 17408) return false;
      if (!this.pws.includes(Math.floor((x + this.width * 256) / (this.width * 512)))) return false;
      if (this.ownership.at(x, y) >= 0 || this.ownership.at(x + 255, y + 255) >= 0) return true;
      return !!this.sceneIndex?.search(x, y, x + 256, y + 256).length;
    };
    const skipped = new Set<string>();
    decals.has = (key: string) => {
      if (seen.has(key) || skipped.has(key) || has(key)) return true;
      if (!needed(key)) { skipped.add(key); return true; }
      return false;
    };
    decals.draw = (terrain: any, args: any) => {
      const tiles = args.tiles.filter((t: any) => !seen.has(t.key) && !skipped.has(t.key) && has(t.key));
      if (!tiles.length) return;
      draw(terrain, { ...args, tiles });
      ctx.drawImage(terrain.canvas, 0, 0);
      for (const tile of tiles) seen.add(tile.key);
    };
    try {
      do {
        check();
        this.view.render({ ...camera, terrain: false, scenes: false });
        drawEdgeDecals(this.view.terrain, decals, this.view.world, camera, ++this.view.frame);
        if (decals.failed) throw new Error(decals.failed);
        check(`decals/${seen.size}/${decals.missingInView}`);
        show(foreground, accumulated);
        if (!decals.missingInView) break;
        await tick();
      } while (true);
    } finally { decals.has = has; decals.draw = draw; }
    fg.drawImage(accumulated, 0, 0);
    return this.compose(foreground, bounds, scale);
  }
  dispose() {
    this.lifetime.abort(); this.worker?.terminate();
    this.frames.clear(); this.frameBytes = 0;
    // Let a running draw unwind before disposing its context.
    void Promise.allSettled([this.ready, this.queue]).then(() => this.view.dispose());
  }
}
