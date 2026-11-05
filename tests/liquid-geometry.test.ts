import { describe, expect, it } from 'vitest';
import { inverseCamera, liquidReprojection, liquidScreenCrop, liquidViewBounds, LIQUID_ENTER_SCALE, LIQUID_EXIT_SCALE, LIQUID_MAX_FRAME_PIXELS } from '../src/liquids/geometry';
import type { CameraMatrix } from '../src/portals/geometry';

const identity: CameraMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const transform = (m: CameraMatrix, x: number, y: number) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

describe('liquid camera and physical crop geometry', () => {
  it.each([
    { a: 2, b: 0, c: 0, d: 2, e: -30, f: 10 },
    { a: 0, b: 1.5, c: -1.5, d: 0, e: 700, f: -10 },
    { a: -1, b: 0, c: 0, d: 1, e: 800, f: 0 },
  ])('reprojects a cropped frame to the same world position through pan/zoom/rotation/flip %#', current => {
    const rendered = { a: 1.3, b: 0.2, c: -0.2, d: 1.3, e: 50, f: 70 };
    const crop = { x: 97.5, y: 83.25, width: 61, height: 43 };
    const p = liquidReprojection(current, rendered, crop, 800, 600)!;
    const inverse = inverseCamera(rendered)!;
    for (const [x, y] of [[0, 0], [61, 43], [30.5, 21.5]]) {
      const [wx, wy] = transform(inverse, crop.x + x, crop.y + y);
      const expected = transform(current, wx, wy);
      const actual = transform(p.matrix, x, y);
      expect(actual[0] + crop.x).toBeCloseTo(expected[0], 8);
      expect(actual[1] + crop.y).toBeCloseTo(expected[1], 8);
    }
  });
  it('marks a retained crop invisible only when its transformed bounds leave the viewport', () => {
    const crop = { x: 97, y: 97, width: 46, height: 36 };
    expect(liquidReprojection({ ...identity, e: -140 }, identity, crop, 800, 600)?.visible).toBe(true);
    expect(liquidReprojection({ ...identity, e: -144 }, identity, crop, 800, 600)?.visible).toBe(false);
    expect(liquidReprojection({ ...identity, e: NaN }, identity, crop, 800, 600)).toBeNull();
  });
  it.each([
    identity,
    { a: 2, b: 0, c: 0, d: 2, e: -200, f: 100 },
    { a: 0, b: 2, c: -2, d: 0, e: 800, f: 0 },
    { a: -1, b: 0, c: 0, d: 1, e: 800, f: 0 },
    { a: 1.2, b: 0.5, c: -0.3, d: 2, e: -123.75, f: 77.2 },
  ])('inverts camera $a,$b,$c,$d,$e,$f without changing world coordinates', camera => {
    const inverse = inverseCamera(camera)!;
    expect(inverse).not.toBeNull();
    for (const [x, y] of [[0, 0], [-12.5, 99.25], [15000, -28000]]) {
      const [sx, sy] = transform(camera, x, y), [wx, wy] = transform(inverse, sx, sy);
      expect(wx).toBeCloseTo(x, 9); expect(wy).toBeCloseTo(y, 9);
    }
  });

  it('pads native world bounds by two pixels after inverting the whole viewport', () => {
    expect(liquidViewBounds(identity, 800, 600, false)).toEqual({ x: -2, y: -2, width: 804, height: 604 });
    expect(liquidViewBounds({ a: 2, b: 0, c: 0, d: 2, e: -200, f: 100 }, 800, 600, false))
      .toEqual({ x: 98, y: -52, width: 404, height: 304 });
    expect(liquidViewBounds({ a: 0, b: 2, c: -2, d: 0, e: 800, f: 0 }, 800, 600, false))
      .toEqual({ x: -2, y: -2, width: 304, height: 404 });
    expect(liquidViewBounds({ a: -1, b: 0, c: 0, d: 1, e: 800, f: 0 }, 800, 600, false))
      .toEqual({ x: -2, y: -2, width: 804, height: 604 });
  });

  it('uses separate entering and exiting scales to avoid threshold flicker', () => {
    const camera = (scale: number) => ({ ...identity, a: scale, d: scale });
    expect(liquidViewBounds(camera(LIQUID_ENTER_SCALE - 0.001), 800, 600, false)).toBeNull();
    expect(liquidViewBounds(camera(LIQUID_ENTER_SCALE), 800, 600, false)).not.toBeNull();
    expect(liquidViewBounds(camera(LIQUID_EXIT_SCALE), 800, 600, true)).not.toBeNull();
    expect(liquidViewBounds(camera(LIQUID_EXIT_SCALE - 0.001), 800, 600, true)).toBeNull();
  });

  it('maps physical pixel centers through independently rounded horizontal and vertical ratios', () => {
    const crop = liquidScreenCrop(identity, { x: 10, y: 20, width: 30, height: 40 }, 800, 600, 2, 3)!;
    expect(crop).toMatchObject({ x: 14, y: 51, width: 72, height: 138 });
    expect(crop.screenToWorld).toEqual([0.5, -0, -0, 1 / 3, 7, 17]);
    const [a, b, c, d, e, f] = crop.screenToWorld;
    expect(a * 0.5 + c * 0.5 + e).toBeCloseTo(7.25);
    expect(b * 0.5 + d * 0.5 + f).toBeCloseTo(17 + 1 / 6);
  });

  it('accepts the actual provider mask shape, including its pixel payload', () => {
    const mask = { x: 10, y: 20, width: 30, height: 40, pixels: new Uint8Array(1200) };
    expect(liquidScreenCrop(identity, mask, 800, 600, 1)).toMatchObject({ x: 7, y: 17, width: 36, height: 46 });
  });

  it.each([
    { camera: identity, ratio: 1.5, ratioY: 2.25 },
    { camera: { a: 0, b: 1, c: -1, d: 0, e: 100, f: 20 }, ratio: 1.25, ratioY: 1.5 },
    { camera: { a: -2, b: 0, c: 0, d: 2, e: 400, f: -20 }, ratio: 1.25, ratioY: 2 },
    { camera: { a: 0.8, b: 0.6, c: -0.6, d: 0.8, e: 200.1, f: 50.2 }, ratio: 1.333, ratioY: 1.499 },
  ])('keeps crop-local sampling aligned under camera and pixel ratios %#', ({ camera, ratio, ratioY }) => {
    const crop = liquidScreenCrop(camera, { x: 10, y: 20, width: 30, height: 40 }, 800, 600, ratio, ratioY)!;
    expect(crop).not.toBeNull();
    const [a, b, c, d, e, f] = crop.screenToWorld;
    for (const [px, py] of [[0.5, 0.5], [crop.width - 0.5, crop.height - 0.5], [crop.width * 0.4, crop.height * 0.3]]) {
      const worldX = a * px + c * py + e, worldY = b * px + d * py + f;
      const [sx, sy] = transform(camera, worldX, worldY);
      expect(sx * ratio).toBeCloseTo(crop.x + px, 9);
      expect(sy * ratioY).toBeCloseTo(crop.y + py, 9);
    }
    expect([crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger)).toBe(true);
    expect(crop.x).toBeGreaterThanOrEqual(0); expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(Math.round(800 * ratio));
    expect(crop.y + crop.height).toBeLessThanOrEqual(Math.round(600 * ratioY));
  });

  it('clips to the source and reduces oversized crops without disabling the effect', () => {
    expect(liquidScreenCrop(identity, { x: -10, y: -10, width: 20, height: 20 }, 100, 100, 1.5))
      .toMatchObject({ x: 0, y: 0, width: 20, height: 20 });
    expect(liquidScreenCrop(identity, { x: -100, y: 10, width: 10, height: 10 }, 100, 100, 1)).toBeNull();
    expect(liquidScreenCrop(identity, { x: 110, y: 10, width: 10, height: 10 }, 100, 100, 1)).toBeNull();
    const limit = liquidScreenCrop(identity, { x: 0, y: 0, width: 2048, height: 2048 }, 2048, 2048, 1)!;
    expect(limit.width * limit.height).toBe(LIQUID_MAX_FRAME_PIXELS);
    const large = liquidScreenCrop(identity, { x: 0, y: 0, width: 3840, height: 2160 }, 3840, 2160, 2)!;
    expect(large).toMatchObject({ x: 0, y: 0, width: 7680, height: 4320, renderWidth: 2048, renderHeight: 1152 });
    expect(large.renderWidth * large.renderHeight).toBeLessThanOrEqual(LIQUID_MAX_FRAME_PIXELS);
    const [a, b, c, d, e, f] = large.screenToWorld;
    for (const [px, py] of [[0.5, 0.5], [2047.5, 1151.5]]) {
      expect(a * px + c * py + e).toBeCloseTo(px * 3840 / 2048);
      expect(b * px + d * py + f).toBeCloseTo(py * 2160 / 1152);
    }
  });

  it.each([
    { ...identity, a: 0, d: 0 },
    { ...identity, a: 1, b: 2, c: 2, d: 4 },
    { ...identity, e: NaN }, { ...identity, f: Infinity },
    { ...identity, a: Number.MAX_VALUE, d: Number.MAX_VALUE },
    { ...identity, a: 0.000001, d: 0.000001, e: Number.MAX_VALUE },
  ])('rejects singular, non-finite, or overflowing camera transforms %#', camera => {
    expect(inverseCamera(camera)).toBeNull();
    expect(liquidViewBounds(camera, 800, 600, false)).toBeNull();
    expect(liquidScreenCrop(camera, { x: 10, y: 20, width: 30, height: 40 }, 800, 600, 1)).toBeNull();
  });

  it.each([[NaN, 600], [800, Infinity], [Infinity, 600], [800, NaN], [0, 600], [800, -1]])
    ('rejects malformed viewport %s by %s before preparing masks', (width, height) => {
      expect(liquidViewBounds(identity, width, height, false)).toBeNull();
      expect(liquidScreenCrop(identity, { x: 10, y: 20, width: 30, height: 40 }, width, height, 1)).toBeNull();
    });

  it.each([
    { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: -1, height: 10 },
    { x: 0, y: 0, width: NaN, height: 10 }, { x: Infinity, y: 0, width: 10, height: 10 },
    { x: 0, y: NaN, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: Infinity },
    { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 10 },
  ])('rejects malformed native mask bounds %#', mask => {
    expect(liquidScreenCrop(identity, mask, 800, 600, 1)).toBeNull();
  });

  it('rejects finite camera bounds that cannot represent individual native world pixels', () => {
    expect(liquidViewBounds({ ...identity, e: Number.MAX_VALUE }, 800, 600, false)).toBeNull();
    expect(liquidViewBounds({ ...identity, a: 1e308, d: 1e-308 }, 800, 600, false)).toBeNull();
  });

  it.each([[0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [1, 0], [1, -1], [1, NaN], [1, Infinity]])
    ('rejects invalid physical source ratios %s and %s', (ratio, ratioY) => {
      expect(liquidScreenCrop(identity, { x: 10, y: 20, width: 30, height: 40 }, 800, 600, ratio, ratioY)).toBeNull();
    });
});
