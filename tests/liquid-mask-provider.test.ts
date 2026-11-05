import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cropLiquidMask } from '../src/liquids/mask-index';
const io = vi.hoisted(() => ({ paint: vi.fn(), crop: vi.fn(), destroy: vi.fn(), live: vi.fn(), init: vi.fn() }));
vi.mock('../src/liquids/mask-worker-client', () => ({ LiquidMaskWorkerClient: class {
  paint = io.paint; crop = io.crop; destroy = io.destroy;
} }));
vi.mock('../src/liquids/live-source', () => ({ createLiveLiquidSource: io.init }));
import { LiquidMaskProvider } from '../src/liquids/mask-provider';

beforeEach(() => {
  vi.clearAllMocks();
  io.paint.mockImplementation(async (bounds: any) => new Uint8Array(bounds.width * bounds.height));
  io.crop.mockImplementation(async (bounds: any, pixels: Uint8Array, exclusions: any) => cropLiquidMask(pixels, bounds, exclusions));
  io.live.mockImplementation(async (_bounds: any, pixels: Uint8Array) => { pixels[0] = 255; return true; });
  io.init.mockResolvedValue({ paint: io.live });
});
afterEach(() => vi.restoreAllMocks());
const world = (pw: number, hasMask = true) => ({ pw, x: pw * 35840 - 17920, y: -31744, width: 35840,
  dziUrl: `https://world${pw}.test/map.dzi`, bust: 'today',
  liquidMask: hasMask ? { url: `https://world${pw}.test/liquid-mask.bin?v=a`, bytes: 12, sha256: 'a'.repeat(64) } : undefined });

describe('mask source selection and bounded live queries', () => {
  it('loads only visible baked worlds and never initializes live terrain for a Daily', async () => {
    const provider = new LiquidMaskProvider({ baked: [-1, 0, 1].map(pw => world(pw)), staticBackground: true, exclusions: () => [] });
    expect(io.paint).not.toHaveBeenCalled();
    await provider.prepare({ x: 100, y: 100, width: 256, height: 256 }, new AbortController().signal);
    const sources = io.paint.mock.calls[0][1];
    expect(sources).toHaveLength(2);
    expect(sources[0].url).toContain('static-mask.bin.gz'); expect(sources[1].url).toContain('world0.test');
    expect(io.init).not.toHaveBeenCalled(); provider.destroy();
  });
  it('does not probe old bakes for missing files or import generation just to animate captured pools', async () => {
    const provider = new LiquidMaskProvider({ baked: [world(0, false)], staticBackground: true, exclusions: () => [] });
    await provider.prepare({ x: 0, y: 0, width: 256, height: 256 }, new AbortController().signal);
    expect(io.paint.mock.calls[0][1]).toHaveLength(1);
    expect(io.paint.mock.calls[0][1][0].excludeCapturedFluidsIn).toEqual([{ x: -17920, width: 35840 }]);
    expect(provider.stats().missingBakedWorlds).toEqual([0]);
    expect(io.init).not.toHaveBeenCalled(); provider.destroy();
  });
  it('reserves the complete captured pool only when that world advertises corrected bake pixels', async () => {
    const corrected = world(0); Object.assign(corrected.liquidMask!, { preservesCapturedFluids: true });
    const provider = new LiquidMaskProvider({ baked: [world(-1), corrected], staticBackground: true, exclusions: () => [] });
    await provider.prepare({ x: -18000, y: 1000, width: 500, height: 80 }, new AbortController().signal);
    expect(io.paint.mock.calls[0][1][0].excludeCapturedFluidsIn).toEqual([{ x: -53760, width: 35840 }]);
    expect(provider.stats().missingBakedWorlds).toEqual([]); provider.destroy();
  });
  it('retries after an initially unavailable live renderer rather than caching absence', async () => {
    io.init.mockResolvedValueOnce(null);
    const provider = new LiquidMaskProvider({ staticBackground: false, live: { seed: 42, scenes: [], loadScene: vi.fn() }, exclusions: () => [] });
    const bounds = { x: 0, y: 0, width: 256, height: 256 }, signal = new AbortController().signal;
    expect(await provider.prepare(bounds, signal)).toBeNull();
    expect(provider.stats().generatedPending).toBe(true);
    expect(await provider.prepare(bounds, signal)).not.toBeNull();
    expect(provider.stats().generatedPending).toBe(false);
    expect(io.init).toHaveBeenCalledTimes(2); provider.destroy();
  });
  it('caches successful aligned live blocks, reapplies fresh marker exclusions, and releases them', async () => {
    const exclusion = { x: 0, y: 0, width: 1, height: 1 }, exclusions = vi.fn(() => [] as any[]);
    const provider = new LiquidMaskProvider({ staticBackground: false,
      live: { seed: 42, scenes: [], loadScene: vi.fn() }, exclusions });
    const bounds = { x: 0, y: 0, width: 256, height: 256 }, signal = new AbortController().signal;
    expect(await provider.prepare(bounds, signal)).not.toBeNull();
    expect(io.live).toHaveBeenCalledOnce();
    expect(io.live.mock.calls[0][0]).toEqual(bounds);
    exclusions.mockReturnValue([exclusion]);
    expect(await provider.prepare(bounds, signal)).toBeNull();
    expect(io.live).toHaveBeenCalledOnce(); expect(io.init).toHaveBeenCalledOnce();
    expect(provider.stats().cachedBytes).toBe(65536);
    provider.destroy(); expect(provider.stats().cachedBytes).toBe(0); expect(io.destroy).toHaveBeenCalledOnce();
  });
  it('does not cache incomplete GPU queries and aborts before preparing a stale viewport', async () => {
    const provider = new LiquidMaskProvider({ staticBackground: false, live: { seed: 42, scenes: [], loadScene: vi.fn() }, exclusions: () => [] });
    io.live.mockResolvedValue(false);
    const bounds = { x: 0, y: 0, width: 256, height: 256 }, controller = new AbortController();
    await provider.prepare(bounds, controller.signal); expect(provider.stats().cachedBlocks).toBe(0);
    controller.abort();
    await expect(provider.prepare(bounds, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(io.live).toHaveBeenCalledOnce(); provider.destroy();
  });
});
