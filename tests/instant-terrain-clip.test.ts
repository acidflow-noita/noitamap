import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { createInstantClip, type InstantClipView } from '../src/telescope/instant-terrain-clip';
import type { StaticTerrainMask } from '../src/telescope/static-terrain-mask';

const owners = Array.from({ length: 3 }, () => ({ width: 70, owners: new Int16Array(70 * 48) }));
const empty = createCanvas(0, 0);
let allocated: Canvas[];

beforeEach(() => {
  allocated = [];
  vi.stubGlobal('document', { createElement: () => {
    const canvas = createCanvas(1, 1);
    allocated.push(canvas);
    return canvas;
  } });
});
afterEach(() => vi.unstubAllGlobals());

function patternedMask(width: number, height: number, x = 0, y = 0): StaticTerrainMask {
  const bits = new Uint8Array(Math.ceil(width * height / 8));
  const airBits = new Uint8Array(bits.length);
  for (let p = 0; p < width * height; p++) {
    if ((p % width) % 7 < 3) bits[p >> 3] |= 1 << (p & 7);
    else if (Math.floor(p / width) % 11 < 2) airBits[p >> 3] |= 1 << (p & 7);
  }
  return { x, y, width, height, bits, airBits };
}

/** Independent original full-mask composition, without crop pages. */
function reference(masks: StaticTerrainMask[], view: InstantClipView) {
  const context = createCanvas(view.width, view.height).getContext('2d');
  context.fillStyle = '#457c9a'; context.fillRect(0, 0, view.width, view.height);
  context.globalCompositeOperation = 'destination-out';
  context.imageSmoothingEnabled = false;
  for (const mask of masks) {
    const full = createCanvas(mask.width, mask.height).getContext('2d');
    const image = full.createImageData(mask.width, mask.height);
    for (let p = 0; p < mask.width * mask.height; p++)
      if (((mask.bits[p >> 3] ?? 0) | (mask.airBits?.[p >> 3] ?? 0)) & (1 << (p & 7))) image.data[p * 4 + 3] = 255;
    full.putImageData(image, 0, 0);
    context.drawImage(full.canvas, (mask.x - view.x) / view.scale, (mask.y - view.y) / view.scale,
      mask.width / view.scale, mask.height / view.scale);
  }
  return context.getImageData(0, 0, view.width, view.height).data;
}

function draw(clip: ReturnType<typeof createInstantClip>, view: InstantClipView) {
  const source = createCanvas(view.width, view.height);
  source.getContext('2d').fillStyle = '#457c9a';
  source.getContext('2d').fillRect(0, 0, view.width, view.height);
  const context = createCanvas(view.width, view.height).getContext('2d');
  clip.draw(context as unknown as CanvasRenderingContext2D, source as unknown as CanvasImageSource, view);
  return context.getImageData(0, 0, view.width, view.height).data;
}

