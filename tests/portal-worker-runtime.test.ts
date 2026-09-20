import { describe, expect, it, vi } from 'vitest';
import { PortalFrameRenderer, type Runtime } from '../src/portals/worker-runtime';
import { MAX_GPU_BYTES } from '../src/portals/geometry';
import { FRAME_MS } from '../src/portals/protocol';
import type { PortalPlacement } from '../src/portals/placements';

const portal = (x: number): PortalPlacement => ({ id: `p:${x}`, entity: 'teleport_liquid_powered', effect: 'holy_mountain', x, y: 0, condition: 'liquid', phase: 0 });
const camera = { matrix: { a: 1, b: 0, c: 0, d: 1, e: 400, f: 300 }, width: 800, height: 600, resolution: 1 };
function runtime() {
  const diagnostic = { device: 'test GPU', gpuMS: 1, particles: 10, visibleParticles: 10, estimatedGPUBytes: 1024 };
  return { renderer: { synchronize: vi.fn(), renderMap: vi.fn(), waitForGPU: vi.fn(async () => {}),
    finish: vi.fn(() => ({ close: vi.fn() }) as unknown as ImageBitmap), diagnostics: vi.fn(() => diagnostic), dispose: vi.fn() },
    simulation: vi.fn((p: PortalPlacement, seed: number) => ({ x: p.x, seed })), diagnostic } satisfies Runtime & { diagnostic: typeof diagnostic };
}
describe('worker-owned portal rendering', () => {
  it('retains distinct simulations across camera moves and only synchronizes membership changes', async () => {
    const r = runtime(), renderer = new PortalFrameRenderer([portal(0), portal(10), portal(100000)], 123, { minPixels: 1.5, limit: 192 }, r);
    const first = await renderer.frame(1, camera, FRAME_MS);
    expect(first.stats).toMatchObject({ total: 3, active: 2, visible: 2, executionThread: 'worker' });
    expect(r.simulation).toHaveBeenCalledTimes(2); expect(r.simulation).toHaveBeenCalledWith(portal(0), 123);
    await renderer.frame(2, { ...camera, matrix: { ...camera.matrix, a: 2, d: 2 } }, FRAME_MS);
    expect(r.simulation).toHaveBeenCalledTimes(2); expect(r.renderer.synchronize).toHaveBeenCalledOnce();
    await renderer.frame(3, { ...camera, matrix: { ...camera.matrix, e: -100000 } }, FRAME_MS);
    expect(r.simulation).toHaveBeenCalledTimes(3); expect(r.renderer.synchronize).toHaveBeenCalledTimes(2);
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
  it('waits for actual GPU completion before handing a bitmap back', async () => {
    const r = runtime(); let complete!: () => void;
    r.renderer.waitForGPU.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const renderer = new PortalFrameRenderer([portal(0)], 42, { minPixels: 1.5, limit: 192 }, r);
    const frame = renderer.frame(1, camera, FRAME_MS);
    expect(r.renderer.renderMap).toHaveBeenCalledOnce(); expect(r.renderer.finish).not.toHaveBeenCalled();
    complete(); await frame; expect(r.renderer.finish).toHaveBeenCalledOnce();
  });
  it('culls subpixel portals and fails rather than switching backend on memory exhaustion', async () => {
    const r = runtime(), renderer = new PortalFrameRenderer([portal(0)], 42, { minPixels: 1.5, limit: 192 }, r);
    const frame = await renderer.frame(1, { ...camera, matrix: { ...camera.matrix, a: .01, d: .01 } }, FRAME_MS);
    expect(frame.stats.active).toBe(0); expect(r.simulation).not.toHaveBeenCalled();
    r.diagnostic.estimatedGPUBytes = MAX_GPU_BYTES + 1;
    await expect(renderer.frame(2, camera, FRAME_MS)).rejects.toThrow('memory budget');
    renderer.dispose(); expect(r.renderer.dispose).toHaveBeenCalledOnce();
  });
});
