import catalog from './assets/effects.json';
import { decodeAssets, makeSimulation } from './runtime/effect-simulation.mjs';
import { MapGpuRenderer } from './gpu-renderer.mjs';
import { MAX_GPU_BYTES, visiblePortals, portalFrameBounds, type CameraMatrix } from './geometry';
import { FRAME_MS, PORTAL_RENDERER_REVISION, type PortalCamera, type PortalFrame,
  type PortalGPUStats, type PortalWorkerOptions } from './protocol';
import type { PortalPlacement } from './placements';

type Entry = { portal: PortalPlacement; simulation: any };
export interface Backend {
  synchronize(entries: Map<string, Entry>): void;
  renderMap(entries: Map<string, Entry>, camera: CameraMatrix, width: number, height: number, steps: number): void;
  waitForGPU(): Promise<void>;
  finish(): ImageBitmap;
  diagnostics(): Pick<PortalGPUStats, 'device' | 'gpuMS' | 'particles' | 'visibleParticles' | 'estimatedGPUBytes'>;
  dispose(): void;
}
export interface Runtime { renderer: Backend; simulation: (portal: PortalPlacement, seed: number) => any }
export function createWorkerRuntime(buffer: ArrayBuffer): Runtime {
  const resources = decodeAssets(catalog, buffer);
  const renderer = new MapGpuRenderer(new OffscreenCanvas(1, 1), resources, catalog);
  return { renderer, simulation: (p, seed) => makeSimulation({
    effect: p.effect, worldSeed: seed, x: p.x, y: p.y, retainInvisible: false,
  }, catalog, resources) };
}

/** All emission, simulation, asset decoding and WebGL submission stay off the UI thread. */
export class PortalFrameRenderer {
  private entries = new Map<string, Entry>();
  private pending = 0;
  constructor(private portals: PortalPlacement[], private seed: number,
    private options: PortalWorkerOptions, private runtime: Runtime) {}

  async frame(id: number, camera: PortalCamera, elapsed: number): Promise<PortalFrame> {
    const started = performance.now();
    const { matrix, width, height, resolution } = camera;
    const visible = visiblePortals(this.portals, matrix, width, height, this.options.minPixels);
    const selected = visible.slice(0, this.options.limit);
    const keys = new Set(selected.map(p => p.id));
    let changed = false;
    for (const key of this.entries.keys()) if (!keys.has(key)) { this.entries.delete(key); changed = true; }
    for (const portal of selected) if (!this.entries.has(portal.id)) {
      this.entries.set(portal.id, { portal, simulation: this.runtime.simulation(portal, this.seed) }); changed = true;
    }
    if (changed) this.runtime.renderer.synchronize(this.entries);
    // Match upstream GridRuntime: accumulate wall time with its fractional
    // remainder, and run up to TWO fixed 1/60 steps (30fps presentation still
    // advances at normal speed). Bound long stalls instead of an unbounded queue.
    this.pending += Math.min(250, Math.max(0, elapsed));
    const slow = this.entries.size > 0 && this.pending > FRAME_MS * 3;
    if (slow) this.pending = FRAME_MS * 2 + this.pending % FRAME_MS;
    const steps = this.entries.size ? Math.min(2, Math.floor((this.pending + 1e-8) / FRAME_MS)) : 0;
    this.pending = this.entries.size ? Math.max(0, this.pending - steps * FRAME_MS) : 0;
    const crop = portalFrameBounds(selected, matrix, width, height);
    const outputCamera: PortalCamera = { matrix: { ...matrix, e: matrix.e - crop.x, f: matrix.f - crop.y },
      width: crop.width, height: crop.height, resolution };
    const backingWidth = Math.max(1, Math.floor(crop.width * resolution));
    const backingHeight = Math.max(1, Math.floor(crop.height * resolution));
    // Account for rounded backing dimensions independently on each axis, so
    // CSS reprojection stays exact even on fractional-DPR/capped canvases.
    const sx = backingWidth / crop.width, sy = backingHeight / crop.height, m = outputCamera.matrix;
    const transform: CameraMatrix = { a: m.a * sx, b: m.b * sy, c: m.c * sx,
      d: m.d * sy, e: m.e * sx, f: m.f * sy };
    this.runtime.renderer.renderMap(this.entries, transform, backingWidth, backingHeight, steps);
    const cpuMS = performance.now() - started;
    // CPU submission can finish long before the GPU. Await a fence before
    // returning a frame, so one in-flight request also bounds the GPU queue.
    await this.runtime.renderer.waitForGPU();
    const gpuWaitMS = performance.now() - started - cpuMS;
    const diagnostics = this.runtime.renderer.diagnostics();
    if (diagnostics.estimatedGPUBytes > MAX_GPU_BYTES) throw new Error(
      'Experimental portal GPU memory budget exceeded. Lower portalGpuLimit or toggle off. No fallback renderer is enabled.');
    const bitmap = this.runtime.renderer.finish();
    const frameMS = performance.now() - started;
    return { type: 'frame', id, camera: outputCamera, bitmap, activePortalIDs: [...this.entries.keys()], stats: {
      mode: 'experimental-gpu-particles', executionThread: 'worker', revision: PORTAL_RENDERER_REVISION,
      total: this.portals.length, visible: visible.length, active: this.entries.size,
      capped: visible.length - this.entries.size, cpuMS, gpuWaitMS, frameMS, steps, simFPS: 0, deliveryMS: 0, fps: 0,
      canvasPixels: backingWidth * backingHeight, suspended: false, slow,
      ...diagnostics,
    } };
  }
  dispose() { this.runtime.renderer.dispose(); this.entries.clear(); }
}
