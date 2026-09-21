import { describe, expect, it, vi } from 'vitest';
import { PortalFrameRenderer, replayStepsFor, type Runtime } from '../src/portals/worker-runtime';
import { MAX_GPU_BYTES } from '../src/portals/geometry';
import { FRAME_MS } from '../src/portals/protocol';
import type { PortalPlacement } from '../src/portals/placements';

const portal = (x: number): PortalPlacement => ({ id: `p:${x}`, entity: 'teleport_liquid_powered', effect: 'holy_mountain', x, y: 0, condition: 'liquid', phase: 0 });
const camera = { matrix: { a: 1, b: 0, c: 0, d: 1, e: 400, f: 300 }, width: 800, height: 600, resolution: 1 };
/** Minimal stand-in for a SourceSimulation: step counter plus the CPU state
 * the worker clones (RNGs, emitters, particle list). */
function fakeSimulation(p: PortalPlacement, seed: number) {
  return { x: p.x, seed, elapsedFrames: 0, particles: [] as any, emissionRng: { state: 1 }, lifetimeRng: { state: 1 },
    emitters: [{ next: 0 }], step() { this.elapsedFrames++; this.emissionRng.state++; this.particles.push({}); } };
}
function runtime() {
  const diagnostic = { device: 'test GPU', gpuMS: 1, particles: 10, visibleParticles: 10, estimatedGPUBytes: 1024 };
  const step = (entry: any, n: number) => { for (let i = 0; i < n; i++) entry.simulation.step(); };
  return { renderer: { synchronize: vi.fn(),
    replay: vi.fn((_key: string, entry: any, n: number) => step(entry, n)),
    renderMap: vi.fn((entries: Map<string, any>, _m: any, _w: number, _h: number, steps: number) => {
      for (const entry of entries.values()) step(entry, entry.steps ?? steps);
    }), waitForGPU: vi.fn(async () => {}),
    finish: vi.fn(() => ({ close: vi.fn() }) as unknown as ImageBitmap), diagnostics: vi.fn(() => diagnostic), dispose: vi.fn() },
    simulation: vi.fn(fakeSimulation), diagnostic } satisfies Runtime & { diagnostic: typeof diagnostic };
}
const activeIDs = (r: ReturnType<typeof runtime>, call: number) => [...r.renderer.renderMap.mock.calls[call][0].keys()];
describe('worker-owned portal rendering', () => {
  it('retains distinct simulations across camera moves and only synchronizes membership changes', async () => {
    const r = runtime(), renderer = new PortalFrameRenderer([portal(0), portal(10), portal(100000)], 123, { minPixels: 1.5, limit: 192 }, r);
    const first = await renderer.frame(1, camera, FRAME_MS);
    expect(first.stats).toMatchObject({ total: 3, active: 2, visible: 2, executionThread: 'worker' });
    expect(r.simulation).toHaveBeenCalledWith(portal(0), 123);
    expect(activeIDs(r, 0)).toEqual([portal(0).id, portal(10).id]);
    await renderer.frame(2, { ...camera, matrix: { ...camera.matrix, a: 2, d: 2 } }, FRAME_MS);
    expect(r.renderer.synchronize).toHaveBeenCalledOnce();
    const retained = r.renderer.renderMap.mock.calls[1][0].get(portal(0).id).simulation;
    expect(retained).toBe(r.renderer.renderMap.mock.calls[0][0].get(portal(0).id).simulation);
    await renderer.frame(3, { ...camera, matrix: { ...camera.matrix, e: -100000 } }, FRAME_MS);
    expect(r.renderer.synchronize).toHaveBeenCalledTimes(2);
    expect(activeIDs(r, 2)).toEqual([portal(100000).id]);
  });
  it('resumes a culled portal at the shared clock instead of restarting it', async () => {
    const late = { ...portal(100000), phase: 7 };
    const r = runtime(), renderer = new PortalFrameRenderer([portal(0), late], 42, { minPixels: 1.5, limit: 192 }, r);
    for (let i = 0; i < 100; i++) await renderer.frame(i, camera, FRAME_MS); // 100 steps, only portal 0 on screen
    const before = r.renderer.renderMap.mock.calls.at(-1)![0].get(portal(0).id).simulation;
    expect(before.elapsedFrames).toBe(100);
    // Jump to the far portal: it must arrive at clock(101) + phase(7) = 108 with the last
    // window replayed using real particles, not at frame 1.
    const away = await renderer.frame(200, { ...camera, matrix: { ...camera.matrix, e: -100000 } }, FRAME_MS);
    const entered = r.renderer.renderMap.mock.calls.at(-1)![0].get(late.id).simulation;
    expect(entered.elapsedFrames).toBe(108);
    expect(entered.particles.length).toBeLessThanOrEqual(1200 + 2);
    expect(r.renderer.replay).toHaveBeenCalled();
    expect(away.activePortalIDs).toEqual([late.id]);
    // Come back: portal 0 kept advancing on the shared clock while culled.
    await renderer.frame(201, camera, FRAME_MS);
    const back = r.renderer.renderMap.mock.calls.at(-1)![0].get(portal(0).id).simulation;
    expect(back).not.toBe(before); expect(back.elapsedFrames).toBe(102);
    expect(back.emissionRng).not.toBe(before.emissionRng);
  });
  it('spreads a long replay over frames instead of stalling the ones on screen', async () => {
    const eye = { ...portal(100000), effect: 'teleport_hourglass_return', entity: 'teleport_hourglass_return' };
    const r = runtime(), renderer = new PortalFrameRenderer([portal(0), eye], 42, { minPixels: 1.5, limit: 192 }, r);
    for (let i = 0; i < 1500; i++) await renderer.frame(i, camera, FRAME_MS);
    const far = { ...camera, matrix: { ...camera.matrix, e: -100000 } };
    // Float32 expiry plus collision lifetime-reset allowance, at a 400/frame
    // budget: the portal is composited on the fourth frame at the shared clock.
    let waited = 0;
    while ((await renderer.frame(1500 + waited, far, FRAME_MS)).activePortalIDs.length === 0) waited++;
    expect(waited).toBe(3);
    const sim = r.renderer.renderMap.mock.calls.at(-1)![0].get(eye.id).simulation;
    expect(sim.elapsedFrames).toBe(1500 + waited + 1); // clock kept running during the replay
    expect(sim.particles.length).toBe(replayStepsFor(eye.effect) + waited);
    expect(Math.max(...r.renderer.replay.mock.calls.map(c => c[2]))).toBeLessThanOrEqual(400);
  });
  it('uses upstream two-step stall cap and reports instance limits', async () => {
    const r = runtime(), renderer = new PortalFrameRenderer([portal(0), portal(10)], 42, { minPixels: 1.5, limit: 1 }, r);
    const frame = await renderer.frame(1, camera, 1000);
    expect(r.renderer.renderMap.mock.calls[0][4]).toBe(2);
    expect(frame.stats.slow).toBe(true);
    expect(frame.stats).toMatchObject({ active: 1, visible: 2, capped: 1 });
    expect(frame.activePortalIDs).toEqual([portal(0).id]);
    await renderer.frame(2, camera, 1);
    expect(r.renderer.renderMap.mock.calls[1][4]).toBe(1); // retained fractional debt after the stall
  });
  it.each([60, 30])('advances a full simulation second at %i presentation frames/s', async fps => {
    const r = runtime(), renderer = new PortalFrameRenderer([portal(0)], 42, { minPixels: 1.5, limit: 192 }, r);
    for (let i = 0; i < fps; i++) {
      const frame = await renderer.frame(i, camera, 1000 / fps);
      expect(frame.stats.slow).toBe(false);
    }
    const steps = r.renderer.renderMap.mock.calls.reduce((sum, call) => sum + call[4], 0);
    expect(steps).toBe(60);
  });
  it('retains sub-frame elapsed time instead of rounding it away', async () => {
    const r = runtime(), renderer = new PortalFrameRenderer([portal(0)], 42, { minPixels: 1.5, limit: 192 }, r);
    for (let i = 0; i < 100; i++) await renderer.frame(i, camera, 10);
    expect(r.renderer.renderMap.mock.calls.reduce((sum, call) => sum + call[4], 0)).toBe(60);
  });
  it('sends a native-sized portal crop instead of a mostly empty viewport', async () => {
    const r = runtime(), renderer = new PortalFrameRenderer([portal(0)], 42, { minPixels: 1.5, limit: 192 }, r);
    const frame = await renderer.frame(1, { ...camera, width: 1920, height: 1080 }, FRAME_MS);
    expect(frame.camera).toEqual({ width: 480, height: 320, resolution: 1,
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 240, f: 160 } });
    expect(frame.stats.canvasPixels).toBe(480 * 320);
    expect(r.renderer.renderMap.mock.calls[0].slice(2, 4)).toEqual([480, 320]);
    expect(frame.activePortalIDs).toEqual([portal(0).id]);
  });
  it('skips the GPU fence by default and only waits for it when portalGpuFence is set', async () => {
    const r = runtime(), renderer = new PortalFrameRenderer([portal(0)], 42, { minPixels: 1.5, limit: 192 }, r);
    await renderer.frame(1, camera, FRAME_MS);
    expect(r.renderer.waitForGPU).not.toHaveBeenCalled(); expect(r.renderer.finish).toHaveBeenCalledOnce();
  });
  it('waits for actual GPU completion before handing a bitmap back', async () => {
    const r = runtime(); let complete!: () => void;
    r.renderer.waitForGPU.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const renderer = new PortalFrameRenderer([portal(0)], 42, { minPixels: 1.5, limit: 192, fence: true }, r);
    const frame = renderer.frame(1, camera, FRAME_MS);
    expect(r.renderer.renderMap).toHaveBeenCalledOnce(); expect(r.renderer.finish).not.toHaveBeenCalled();
    complete(); await frame; expect(r.renderer.finish).toHaveBeenCalledOnce();
  });
  it('culls subpixel portals and fails rather than switching backend on memory exhaustion', async () => {
    const r = runtime(), renderer = new PortalFrameRenderer([portal(0)], 42, { minPixels: 1.5, limit: 192 }, r);
    const frame = await renderer.frame(1, { ...camera, matrix: { ...camera.matrix, a: .01, d: .01 } }, FRAME_MS);
    expect(frame.stats.active).toBe(0); expect(r.renderer.renderMap.mock.calls[0][0].size).toBe(0);
    r.diagnostic.estimatedGPUBytes = MAX_GPU_BYTES + 1;
    await expect(renderer.frame(2, camera, FRAME_MS)).rejects.toThrow('memory budget');
    renderer.dispose(); expect(r.renderer.dispose).toHaveBeenCalledOnce();
  });
});
