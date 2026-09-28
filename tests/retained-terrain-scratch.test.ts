import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { RetainedTerrain, type TerrainRetentionStore } from '../src/telescope/retained-terrain';

const owners: RetainedTerrain[] = [];
let scratchAllocations: object[];
function context(width: number, height: number, color?: string) {
  const ctx = createCanvas(width, height).getContext('2d');
  if (color) { ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); }
  return ctx as unknown as CanvasRenderingContext2D;
}
function retention(store: TerrainRetentionStore = { read: async () => undefined, write: async () => {} }) {
  const owner = new RetainedTerrain(store);
  owners.push(owner);
  return owner;
}
function pixels(ctx: CanvasRenderingContext2D) {
  return Buffer.from(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data);
}
function half(source: CanvasRenderingContext2D) {
  const next = context(Math.ceil(source.canvas.width / 2), Math.ceil(source.canvas.height / 2));
  next.imageSmoothingEnabled = true;
  next.imageSmoothingQuality = 'low';
  next.drawImage(source.canvas, 0, 0, source.canvas.width / 2, source.canvas.height / 2);
  return next;
}
beforeEach(() => {
  scratchAllocations = [];
  vi.stubGlobal('document', {
    createElement() {
      const canvas = createCanvas(1, 1), getContext = canvas.getContext.bind(canvas);
      let counted = false;
      vi.spyOn(canvas, 'getContext').mockImplementation((type, options) => {
        if (!counted && !(options as CanvasRenderingContext2DSettings | undefined)?.willReadFrequently)
          scratchAllocations.push(canvas);
        counted = true;
        return getContext(type, options);
      });
      return canvas;
    },
  });
});
afterEach(async () => {
  for (const owner of owners.splice(0)) { await owner.flush(); owner.dispose(); }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('shares nine scratch canvases across concurrent regions without mixing their pixels or transparent coverage', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const owner = retention({ read: async () => { await gate; return undefined; }, write: async () => {} });
  const red = context(512, 512, '#ff0000'), green = context(512, 512, '#00ff00');
  red.clearRect(32, 32, 128, 128);
  green.clearRect(0, 256, 256, 256);
  green.fillStyle = '#0000ff80'; green.fillRect(0, 256, 256, 256);
  const regions = [owner.region('red', 1024, 1024), owner.region('green', 1024, 1024)];
  try {
    await Promise.all(regions.map((region, i) => region.capture(0, 0, [red, green][i])));
    expect(owner.stats.captures).toBe(2); // Ancestor disk reads are still pending.
    for (const [i, region] of regions.entries()) {
      let expectedSource = [red, green][i];
      for (let depth = 1; depth <= 8; depth++) {
        expectedSource = half(expectedSource);
        const actual = context(256, 256, '#ff00ff'), expected = context(256, 256, '#ff00ff');
        expected.clearRect(0, 0, expectedSource.canvas.width, expectedSource.canvas.height);
        expected.drawImage(expectedSource.canvas, 0, 0);
        await region.apply({ level: region.maxLevel - depth, x: 0, y: 0 }, actual);
        expect(pixels(actual).equals(pixels(expected)), `region ${i}, depth ${depth}`).toBe(true);
      }
    }
    await regions[0].capture(0, 0, context(512, 512));
    const air = context(256, 256, '#0000ff');
    await regions[0].apply({ level: 9, x: 0, y: 0 }, air);
    expect(pixels(air).every(byte => byte === 0)).toBe(true);
    expect(scratchAllocations).toHaveLength(9);
    expect(owner.stats.reductionBytes).toBe(349524);
  } finally { release(); }
});

it('preserves odd-sized boundary filtering when scratch canvases change dimensions and are reused', async () => {
  const owner = retention();
  await owner.region('full', 1024, 1024).record(0, 0, context(512, 512, '#00ff00'));
  const region = owner.region('edge', 515, 517), input = context(3, 5, '#ff000080');
  input.clearRect(1, 1, 1, 3);
  await region.record(512, 512, input);
  let reduced = input;
  for (let depth = 0; depth <= 8; depth++) {
    const scale = 2 ** depth, x = Math.floor(2 / scale), y = Math.floor(2 / scale);
    const width = Math.min(256, Math.ceil(515 / scale) - x * 256);
    const height = Math.min(256, Math.ceil(517 / scale) - y * 256);
    const actual = context(width, height, '#0000ff'), expected = context(width, height, '#0000ff');
    const dx = (2 % scale) * 256 / scale, dy = (2 % scale) * 256 / scale;
    expected.clearRect(dx, dy, 256 / scale, 256 / scale);
    expected.drawImage(reduced.canvas, dx, dy);
    await region.apply({ level: region.maxLevel - depth, x, y }, actual);
    expect(pixels(actual).equals(pixels(expected)), `edge depth ${depth}`).toBe(true);
    reduced = half(reduced);
  }
  await owner.region('full-again', 1024, 1024).record(0, 0, context(512, 512));
  expect(scratchAllocations).toHaveLength(9);
  expect(owner.stats.reductionBytes).toBe(349524);
  owner.dispose();
  expect(owner.stats.reductionBytes).toBe(0);
});

it('releases scratch canvases even when captures finish admission after disposal', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const owner = retention({ read: async () => { await gate; return undefined; }, write: async () => {} });
  const region = owner.region('pending', 4096, 512), input = context(256, 256, '#ff0000');
  const captures = Array.from({ length: 12 }, (_, i) => region.capture(i * 256, 0, input));
  try {
    await vi.waitFor(() => expect(owner.stats.captures).toBeGreaterThan(0));
    expect(owner.stats.captures).toBeLessThan(12);
    expect(owner.stats.reductionBytes).toBeGreaterThan(0);
    owner.dispose();
    expect(owner.stats.reductionBytes).toBe(0);
  } finally { release(); }
  await Promise.all(captures);
  await owner.flush();
  expect(owner.stats.captures).toBe(0);
  expect(owner.stats.reductionBytes).toBe(0);
});
