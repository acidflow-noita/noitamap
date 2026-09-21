import catalog from './assets/effects.json';
import { decodeAssets, makeSimulation } from './runtime/effect-simulation.mjs';
import { MapGpuRenderer } from './gpu-renderer.mjs';
import { MAX_GPU_BYTES, visiblePortals, portalFrameBounds, type CameraMatrix } from './geometry';
import { FRAME_MS, PORTAL_RENDERER_REVISION, type PortalCamera, type PortalFrame,
  type PortalGPUStats, type PortalWorkerOptions } from './protocol';
import type { PortalPlacement } from './placements';

type Entry = { portal: PortalPlacement; simulation: any; replay: 0 | 1; steps?: number };
/** Simulation steps replayed with real particles when a portal (re)enters the
 * view: everything older than the longest particle life is invisible anyway. */
const MAX_REPLAY_STEPS = 1200;
const REPLAY_BUDGET_PER_FRAME = 400;
export function replayStepsFor(effect: string): number {
  const emitters: any[] = (catalog as any).effects?.[effect]?.emitters ?? [];
  const life = emitters.reduce((max, e) => Math.max(max, Number(e.lifeMax) || 0), 0);
  return life > 0 ? Math.min(MAX_REPLAY_STEPS, Math.ceil(life * 60) + 2) : MAX_REPLAY_STEPS;
}
/** A simulation whose particle list is this stub advances emission timers and
 * both RNG streams exactly (creation happens after every draw in `create()`)
 * at ~1.5us per step, without any particle work. */
export function makeShadow(simulation: any): any {
  simulation.particles = { length: 0, push() { return 0; } };
  return simulation;
}
/** Independent copy of a simulation's CPU state (emitters, RNGs, sprites). */
export function cloneSimulation(sim: any): any {
  const copy = (o: any) => Object.assign(Object.create(Object.getPrototypeOf(o)), o);
  const clone = copy(sim);
  clone.emissionRng = copy(sim.emissionRng); clone.lifetimeRng = copy(sim.lifetimeRng);
  if (sim.emitters) clone.emitters = sim.emitters.map((e: any) => ({ ...e }));
  if (sim.spriteEmitters) clone.spriteEmitters = sim.spriteEmitters.map((e: any) => ({ ...e }));
  if (sim.spriteParticles) clone.spriteParticles = sim.spriteParticles.map((p: any) =>
    ({ ...p, color: [...p.color], colorChange: [...p.colorChange] }));
  if (sim.points) clone.points = sim.points.map((p: any) => ({ ...p }));
  if (sim.previousPoints) clone.previousPoints = sim.previousPoints.map((p: any) => ({ ...p }));
  clone.particles = []; clone.visibleCount = 0;
  return clone;
}
export interface Backend {
  synchronize(entries: Map<string, Entry>): void;
  /** Step one entry's particles without compositing (catch-up after culling). */
  replay(key: string, entry: Entry, steps: number): void;
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
  /** One shared simulation clock, in fixed 1/60 steps. Every portal targets
   * `clock + phase`, so a portal that scrolls away and back resumes exactly
   * where a never-culled one would be. */
  private clock = 0;
  /** Every portal has a particle-free shadow that dry-steps each frame, kept
   * exactly one replay window behind its target. Entering a portal clones the
   * shadow and replays only that window with real particles. */
  private shadows: { portal: PortalPlacement; simulation: any; window: number }[];
  constructor(private portals: PortalPlacement[], private seed: number,
    private options: PortalWorkerOptions, private runtime: Runtime) {
    this.shadows = portals.map(portal => ({ portal, window: replayStepsFor(portal.effect),
      simulation: makeShadow(runtime.simulation(portal, seed)) }));
  }
  private advanceShadows() {
    for (const { portal, simulation, window } of this.shadows) {
      const target = this.clock + portal.phase - window;
      for (let i = simulation.elapsedFrames; i < target; i++) simulation.step();
    }
  }
  private enter(portal: PortalPlacement): Entry {
    const shadow = this.shadows.find(s => s.portal === portal)!;
    const simulation = cloneSimulation(shadow.simulation);
    return { portal, simulation, replay: 1 };
  }

