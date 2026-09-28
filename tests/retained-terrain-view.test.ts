import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { RetainedTerrain, type RetainedView, type StoredTerrain } from '../src/telescope/retained-terrain';

const owners: RetainedTerrain[] = [];
function context(width: number, height: number, color?: string) {
  const ctx = createCanvas(width, height).getContext('2d');
  if (color) { ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); }
  return ctx as unknown as CanvasRenderingContext2D;
}
function bytes(ctx: CanvasRenderingContext2D) {
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
}
function pixel(ctx: CanvasRenderingContext2D, x: number, y: number) {
  return [...ctx.getImageData(x, y, 1, 1).data];
}
function fixture(budget = 4 * 1024 * 1024) {
  const records = new Map<string, StoredTerrain>();
  const store = {
    read: vi.fn(async (key: string) => records.get(key)),
    write: vi.fn(async (entries: { key: string; value: StoredTerrain }[]) => {
      for (const entry of entries) records.set(entry.key, structuredClone(entry.value));
    }),
  };
  const owner = new RetainedTerrain(store, budget);
  owners.push(owner);
  return { owner, store, records };
}
beforeEach(() => vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) }));
afterEach(async () => {
  for (const owner of owners.splice(0)) { await owner.flush(); owner.dispose(); }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('paints resident coarse pixels byte-exactly, clearing known air while leaving unknown GPU pixels intact without I/O', async () => {
  const { owner, store } = fixture(), region = owner.region('seed', 512, 256);
  const source = context(256, 256, '#ff0000');
  source.clearRect(32, 32, 64, 64);
  await region.record(0, 0, source);
  const target = context(256, 128, '#0000ff');
  target.scale(0.5, 0.5);
  const view = { x: 0, y: 0, width: 512, height: 256, scale: 2 };
  store.read.mockClear();
  const get = vi.spyOn(owner, 'get');
  expect(region.hasCompleteView(view)).toBe(false);
  region.paintResidentView(target, view);
  expect(get).not.toHaveBeenCalled(); expect(store.read).not.toHaveBeenCalled();
  const expected = context(256, 128, '#0000ff');
  expected.clearRect(0, 0, 128, 128);
  expected.drawImage(source.canvas, 0, 0, 128, 128);
  expect(bytes(target)).toEqual(bytes(expected));
  expect(pixel(target, 20, 20)).toEqual([0, 0, 0, 0]);
  expect(pixel(target, 200, 20)).toEqual([0, 0, 255, 255]);
});

it('uses existing reduced pages at coarse scale and native pages when zoomed closer than 1x', async () => {
  const { owner } = fixture(), region = owner.region('seed', 256, 256);
  const source = context(256, 256);
  const image = source.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const at = (y * 256 + x) * 4;
    image.data[at] = (x + y) % 2 ? 255 : 0;
    image.data[at + 1] = (x + y) % 2 ? 0 : 255;
    image.data[at + 3] = 255;
  }
  source.putImageData(image, 0, 0);
  await region.record(0, 0, source);
  const coarse = context(128, 128); coarse.scale(0.5, 0.5);
  region.paintResidentView(coarse, { x: 0, y: 0, width: 256, height: 256, scale: 2 });
  const reference = await region.complete({ level: region.maxLevel - 1, x: 0, y: 0 });
  expect(bytes(coarse)).toEqual(bytes(reference!));
  expect(pixel(coarse, 64, 64)[0]).toBeGreaterThan(0);
  expect(pixel(coarse, 64, 64)[1]).toBeGreaterThan(0);
  const close = context(8, 8); close.scale(2, 2);
  region.paintResidentView(close, { x: 0, y: 0, width: 4, height: 4, scale: 0.5 });
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
    expect(pixel(close, x, y)).toEqual(pixel(source, Math.floor(x / 2), Math.floor(y / 2)));
});

it('uses finer resident native cells immediately when the requested mip is absent, including reduced detail and air', () => {
  const { owner, store } = fixture(), region = owner.region('fine-only', 512, 256);
  const source = context(256, 256);
  const data = source.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const offset = (y * 256 + x) * 4;
    data.data[offset] = (x + y) % 2 ? 255 : 0;
    data.data[offset + 1] = (x + y) % 2 ? 0 : 255;
    data.data[offset + 3] = 255;
  }
  source.putImageData(data, 0, 0);
  source.clearRect(32, 32, 32, 32);
  owner.install(`fine-only/${region.maxLevel}/0/0`, source, new Uint8Array([1]), 1, 1, false);
  const view = { x: 0, y: 0, width: 512, height: 256, scale: 2 };
  const output = context(256, 128, '#0000ff'); output.scale(.5, .5);
  const coverage = region.paintResidentView(output, view);
  expect(region.hasCompleteView({ ...view, width: 256 })).toBe(true);
  expect(region.hasCompleteView(view)).toBe(false);
  expect(coverage).toEqual([{ x: 0, y: 0, width: 256, height: 256 }]);
  expect(pixel(output, 20, 20)).toEqual([0, 0, 0, 0]);
  expect(pixel(output, 80, 80)).toEqual([128, 128, 0, 255]);
  expect(pixel(output, 200, 80)).toEqual([0, 0, 255, 255]);
  expect(store.read).not.toHaveBeenCalled();
});

