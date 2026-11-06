import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeLiquidMask } from '../src/liquids/mask-codec';
import { LiquidMaskIndex, cropLiquidMask } from '../src/liquids/mask-index';
const io = vi.hoisted(() => ({ paint: vi.fn(), crop: vi.fn(), destroy: vi.fn(), live: vi.fn() }));
vi.mock('../src/liquids/mask-worker-client', () => ({ LiquidMaskWorkerClient: class {
  paint = io.paint; crop = io.crop; destroy = io.destroy;
} }));
vi.mock('../src/liquids/live-source', () => ({ createLiveLiquidSource: io.live }));
import { LiquidMaskProvider } from '../src/liquids/mask-provider';

const water = new LiquidMaskIndex(decodeLiquidMask(gunzipSync(readFileSync(
  new URL('../src/liquids/assets/holy-mountain-water.bin.gz', import.meta.url)))));
const view = { x: -600, y: 1380, width: 240, height: 140 };
beforeEach(() => {
  vi.clearAllMocks();
  io.paint.mockImplementation(async (bounds: any) => {
    const pixels = new Uint8Array(bounds.width * bounds.height); water.paint(pixels, bounds); return pixels;
  });
  io.crop.mockImplementation(async (bounds: any, pixels: Uint8Array, exclusions: any) => cropLiquidMask(pixels, bounds, exclusions));
});
afterEach(() => vi.restoreAllMocks());

describe('Holy Mountain water source', () => {
  it('returns the same complete water mask for live, old baked and sidecar-equipped maps, without generation or sidecar requests', async () => {
    const masks = [];
    for (const extras of [{ live: { seed: 42, scenes: [], loadScene: vi.fn() } },
      { baked: [{ pw: 0 }] }, { baked: [{ pw: 0, liquidMask: { url: 'https://daily.test/liquid-mask.bin' } }] }]) {
      const provider = new LiquidMaskProvider({ staticBackground: true, exclusions: () => [], ...extras });
      const mask = await provider.prepare(view, new AbortController().signal);
      expect(mask).toMatchObject({ complete: true, coverage: expect.objectContaining({ x: -768, y: 1280 }) });
      masks.push(mask); provider.destroy();
    }
    expect(masks[0]).toEqual(masks[1]); expect(masks[1]).toEqual(masks[2]);
    expect(io.live).not.toHaveBeenCalled();
    for (const [, sources] of io.paint.mock.calls) {
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({ url: expect.stringContaining('holy-mountain-water.bin.gz'), bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    }
  });
  it.each([
    { x: -500, y: 1300, width: 30, height: 20 }, // same aligned block, water still outside view
    { x: 585, y: 984, width: 367, height: 240 }, // upper basin and portal cup
    { x: 526, y: 1943, width: 200, height: 200 }, // generated liquid
    { x: -4096, y: 13312, width: 512, height: 512 }, // lava lake
    { x: -14848, y: 512, width: 512, height: 512 }, // captured lake
  ])('does no mask IO for other liquids at $x,$y', async bounds => {
    const provider = new LiquidMaskProvider({ staticBackground: true, exclusions: () => [] });
    expect(await provider.prepare(bounds, new AbortController().signal)).toBeNull();
    expect(io.paint).not.toHaveBeenCalled(); expect(io.live).not.toHaveBeenCalled();
    provider.destroy(); expect(io.destroy).not.toHaveBeenCalled();
  });
  it('does no mask IO for unsupported base maps', async () => {
    const provider = new LiquidMaskProvider({ staticBackground: false, exclusions: () => [] });
    expect(await provider.prepare(view, new AbortController().signal)).toBeNull();
    expect(io.paint).not.toHaveBeenCalled(); provider.destroy();
  });
  it('reapplies marker exclusions and releases its worker', async () => {
    const exclusions = vi.fn(() => [] as typeof view[]);
    const provider = new LiquidMaskProvider({ staticBackground: true, exclusions });
    expect(await provider.prepare(view, new AbortController().signal)).not.toBeNull();
    exclusions.mockReturnValue([{ x: -768, y: 1280, width: 512, height: 256 }]);
    expect(await provider.prepare(view, new AbortController().signal)).toBeNull();
    expect(provider.stats().generatedPending).toBe(false);
    provider.destroy(); expect(io.destroy).toHaveBeenCalledOnce();
    expect(await provider.prepare(view, new AbortController().signal)).toBeNull();
    expect(io.paint).toHaveBeenCalledTimes(2);
  });
  it('rejects a cancelled crop instead of presenting stale water', async () => {
    let release!: (mask: any) => void;
    io.crop.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const provider = new LiquidMaskProvider({ staticBackground: true, exclusions: () => [] });
    const controller = new AbortController();
    const pending = provider.prepare(view, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(io.crop).toHaveBeenCalledOnce());
    controller.abort(); release({ x: -520, y: 1420, width: 1, height: 1, pixels: new Uint8Array([255]) });
    await rejected; provider.destroy();
  });
});
