import catalog from './effects.json' with { type: 'json' };
import { decodeAssets, SourceSimulation } from './runtime/effect-simulation.mjs';
import { GpuGridRenderer } from './runtime/gpu-grid-renderer.mjs';

export const SUN_GPU_BUDGET = 128 * 1024 * 1024;
export const SUN_SIZE = 1536;
const OPTIONS = { core: true, glow: true, transparent: true, smoothGlow: true };
const OUTPUT_SIZES = [256, 512, 768, 1024, SUN_SIZE];

function outputSizeFor(pixels, previous) {
  const desired = Number.isFinite(pixels) && pixels > 0 ? pixels : SUN_SIZE;
  const size = OUTPUT_SIZES.find(size => size >= desired) ?? SUN_SIZE;
  // Avoid reallocating on every tiny zoom change near a bucket boundary.
  return previous && size < previous && desired > previous * .5 ? previous : size;
}

/** Dust's renderer, restricted to two retained simulations and a 1536px output.
 * A frame contains the entire figure, so pausing and zooming out cannot expose
 * the cut edge of an old viewport crop. OSD reprojection happens in CSS. */
export class SunRenderer {
  constructor(buffer, seed, lighting = true) {
    this.resources = decodeAssets(catalog, buffer);
    this.seed = seed;
    this.options = { ...OPTIONS, lighting };
    this.entries = new Map();
    this.renderer = new GpuGridRenderer(this.resources, catalog);
    if (this.renderer.maxTextureSize < SUN_SIZE) { this.renderer.dispose(); throw new Error('Sun render surface unsupported'); }
    this.renderer.maxTextureSize = SUN_SIZE;
    this.renderer.setView(SUN_SIZE, SUN_SIZE);
    this.assetBytes = Object.values(this.resources.assets).reduce((sum, asset) => sum + asset.rgba.byteLength, 0);
    this.draws = 0;
    this.gpuMS = null;
    this.queries = [];
    this.timer = this.renderer.gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }
  entry(effect, x, y) {
    if (!Object.hasOwn(catalog.effects, effect)) throw new Error('Unknown Sun effect');
    let entry = this.entries.get(effect);
    if (!entry) {
      const simulation = new SourceSimulation({ effect, worldSeed: this.seed, x, y, retainInvisible: false },
        catalog.effects[effect], this.resources, catalog);
      // Build a mature particle population before showing the first frame.
      // This runs once in the worker, never when resuming a paused Sun.
      for (let frame = 0; frame < 144; frame++) simulation.step();
      entry = { simulation, warm: true, outputSize: 0, remainderMS: 0 };
      this.entries.set(effect, entry);
      this.renderer.histories.set(effect, this.renderer.target());
      this.renderer.configureParticles(this.entries, true);
    }
    return entry;
  }
  render(effect, x, y, elapsedMS, pixels) {
    const started = performance.now(), r = this.renderer, gl = r.gl;
    if (r.lost) throw new Error('Sun WebGL context lost');
    const entry = this.entry(effect, x, y);
    const outputSize = entry.outputSize = outputSizeFor(pixels, entry.outputSize);
    const warm = entry.warm;
    // No wall-clock catch-up after a pause. Resume the exact retained state.
    // Preserve sub-frame time, but never replay the wall-clock gap of a pause.
    if (elapsedMS === 0) entry.remainderMS = 0;
    const elapsed = Math.max(0, Number.isFinite(elapsedMS) ? elapsedMS : 0);
    const available = Math.min(1000 / 30, entry.remainderMS + elapsed);
    const steps = warm ? 30 : Math.min(2, Math.floor(available / (1000 / 60) + 1e-6));
    entry.remainderMS = warm ? 0 : Math.max(0, available - steps * (1000 / 60));
    const ext = this.timer;
    if (ext) {
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      while (this.queries.length && gl.getQueryParameter(this.queries[0], gl.QUERY_RESULT_AVAILABLE)) {
        const query = this.queries.shift();
        if (!disjoint) this.gpuMS = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(query);
      }
      if (disjoint) this.gpuMS = null;
    }
    const query = ext && this.queries.length < 4 ? gl.createQuery() : null;
    if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    try {
      r.begin(outputSize, outputSize, 0, true);
      for (let frame = 0; frame < steps; frame++) {
        entry.simulation.step();
        r.render(entry.simulation, effect, this.options, true);
      }
      if (!steps) r.render(entry.simulation, effect, this.options, false);
      r.compose(effect, { x: 0, y: 0, width: outputSize, imageHeight: outputSize }, true);
    } finally {
      if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); this.queries.push(query); }
    }
    entry.warm = false;
    this.draws++;
    const stats = { ...this.stats(), cpuMS: performance.now() - started, steps, warm };
    if (stats.estimatedGPUBytes > SUN_GPU_BUDGET) throw new Error('Sun GPU memory budget exceeded');
    return stats;
  }
  stats() {
    const r = this.renderer;
    let particles = 0, buffers = 0;
    for (const pool of r.particles?.pools.values() ?? []) { particles += pool.live; buffers += pool.capacity * 128; }
    const targets = [...r.targets].reduce((sum, target) => sum + target.width * target.height * 4, 0);
    return { particles, estimatedGPUBytes: this.assetBytes + buffers + targets + r.canvas.width * r.canvas.height * 4 +
      (r.instanceBufferBytes ?? 0) + (r.glowDitherBytes ?? 0),
    gpuMS: this.gpuMS, draws: this.draws, retainedSuns: this.entries.size, device: String(r.deviceInfo),
    outputSize: r.canvas.width, outputPixels: r.canvas.width * r.canvas.height };
  }
  finish() { return this.renderer.finish(); }
  dispose() {
    for (const query of this.queries) this.renderer.gl.deleteQuery(query);
    this.renderer.dispose(); this.entries.clear();
  }
}