it('clips negative viewport coordinates and partial region edge pages without clearing outside the view', async () => {
  const { owner } = fixture(), region = owner.region('seed', 300, 270);
  await region.record(256, 256, context(44, 14, '#00ff00'));
  const target = context(320, 290, '#0000ff'); target.translate(10, 10);
  region.paintResidentView(target, { x: -10, y: -10, width: 320, height: 290, scale: 1 });
  expect(pixel(target, 265, 265)).toEqual([0, 0, 255, 255]);
  expect(pixel(target, 266, 266)).toEqual([0, 255, 0, 255]);
  expect(pixel(target, 309, 279)).toEqual([0, 255, 0, 255]);
  expect(pixel(target, 310, 279)).toEqual([0, 0, 255, 255]);
  expect(pixel(target, 309, 280)).toEqual([0, 0, 255, 255]);
  const clipped = context(300, 270, '#0000ff');
  region.paintResidentView(clipped, { x: 260, y: 260, width: 8, height: 8, scale: 1 });
  expect(pixel(clipped, 259, 260)).toEqual([0, 0, 255, 255]);
  expect(pixel(clipped, 260, 260)).toEqual([0, 255, 0, 255]);
  expect(pixel(clipped, 268, 260)).toEqual([0, 0, 255, 255]);
});

it('keeps resident presentation synchronous during stalled and denied background hydration', async () => {
  const { owner, store } = fixture(), region = owner.region('seed', 512, 256);
  await region.record(0, 0, context(256, 256, '#ff0000'));
  let finish!: (value: StoredTerrain | undefined) => void;
  store.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = { x: 0, y: 0, width: 512, height: 256, scale: 1 };
  const hydration = region.hydrateView(view);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const target = context(512, 256, '#0000ff');
  region.paintResidentView(target, view);
  expect(pixel(target, 0, 0)).toEqual([255, 0, 0, 255]);
  expect(pixel(target, 511, 0)).toEqual([0, 0, 255, 255]);
  expect(region.hasCompleteView(view)).toBe(false);
  finish(undefined); await hydration;
  store.read.mockRejectedValue(new Error('Denied'));
  await owner.region('cold', 256, 256).hydrateView({ ...view, width: 256 });
  expect(store.read).toHaveBeenCalledWith('cold/8/0/0');
  region.paintResidentView(target, view);
  expect(pixel(target, 0, 0)).toEqual([255, 0, 0, 255]);
});

it('streams stored completed pages sequentially under a one-page RAM budget and reports missing pages', async () => {
  const { owner, records, store } = fixture(256 * 256 * 4 + 1);
  const region = owner.region('seed', 768, 256);
  for (let x = 0; x < 3; x++) {
    const ctx = context(256, 256, ['#ff0000', '#00ff00', '#0000ff'][x]);
    if (x === 1) ctx.clearRect(8, 8, 8, 8);
    records.set(`seed/${region.maxLevel}/${x}/0`, {
      width: 256, height: 256, pixels: bytes(ctx), coverage: new Uint8Array([1]), columns: 1, rows: 1,
    });
  }
  let active = 0, peak = 0;
  store.read.mockImplementation(async key => {
    active++; peak = Math.max(peak, active);
    await Promise.resolve(); active--;
    return records.get(key);
  });
  const view: RetainedView = { x: 0, y: 0, width: 768, height: 256, scale: 1 };
  const target = context(768, 256, '#ffffff');
  expect(region.hasCompleteView(view)).toBe(false);
  expect(await region.paintStoredView(target, view)).toBe(true);
  expect(peak).toBe(1); expect(owner.stats.bytes).toBeLessThanOrEqual(owner.maxBytes);
  expect(pixel(target, 0, 0)).toEqual([255, 0, 0, 255]);
  expect(pixel(target, 264, 8)).toEqual([0, 0, 0, 0]);
  expect(pixel(target, 767, 0)).toEqual([0, 0, 255, 255]);
  records.delete(`seed/${region.maxLevel}/0/0`);
  expect(await region.paintStoredView(target, view)).toBe(false);
});
