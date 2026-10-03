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

const canvas = (width: number, height: number) => {
  const value = document.createElement('canvas'); value.width = width; value.height = height; return value;
};
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 16));
export class LiveTerrainUnavailable extends Error {}

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
  private ownership: ReturnType<typeof createPlaneOwnership>;
  constructor(private gen: GLTerrainGeneration & { parallelWorlds?: number[] }, private deps: GLTerrainDeps) {
    applyTerrainSettings({ engineTerrain: true, materialTextures: true, recolorMaterials: true, clearSpawnPixels: true, edgeDecals: true });
    this.view = new TerrainView();
    // Preserve the host's default-GPU retry when high-performance is refused.
    this.view.terrain = createTerrainRenderer(deps.GLTerrainRenderer, () => {});
    this.width = deps.getWorldSize(gen.isNGP, gen.gameMode);
    this.pws = gen.parallelWorlds ?? [0, -1, 1];
    this.ownership = createPlaneOwnership(gen.tileLayers, gen.biomeData.pixels, gen.biomeData.pixels, deps.GENERATOR_CONFIG, this.width);
    this.ready = this.prepare();
    // Requests observe errors; preparing before the first camera is safe too.
    void this.ready.catch(() => {});
  }
  private async prepare() {
    const options = this.view.buildOptions({ engineTerrain: true });
    if (!options) throw new LiveTerrainUnavailable(this.view.failed || 'WebGL2 unavailable');
    const signal = this.lifetime.signal;
    const liquidIds = [...await loadLiquidMaterialIds()]; signal.throwIfAborted();
    const worker = this.worker = new Worker(new URL('./live-terrain-worker.ts', import.meta.url), { type: 'module' });
    const build = buildTerrainInWorker(worker, {
      generation: { tileLayers: this.gen.tileLayers, biomeData: this.gen.biomeData,
        seed: this.gen.seed, isNGP: this.gen.isNGP, gameMode: this.gen.gameMode }, options, liquidIds,
    }, signal).finally(() => { if (this.worker === worker) this.worker = undefined; });
    const [resource, compose] = await Promise.all([build, createLiveBackground(this.gen, this.deps)]);
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
    // Retain the packed resources for context restoration as well as reseeding.
  }
  render(bounds: TerrainRect, scale: number, signal: AbortSignal) {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    // TerrainView owns mutable GPU state. A superseded camera exits before the
    // next one can use it; aborted work never disposes the retained world.
    const result = this.queue.then(async () => {
      await this.ready; combined.throwIfAborted();
      return this.frame(bounds, scale, combined);
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private async frame(bounds: TerrainRect, scale: number, signal: AbortSignal) {
    const width = Math.max(1, Math.ceil(bounds.width * scale)), height = Math.max(1, Math.ceil(bounds.height * scale));
    const offset = drawSpace(this.gen.isNGP, this.gen.gameMode);
    const camera = { width, height, camX: bounds.x + width / scale / 2 + offset.x,
      camY: bounds.y + height / scale / 2 + offset.y, camZ: scale,
      worlds: this.pws.map(pw => `${pw},0`), detailZoom: Infinity,
      materialTextures: true, engineTerrain: true, offscreen: true, edgeDecals: false };
    const started = performance.now();
    const check = () => {
      signal.throwIfAborted();
      if (performance.now() - started > 120_000) throw new Error('Full-detail viewport timed out while waiting for scene/decal data');
    };
    let result: any;
    do {
      check(); result = this.view.render(camera);
      if (!result) throw new Error(this.view.failed || 'TerrainView render failed');
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
      return (this.gen.sceneData?.scenes ?? []).some(s => s.x < x + 256 && s.x + s.width > x && s.y < y + 256 && s.y + s.height > y);
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
        if (!decals.missingInView) break;
        await tick();
      } while (true);
    } finally { decals.has = has; decals.draw = draw; }
    fg.drawImage(accumulated, 0, 0);
    return this.compose(foreground, bounds, scale);
  }
  dispose() {
    this.lifetime.abort(); this.worker?.terminate();
    // Let a running draw unwind before disposing its context.
    void Promise.allSettled([this.ready, this.queue]).then(() => this.view.dispose());
  }
}