describe('bounded native terrain mask pages', () => {
  it('does not expand an 8192-square scene while zooming and reuses one bounded mask buffer', () => {
    const width = 8192, height = 8192;
    const masks = [{ x: 0, y: 0, width, height, bits: new Uint8Array(width * height / 8).fill(255) }];
    const clip = createInstantClip(owners, masks, { maxBytes: 1024 * 1024 });
    for (const scale of [16, 8, 2, .5, 4, 16]) {
      const actual = draw(clip, { x: 0, y: 0, width: 512, height: 512, scale });
      expect(actual.every(value => value === 0)).toBe(true);
    }
    expect(allocated).toHaveLength(1);
    expect(allocated[0].width * allocated[0].height * 4).toBe(256 * 256 * 4);
    clip.dispose();
  });

  it.each([
    { x: 0, y: 0, maskX: 0, maskY: 0 },
    { x: 250, y: 250, maskX: 0, maskY: 0 },
    { x: -30, y: -25, maskX: 13, maskY: 19 },
    { x: 480.5, y: 750.25, maskX: -0.25, maskY: 0.75 },
    { x: -0.5, y: 0.25, maskX: 13.75, maskY: -21.5 },
  ])('matches whole-mask pixels at $x,$y with scene placement $maskX,$maskY', ({ x, y, maskX, maskY }) => {
    const masks = [patternedMask(1025, 1139, maskX, maskY), patternedMask(287, 321, 250.5, 253.25)];
    const clip = createInstantClip(owners, masks);
    const view = { x, y, width: 512, height: 512, scale: 1 };
    const actual = draw(clip, view), expected = reference(masks, view);
    const mismatches = [];
    for (let i = 0; i < actual.length && mismatches.length < 10; i += 4)
      if (actual[i + 3] !== expected[i + 3]) mismatches.push({ x: (i / 4) % view.width, y: Math.floor(i / 4 / view.width), actual: actual[i + 3], expected: expected[i + 3] });
    expect(Buffer.from(actual).equals(Buffer.from(expected)), JSON.stringify(mismatches)).toBe(true);
    expect(allocated.every(canvas => canvas.width <= 513 && canvas.height <= 513)).toBe(true);
    clip.dispose();
  });

  it('expands at most nine 256px pages for a 512px request inside a giant scene', () => {
    const width = 8192, height = 8192;
    const mask = { x: 0, y: 0, width, height, bits: new Uint8Array(width * height / 8).fill(255) };
    const clip = createInstantClip(owners, [mask]);
    const pixels = draw(clip, { x: 17, y: 31, width: 512, height: 512, scale: 1 });
    expect(pixels.every(value => value === 0)).toBe(true);
    expect(allocated).toHaveLength(9);
    expect(allocated.every(canvas => canvas.width === 256 && canvas.height === 256)).toBe(true);
    expect(allocated.reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0)).toBe(9 * 256 * 256 * 4);
    clip.dispose();
  });

  it.each([0.2, 0.5, 0.8])('preserves solid mask alpha across page seams and outer edges at fractional offset %s', offset => {
    const width = 513, height = 513;
    const masks = [{ x: offset, y: offset, width, height, bits: new Uint8Array(Math.ceil(width * height / 8)).fill(255) }];
    const clip = createInstantClip(owners, masks);
    for (const start of [0, 128.25, 255.75]) {
      const view = { x: start, y: start, width: 512, height: 512, scale: 1 };
      expect(Buffer.from(draw(clip, view)).equals(Buffer.from(reference(masks, view)))).toBe(true);
    }
    clip.dispose();
  });

  it('shares cached pages across overlapping native requests and repeated scene placements', () => {
    const mask = patternedMask(1024, 1024);
    const clip = createInstantClip(owners, [mask, { ...mask, x: 2048 }]);
    draw(clip, { x: 0, y: 0, width: 512, height: 512, scale: 1 });
    expect(allocated).toHaveLength(4);
    draw(clip, { x: 256, y: 0, width: 512, height: 512, scale: 1 });
    expect(allocated).toHaveLength(6);
    draw(clip, { x: 2048, y: 0, width: 512, height: 512, scale: 1 });
    expect(allocated).toHaveLength(6);
    clip.dispose();
    // Native Skia normalizes a zero-sized canvas to its empty default size.
    expect(allocated.every(canvas => canvas.width === empty.width && canvas.height === empty.height)).toBe(true);
  });

  it('evicts cold pages at 32 MiB and reconstructs their exact pixels on demand', () => {
    const mask = patternedMask(256, 256 * 129);
    const clip = createInstantClip(owners, [mask]);
    const view = { x: 0, y: 0, width: 256, height: 256, scale: 1 };
    const first = draw(clip, view);
    for (let page = 1; page < 129; page++) draw(clip, { ...view, y: page * 256 });
    expect(allocated).toHaveLength(129);
    expect(allocated[0].width).toBe(empty.width);
    const retainedBytes = allocated.filter(canvas => canvas.width !== empty.width)
      .reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0);
    expect(retainedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(Buffer.from(draw(clip, view)).equals(Buffer.from(first))).toBe(true);
    expect(allocated).toHaveLength(130);
    clip.dispose();
  });

  it('does not reuse a material bitmap with a different force-air mask', () => {
    const bits = new Uint8Array(256 * 256 / 8);
    const masks = [
      { x: 0, y: 0, width: 256, height: 256, bits, airBits: new Uint8Array(bits.length) },
      { x: 256, y: 0, width: 256, height: 256, bits, airBits: new Uint8Array(bits.length).fill(255) },
    ];
    const view = { x: 0, y: 0, width: 512, height: 256, scale: 1 };
    const clip = createInstantClip(owners, masks);
    const actual = draw(clip, view), expected = reference(masks, view);
    const mismatch = [];
    for (let i = 0; i < actual.length && mismatch.length < 20; i += 4)
      if (actual[i+3] !== expected[i+3]) mismatch.push([i/4%view.width, Math.floor(i/4/view.width), actual[i+3], expected[i+3]]);
    expect(Buffer.from(actual).equals(Buffer.from(expected)), JSON.stringify(mismatch)).toBe(true);
    clip.dispose();
  });

  it.each([0.25, 0.5, 0.8, 1.01, 2, 4, 8, 32])('preserves whole-mask viewport sampling at scale %s with bounded buffers', scale => {
    const masks = [patternedMask(1025, 1139, -10.25, 19.5)];
    const view = { x: 0.25, y: 0.5, width: 512, height: 512, scale };
    const clip = createInstantClip(owners, masks);
    const actual = draw(clip, view), expected = reference(masks, view);
    const mismatch = [];
    for (let i = 0; i < actual.length && mismatch.length < 20; i += 4)
      if (actual[i+3] !== expected[i+3]) mismatch.push([i/4%view.width, Math.floor(i/4/view.width), actual[i+3], expected[i+3]]);
    expect(Buffer.from(actual).equals(Buffer.from(expected)), JSON.stringify(mismatch)).toBe(true);
    expect(allocated).toHaveLength(1);
    expect(allocated[0].width).toBe(256);
    clip.dispose();
  });
});