  async frame(id: number, camera: PortalCamera, elapsed: number): Promise<PortalFrame> {
    const started = performance.now();
    const { matrix, width, height, resolution } = camera;
    const visible = visiblePortals(this.portals, matrix, width, height, this.options.minPixels);
    const selected = visible.slice(0, this.options.limit);
    const keys = new Set(selected.map(p => p.id));
    // Match upstream GridRuntime: accumulate wall time with its fractional
    // remainder, and run up to TWO fixed 1/60 steps (30fps presentation still
    // advances at normal speed). Bound long stalls instead of an unbounded queue.
    // The clock only advances while something is on screen, so it never runs
    // ahead of what has actually been simulated.
    const active = keys.size > 0;
    this.pending += active ? Math.min(250, Math.max(0, elapsed)) : 0;
    const slow = active && this.pending > FRAME_MS * 3;
    if (slow) this.pending = FRAME_MS * 2 + this.pending % FRAME_MS;
    const steps = active ? Math.min(2, Math.floor((this.pending + 1e-8) / FRAME_MS)) : 0;
    this.pending = active ? Math.max(0, this.pending - steps * FRAME_MS) : 0;
    this.clock += steps;
    this.advanceShadows();
    let changed = false;
    for (const key of this.entries.keys()) if (!keys.has(key)) { this.entries.delete(key); changed = true; }
    for (const portal of selected) if (!this.entries.has(portal.id)) {
      this.entries.set(portal.id, this.enter(portal)); changed = true;
    }
    if (changed) this.runtime.renderer.synchronize(this.entries);
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
    // Entries behind the clock (just entered, or mid-replay) catch up within a
    // per-frame budget and are composited only once they reach it; a portal
    // appears a frame or two late rather than stalling the ones on screen.
    let budget = REPLAY_BUDGET_PER_FRAME;
    const ready = new Map<string, Entry>();
    for (const [key, entry] of this.entries) {
      const debt = this.clock + entry.portal.phase - entry.simulation.elapsedFrames;
      if (entry.replay > 0) {
        const run = Math.min(debt, budget);
        budget -= run;
        if (run < debt) { this.runtime.renderer.replay(key, entry, run); continue; }
        // The final replay steps render so trails/history exist on first show.
        entry.replay = 0; entry.steps = Math.min(run, 2);
        this.runtime.renderer.replay(key, entry, run - entry.steps);
      } else entry.steps = debt;
      ready.set(key, entry);
    }
    this.runtime.renderer.renderMap(ready, transform, backingWidth, backingHeight, steps);
    const cpuMS = performance.now() - started;
    // By default the bitmap is handed back as soon as submission finishes; the
    // compositor resolves it when the GPU is done, and the next request only
    // follows presentation, which bounds the queue. `portalGpuFence=1` restores
    // the explicit fence (measured 7-15ms of idle worker time per frame).
    if (this.options.fence) await this.runtime.renderer.waitForGPU();
    const gpuWaitMS = performance.now() - started - cpuMS;
    const diagnostics = this.runtime.renderer.diagnostics();
    if (diagnostics.estimatedGPUBytes > MAX_GPU_BYTES) throw new Error(
      'Experimental portal GPU memory budget exceeded. Lower portalGpuLimit or toggle off. No fallback renderer is enabled.');
    const bitmap = this.runtime.renderer.finish();
    const frameMS = performance.now() - started;
    return { type: 'frame', id, camera: outputCamera, bitmap, activePortalIDs: [...ready.keys()], stats: {
      mode: 'experimental-gpu-particles', executionThread: 'worker', revision: PORTAL_RENDERER_REVISION,
      total: this.portals.length, visible: visible.length, active: this.entries.size,
      capped: visible.length - this.entries.size, cpuMS, gpuWaitMS, frameMS, steps, simFPS: 0, deliveryMS: 0, fps: 0,
      canvasPixels: backingWidth * backingHeight, suspended: false, slow,
      ...diagnostics,
    } };
  }
  dispose() { this.runtime.renderer.dispose(); this.entries.clear(); this.shadows = []; }
}
