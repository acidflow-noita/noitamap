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

it.each([.65, 1, 1.23, 1.75, 2.46, 9.7])('matches one unbroken native texture across page boundaries at fractional camera scale %s', scale => {
  const { owner } = fixture(), region = owner.region('seams', 512, 512);
  const source = context(512, 512);
  const image = source.createImageData(512, 512);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const at = (y * 512 + x) * 4;
    image.data[at] = x % 256;
    image.data[at + 1] = y % 256;
    image.data[at + 2] = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 16 : 200;
    image.data[at + 3] = x >= 240 && x < 280 && y >= 110 && y < 290 ? 0
      : x >= 200 && x < 312 && y >= 320 && y < 380 ? 128 : 255;
  }
  source.putImageData(image, 0, 0);
  // Deliberately omit every ancestor: extreme overview ratios must use a
  // bounded reduction of the available native pages without storage reads.
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const page = context(256, 256);
    page.drawImage(source.canvas, x * 256, y * 256, 256, 256, 0, 0, 256, 256);
    owner.install(`seams/${region.maxLevel}/${x}/${y}`, page, new Uint8Array([1]), 1, 1, false);
  }
  let reference = source, pixelScale = 1;
  while (scale >= pixelScale * 2) {
    const next = context(reference.canvas.width / 2, reference.canvas.height / 2);
    next.imageSmoothingEnabled = true; next.imageSmoothingQuality = 'low';
    next.drawImage(reference.canvas, 0, 0, next.canvas.width, next.canvas.height);
    reference = next; pixelScale *= 2;
  }
  const output = context(640, 640, '#205070'), expected = context(640, 640, '#205070');
  const tx = 20.25, ty = 30.7;
  output.setTransform(1 / scale, 0, 0, 1 / scale, tx, ty);
  expected.setTransform(1 / scale, 0, 0, 1 / scale, tx, ty);
  expected.imageSmoothingEnabled = false;
  expected.globalCompositeOperation = 'copy';
  expected.drawImage(reference.canvas, 0, 0, 512, 512);
  region.paintResidentView(output, { x: -tx * scale, y: -ty * scale,
    width: 640 * scale, height: 640 * scale, scale });
  // Exclude only the full texture's outer rasterized edge. All internal page
  // joins, material pixels, transparent holes and translucent pixels are exact.
  const left = Math.ceil(tx + 2), top = Math.ceil(ty + 2);
  const width = Math.min(638, Math.floor(tx + 512 / scale - 2)) - left;
  const height = Math.min(638, Math.floor(ty + 512 / scale - 2)) - top;
  expect(output.getImageData(left, top, width, height).data)
    .toEqual(expected.getImageData(left, top, width, height).data);
  expect(owner.stats.viewScratchBytes).toBe(260 * 260 * 4);
  expect(owner.stats.reductionBytes).toBeLessThanOrEqual(349524);
});

it.each([.65, 1.23, 2.46, 9.7, 1024])('does not punch alpha seams into opaque coverage at scale %s', scale => {
  const { owner } = fixture(), region = owner.region('solid', 512, 512);
  owner.install(`solid/${region.maxLevel}/0/0`, context(256, 256, '#ff4000'), new Uint8Array([1]), 1, 1, false);
  const output = context(440, 440, '#205070');
  output.setTransform(1 / scale, 0, 0, 1 / scale, 20.25, 30.7);
  region.paintResidentView(output, { x: -20.25 * scale, y: -30.7 * scale,
    width: 440 * scale, height: 440 * scale, scale });
  const actual = bytes(output);
  let translucent = 0;
  for (let i = 3; i < actual.length; i += 4) if (actual[i] !== 255) translucent++;
  expect(translucent).toBe(0);
  expect(owner.stats.viewScratchBytes).toBeLessThanOrEqual(260 * 260 * 4);
  expect(owner.stats.reductionBytes).toBeLessThanOrEqual(350000);
  owner.dispose();
  expect(owner.stats.viewScratchBytes).toBe(0);
  expect(owner.stats.reductionBytes).toBe(0);
});

it('erases fully transparent known cells at fractional boundaries in an otherwise partly unknown mip', () => {
  const { owner } = fixture(), region = owner.region('air', 512, 512);
  const page = context(256, 256, '#ff0000');
  page.clearRect(0, 0, 128, 128);
  owner.install(`air/${region.maxLevel - 1}/0/0`, page, new Uint8Array([1]), 2, 2, false);
  const output = context(240, 240, '#205070'), scale = 2.46, tx = 20.25, ty = 30.7;
  output.setTransform(1 / scale, 0, 0, 1 / scale, tx, ty);
  region.paintResidentView(output, { x: -tx * scale, y: -ty * scale,
    width: 240 * scale, height: 240 * scale, scale });
  for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) {
    const known = x + .5 >= tx && x + .5 < tx + 256 / scale && y + .5 >= ty && y + .5 < ty + 256 / scale;
    expect(pixel(output, x, y)[3]).toBe(known ? 0 : 255);
  }
});


it('projects a complete coarse page once, rather than once per native coverage row', () => {
  const { owner } = fixture(), region = owner.region('coarse', 65536, 65536);
  const page = context(256, 256, '#20c050');
  owner.install(`coarse/${region.minLevel}/0/0`, page, new Uint8Array(8192).fill(255), 256, 256, false);
  const draw = vi.spyOn(owner, 'paintViewSample');
  const output = context(256, 256); output.scale(1 / 256, 1 / 256);
  const coverage = region.paintResidentView(output, { x: 0, y: 0, width: 65536, height: 65536, scale: 256 });
  expect(coverage).toHaveLength(256);
  expect(draw).toHaveBeenCalledOnce();
  expect(bytes(output)).toEqual(bytes(page));
});

it('keeps an extremely reduced native fallback opaque when its coverage contains one display pixel', () => {
  const { owner } = fixture(), region = owner.region('far', 512, 512);
  owner.install(`far/${region.maxLevel}/0/0`, context(256, 256, '#ff4000'), new Uint8Array([1]), 1, 1, false);
  const output = context(32, 48, '#205070'), scale = 1024, tx = 20.4, ty = 30.4;
  output.setTransform(1 / scale, 0, 0, 1 / scale, tx, ty);
  region.paintResidentView(output, { x: -tx * scale, y: -ty * scale,
    width: 32 * scale, height: 48 * scale, scale });
  expect(pixel(output, 20, 30)).toEqual([255, 64, 0, 255]);
  expect(pixel(output, 21, 30)).toEqual([32, 80, 112, 255]);
  expect(owner.stats.viewScratchBytes).toBe(260 * 260 * 4);
});
