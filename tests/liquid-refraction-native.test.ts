import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { LiquidRenderer, LIQUID_MAX_COLOR_PIXELS, LIQUID_MAX_MASK_PIXELS } from '../src/liquids/renderer.mjs';
import { liquidFixture, nativeLiquidGL, referenceLiquid } from './helpers/liquid-refraction-native.mjs';

const pixel = (data: Uint8Array, width: number, x: number, y: number) => [...data.subarray((y * width + x) * 4, (y * width + x + 1) * 4)];
const maximumError = (a: Uint8Array, b: Uint8Array) => a.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - b[index])), 0);

describe('liquid refraction on real software GLES, without a browser', () => {
  let native: ReturnType<typeof nativeLiquidGL>, canvas: InstanceType<ReturnType<typeof nativeLiquidGL>['Canvas']>, renderer: LiquidRenderer;
  beforeAll(() => { native = nativeLiquidGL(); });
  beforeEach(() => { canvas = new native.Canvas(); renderer = new LiquidRenderer(canvas); });
  afterEach(() => { renderer.dispose(); vi.restoreAllMocks(); });
  afterAll(() => { native.dispose(); });
  const render = (source: ReturnType<typeof liquidFixture>, time: number, strength = 1) => {
    expect(renderer.setSource(source)).toBe(true);
    native.gl.finish(); // Only the native fixture waits for uploads explicitly.
    expect(renderer.render(time, strength)).toBe(true);
    return native.read(source.width, source.height);
  };

  it('moves both water and lava using the native phase while leaving opaque solids unchanged', () => {
    const maskAt = (x: number, y: number) => x >= 3 && x < 61 && y >= 3 && y < 45 && (x < 30 || x >= 34) ? (x < 30 ? 255 : 1) : 0;
    const source = liquidFixture(64, 48, {
      maskAt,
      colorAt: (x: number, y: number) => !maskAt(Math.floor(x), Math.floor(y)) ? [255, 0, 255, 255] : x < 32
        ? [0, 30 + (Math.floor(x) * 13 + Math.floor(y) * 17) % 160, 120 + Math.floor(y) % 80, 255]
        : [150 + (Math.floor(x) * 13 + Math.floor(y) * 3) % 100, 20 + (Math.floor(x) * 7 + Math.floor(y) * 17) % 100, 0, 255],
    });
    const first = render(source, 0);
    expect(maximumError(first, referenceLiquid(source, 0))).toBeLessThanOrEqual(1);
    renderer.render(0.173);
    const second = native.read(source.width, source.height);
    expect(maximumError(second, referenceLiquid(source, 0.173))).toBeLessThanOrEqual(1);
    let movingWater = 0, movingLava = 0, unchangedSolids = 0, invalidPixels = 0;
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4;
      if (!maskAt(x, y)) {
        if (second.subarray(i, i + 4).some(Boolean)) invalidPixels++;
        // The transparent overlay composites onto the original opaque map.
        const alpha = second[i + 3] / 255;
        if ([0, 1, 2].every(c => second[i + c] + source.color.data[i + c] * (1 - alpha) === source.color.data[i + c])) unchangedSolids++;
      } else {
        if (second[i + 3] !== 255 || (x < 32 ? second[i] !== 0 : second[i + 2] !== 0)) invalidPixels++;
        if (first.subarray(i, i + 3).some((value, channel) => value !== second[i + channel])) {
          if (x < 32) movingWater++; else movingLava++;
        }
      }
    }
    expect(movingWater).toBeGreaterThan(500);
    expect(movingLava).toBeGreaterThan(500);
    expect(unchangedSolids).toBeGreaterThan(500);
    expect(invalidPixels).toBe(0);
  });

  it('never imports black, white, magenta, or transparent solid texels across a mask boundary', () => {
    const eligible = (x: number, y: number) => x >= 8 && x < 40 && y >= 8 && y < 34 && !(x >= 21 && x < 25 && y >= 18 && y < 22);
    const solidColors = [[0, 0, 0, 255], [255, 255, 255, 255], [255, 0, 255, 255], [255, 255, 255, 0]];
    const source = liquidFixture(48, 40, {
      maskAt: (x: number, y: number) => eligible(x, y) ? 255 : 0,
      colorAt: (x: number, y: number) => eligible(Math.floor(x), Math.floor(y)) ? [40, 90, 170, 255] : solidColors[(Math.floor(x) + Math.floor(y)) % 4],
    });
    renderer.setSource(source);
    native.gl.finish();
    for (const time of [0, 0.07, 0.17, 0.32, 0.51]) {
      renderer.render(time);
      const pixels = native.read(48, 40);
      let incorrect = 0;
      for (let y = 0; y < 40; y++) for (let x = 0; x < 48; x++) {
        const expected = eligible(x, y) ? [40, 90, 170, 255] : [0, 0, 0, 0];
        if (pixel(pixels, 48, x, y).some((value, channel) => value !== expected[channel])) incorrect++;
      }
      expect(incorrect).toBe(0);
    }
  });

  it('gates the displaced world position independently and falls back to the original liquid pixel', () => {
    const source = liquidFixture(48, 32, { maskAt: (x: number, y: number) => x % 6 < 3 && y % 7 < 5 ? 255 : 0 });
    const time = 0.19, actual = render(source, time);
    let rejected = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 48; x++) {
      if (!source.mask[y * 48 + x]) continue;
      const dx = 0.854 * Math.sin(time * 10 + (x + 0.5) * 50 / 427);
      const dy = -0.484 * Math.cos(time * 10 + 50 - (y + 0.5) * 50 / 242);
      const mx = Math.floor(x + 0.5 + dx), my = Math.floor(y + 0.5 + dy);
      if (mx >= 0 && my >= 0 && mx < 48 && my < 32 && source.mask[my * 48 + mx]) continue;
      expect(pixel(actual, 48, x, y)).toEqual(pixel(source.color.data, 48, x, y));
      rejected++;
    }
    expect(rejected).toBeGreaterThan(50);
  });

  it('matches the source at zero strength and preserves premultiplied source alpha', () => {
    const source = liquidFixture(24, 16, {
      maskAt: (x: number, y: number) => x > 2 && x < 21 && y > 2 && y < 13 ? 255 : 0,
      colorAt: (x: number, y: number) => [170, 90, 35, 80 + Math.floor(x + y) * 3],
    });
    const actual = render(source, 42, 0);
    expect(maximumError(actual, referenceLiquid(source, 42, 0))).toBeLessThanOrEqual(1);
    expect(pixel(actual, 24, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(actual[(8 * 24 + 8) * 4 + 3]).toBe(source.color.data[(8 * 24 + 8) * 4 + 3]);
    renderer.render(42, -1);
    expect(native.read(24, 16)).toEqual(actual);
  });

  it('accepts the browser canvas upload signature with the same top-down orientation', () => {
    const source = liquidFixture(24, 16);
    const image = createCanvas(source.width, source.height);
    image.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(source.color.data), source.width, source.height), 0, 0);
    // Native canvas also has a data() method that browser canvases do not.
    const browserImage = { width: image.width, height: image.height, getContext: () => image.getContext('2d') };
    renderer.setSource({ ...source, color: browserImage });
    native.gl.finish();
    renderer.render(0.123);
    expect(maximumError(native.read(24, 16), referenceLiquid(source, 0.123))).toBeLessThanOrEqual(1);
  });

  it('uses explicit DOM upload extents through cold, growing, shrinking and same-size refreshes', () => {
    const upload = vi.spyOn(native.gl, 'texSubImage2D');
    for (const [width, height, maskWidth, maskHeight] of [[73, 41, 75, 43], [211, 127, 213, 129],
      [19, 13, 25, 17], [19, 13, 25, 17], [87, 55, 89, 57]]) {
      const source = liquidFixture(width, height, { maskWidth, maskHeight });
      const image = createCanvas(width, height);
      image.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(source.color.data), width, height), 0, 0);
      const browserImage = { width, height, getContext: () => image.getContext('2d') };
      expect(renderer.setSource({ ...source, color: browserImage })).toBe(true);
      const call = [...upload.mock.calls].reverse().find(args => args[8] === browserImage)!;
      expect(call).toHaveLength(9); expect(call.slice(4, 6)).toEqual([width, height]);
      native.gl.finish(); expect(renderer.render(0, 0)).toBe(true);
      expect(maximumError(native.read(width, height), referenceLiquid(source, 0, 0))).toBeLessThanOrEqual(1);
      expect(native.gl.getError()).toBe(0);
    }
  });

  it('uses absolute world phase across adjacent crops with a two-pixel sampling guard', () => {
    const shared = { maskX: 100, maskY: 220, maskWidth: 128, maskHeight: 48 };
    const time = 0.278, whole = liquidFixture(128, 48, { ...shared, screenToWorld: [1, 0, 0, 1, 100, 220] });
    const full = render(whole, time);
    for (const start of [0, 60]) {
      const crop = liquidFixture(68, 48, { ...shared, screenToWorld: [1, 0, 0, 1, 100 + start, 220] });
      const actual = render(crop, time);
      let error = 0;
      for (let y = 2; y < 46; y++) for (let x = 2; x < 66; x++) for (let c = 0; c < 4; c++)
        error = Math.max(error, Math.abs(actual[(y * 68 + x) * 4 + c] - full[(y * 128 + x + start) * 4 + c]));
      expect(error).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the same world displacement under a horizontal flip and a quarter-turn', () => {
    const shared = { maskX: 100, maskY: 200, maskWidth: 64, maskHeight: 40 };
    const time = 0.137;
    const original = render(liquidFixture(64, 40, { ...shared, screenToWorld: [1, 0, 0, 1, 100, 200] }), time);
    for (const rotated of [false, true]) {
      const width = rotated ? 40 : 64, height = rotated ? 64 : 40;
      const source = liquidFixture(width, height, { ...shared, screenToWorld: rotated ? [0, 1, -1, 0, 164, 200] : [-1, 0, 0, 1, 164, 200] });
      const actual = render(source, time);
      let error = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
        const ox = rotated ? 63 - y : 63 - x, oy = rotated ? x : y;
        error = Math.max(error, Math.abs(actual[(y * width + x) * 4 + c] - original[(oy * 64 + ox) * 4 + c]));
      }
      expect(error).toBeLessThanOrEqual(1);
    }
  });

  it('handles a scaled oblique affine transform and independently bounds a smaller world mask', () => {
    const angle = Math.PI / 6, scale = 0.6;
    const source = liquidFixture(36, 28, {
      maskX: 100, maskY: 205, maskWidth: 20, maskHeight: 20,
      screenToWorld: [scale * Math.cos(angle), scale * Math.sin(angle), -scale * Math.sin(angle), scale * Math.cos(angle), 105.25, 201.4],
    });
    const actual = render(source, 0.229);
    expect(maximumError(actual, referenceLiquid(source, 0.229))).toBeLessThanOrEqual(2);
    expect(actual.filter((_, index) => index % 4 === 3 && actual[index] === 0).length).toBeGreaterThan(100);
    expect(actual.filter((_, index) => index % 4 === 3 && actual[index] === 255).length).toBeGreaterThan(100);
  });

  it('performs no texture uploads or reallocations during animation and reuses same-sized textures on refresh', () => {
    const source = liquidFixture(64, 48);
    renderer.setSource(source);
    native.gl.finish();
    const before = native.counts(), statsBefore = renderer.stats();
    for (let i = 0; i < 60; i++) { expect(renderer.render(i / 60)).toBe(true); native.gl.finish(); }
    expect(native.counts()).toMatchObject({ uploads: before.uploads, allocations: before.allocations, draws: before.draws + 60 });
    expect(renderer.stats()).toMatchObject({ uploads: 2, allocations: 2, frames: 60, skippedFrames: 0, sourceUpdates: 1, textures: 2 });
    expect(native.counts()).toMatchObject({ liveSyncs: 1, maxLiveSyncs: 1, syncsCreated: before.syncsCreated + 60 });
    expect(renderer.stats().textureBytes).toBe(64 * 48 * 5);
    expect(renderer.stats().estimatedGPUBytes).toBe(64 * 48 * 13);
    renderer.setSource(source);
    expect(renderer.stats()).toMatchObject({ uploads: 4, allocations: statsBefore.allocations, sourceUpdates: 2, textures: 2 });
    expect(native.counts()).toMatchObject({ allocations: before.allocations, liveTextures: 2, livePrograms: 1, liveVertexArrays: 1, liveShaders: 0 });
    expect(native.gl.getError()).toBe(0);
  });

  it('keeps exactly one frame in flight and polls a stalled fence without waiting or submitting work', () => {
    renderer.setSource(liquidFixture(32, 24)); native.gl.finish();
    expect(renderer.render(0)).toBe(true);
    const before = native.counts();
    const wait = vi.spyOn(native.gl, 'clientWaitSync').mockReturnValue(native.gl.TIMEOUT_EXPIRED);
    const finish = vi.spyOn(native.gl, 'finish');
    for (let i = 0; i < 120; i++) expect(renderer.render(i / 30)).toBeNull();
    expect(wait).toHaveBeenCalledTimes(120);
    expect(wait.mock.calls.every(([, flags, timeout]) => flags === 0 && timeout === 0)).toBe(true);
    expect(finish).not.toHaveBeenCalled();
    expect(native.counts()).toEqual(before);
    expect(renderer.stats()).toMatchObject({ ready: true, busy: true, pendingGPU: 'frame', pendingSyncs: 1, frames: 1, skippedFrames: 120 });
    wait.mockRestore(); native.gl.finish();
    expect(renderer.render(4)).toBe(true);
    expect(renderer.stats()).toMatchObject({ frames: 2, skippedFrames: 120, pendingSyncs: 1 });
    expect(native.counts()).toMatchObject({ draws: before.draws + 1, syncsCreated: before.syncsCreated + 1, syncsDeleted: before.syncsDeleted + 1, maxLiveSyncs: 1 });
    const deletion = vi.spyOn(native.gl, 'deleteSync');
    renderer.dispose(); renderer.dispose();
    expect(deletion).toHaveBeenCalledOnce();
    expect(native.counts().liveSyncs).toBe(0);
    expect(renderer.stats()).toMatchObject({ busy: false, pendingSyncs: 0, disposed: true });
  });

  it.each(['source', 'frame'])('does not resize or queue source uploads while a %s fence is pending', kind => {
    const original = liquidFixture(16, 16), replacement = liquidFixture(48, 32);
    expect(renderer.setSource(original)).toBe(true);
    if (kind === 'frame') { native.gl.finish(); expect(renderer.render(0)).toBe(true); }
    const before = native.counts();
    const wait = vi.spyOn(native.gl, 'clientWaitSync').mockReturnValue(native.gl.TIMEOUT_EXPIRED);
    const finish = vi.spyOn(native.gl, 'finish');
    for (let i = 0; i < 50; i++) expect(renderer.setSource(replacement)).toBeNull();
    expect(renderer.render(1)).toBeNull();
    expect(finish).not.toHaveBeenCalled(); expect(native.counts()).toEqual(before);
    expect(canvas.width).toBe(16); expect(canvas.height).toBe(16);
    expect(renderer.stats()).toMatchObject({ busy: true, pendingGPU: kind, pendingSyncs: 1, uploads: 2, sourceUpdates: 1, skippedSourceUpdates: 50, skippedFrames: 1 });
    expect(Object.values(renderer)).not.toContain(replacement.color);
    expect(Object.values(renderer)).not.toContain(replacement.mask);
    wait.mockRestore(); native.gl.finish();
    expect(renderer.setSource(replacement)).toBe(true);
    native.gl.finish(); expect(renderer.render(1, 0)).toBe(true);
    expect(native.read(48, 32)).toEqual(referenceLiquid(replacement, 1, 0));
    expect(renderer.stats()).toMatchObject({ width: 48, height: 32, sourceUpdates: 2, uploads: 4, pendingSyncs: 1 });
    expect(native.counts().maxLiveSyncs).toBe(1);
  });

  it.each(['ALREADY_SIGNALED', 'CONDITION_SATISFIED'])('releases a fence reporting %s before submitting its replacement', status => {
    renderer.setSource(liquidFixture(16, 16)); native.gl.finish();
    const before = native.counts();
    vi.spyOn(native.gl, 'clientWaitSync').mockReturnValue(native.gl[status]);
    expect(renderer.render(0)).toBe(true);
    expect(native.counts()).toMatchObject({ syncsDeleted: before.syncsDeleted + 1, syncsCreated: before.syncsCreated + 1, liveSyncs: 1, maxLiveSyncs: 1 });
  });

  it('stops submissions after a failed fence and recovers only with a restored context', () => {
    const source = liquidFixture(16, 16);
    renderer.setSource(source);
    const wait = vi.spyOn(native.gl, 'clientWaitSync').mockReturnValue(native.gl.WAIT_FAILED);
    expect(renderer.render(0)).toBe(false);
    expect(renderer.stats()).toMatchObject({ ready: false, syncFailed: true, busy: false, pendingSyncs: 0, frames: 0, lastError: 'Liquid GPU fence failed' });
    const before = native.counts();
    for (let i = 0; i < 10; i++) { expect(renderer.render(i)).toBe(false); expect(renderer.setSource(source)).toBe(false); }
    expect(native.counts()).toEqual(before);
    wait.mockRestore(); canvas.lose(); canvas.restore();
    expect(renderer.stats().syncFailed).toBe(false);
    expect(maximumError(render(source, 0), referenceLiquid(source, 0))).toBeLessThanOrEqual(1);
  });

  it('does not fall back to an unbounded stream if the driver cannot create a fence', () => {
    const source = liquidFixture(16, 16);
    renderer.setSource(source); native.gl.finish();
    vi.spyOn(native.gl, 'fenceSync').mockReturnValue(null);
    expect(renderer.render(0)).toBe(false);
    expect(renderer.stats()).toMatchObject({ ready: false, syncFailed: true, busy: false, frames: 1, lastError: 'Liquid GPU fence unavailable' });
    const before = native.counts();
    for (let i = 0; i < 10; i++) { expect(renderer.render(i)).toBe(false); expect(renderer.setSource(source)).toBe(false); }
    expect(native.counts()).toEqual(before);
  });

  it('rejects over-budget, out-of-device, malformed, and singular sources before uploading', () => {
    const source = liquidFixture(8, 8);
    renderer.setSource(source);
    const before = native.counts(), limits = renderer.stats();
    for (const invalid of [
      { width: 2049, height: 2048 },
      { maskWidth: 4097, maskHeight: 4096 },
      { width: limits.maxWidth + 1, height: 1 },
      { maskWidth: limits.maxMaskDimension + 1, maskHeight: 1 },
      { width: 0 }, { height: 1.5 }, { mask: new Uint8Array(2) },
      { screenToWorld: [1, 2, 2, 4, 0, 0] }, { screenToWorld: [1, 0, 0, 1, NaN, 0] },
      { maskX: 0.5 }, { color: { data: new Uint8Array(2), width: 8, height: 8 } },
    ]) expect(() => renderer.setSource({ ...source, ...invalid })).toThrow();
    expect(native.counts()).toEqual(before);
    expect(renderer.stats()).toMatchObject({ ready: true, maxColorPixels: LIQUID_MAX_COLOR_PIXELS, maxMaskPixels: LIQUID_MAX_MASK_PIXELS });
    expect(() => renderer.render(NaN)).toThrow();
    expect(() => renderer.render(1, Infinity)).toThrow();
  });

  it('drops lost resources, waits for a new source after restoration, and disposes all owned objects', () => {
    const source = liquidFixture(32, 24);
    expect(renderer.render(0)).toBe(false);
    const first = render(source, 0.2);
    const deletion = vi.spyOn(native.gl, 'deleteSync');
    expect(canvas.lose().defaultPrevented).toBe(true);
    expect(deletion).not.toHaveBeenCalled();
    expect(renderer.stats()).toMatchObject({ ready: false, contextLost: true, textureBytes: 0, textures: 0, busy: false, pendingSyncs: 0 });
    expect(renderer.render(0.2)).toBe(false);
    expect(renderer.setSource(source)).toBe(false);
    canvas.restore();
    expect(renderer.stats()).toMatchObject({ ready: false, contextLost: false, restores: 1 });
    expect(renderer.render(0.2)).toBe(false);
    expect(render(source, 0.2)).toEqual(first);
    renderer.dispose(); renderer.dispose();
    expect(renderer.stats()).toMatchObject({ ready: false, disposed: true, textureBytes: 0, textures: 0 });
    expect(native.counts()).toMatchObject({ liveTextures: 0, livePrograms: 0, liveVertexArrays: 0, liveShaders: 0 });
    expect([...canvas.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
    expect(renderer.render(0)).toBe(false); expect(renderer.setSource(source)).toBe(false);
  });
});
