import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { nativeSunGL } from './helpers/native-sun-gl.mjs';
import { SunRenderer, SUN_GPU_BUDGET, SUN_SIZE } from '../src/portals/suns/renderer.mjs';
import { SUNS, SUN_FRAME_SIZE } from '../src/portals/suns/placements';

describe('Sun renderer with real GLES (no browser)', () => {
  let native: ReturnType<typeof nativeSunGL>, renderer: SunRenderer;
  beforeAll(() => {
    native = nativeSunGL(); vi.stubGlobal('OffscreenCanvas', native.Canvas);
    const bytes = readFileSync(new URL('../src/portals/suns/effects.bin', import.meta.url));
    renderer = new SunRenderer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 618);
  });
  afterAll(() => { renderer?.dispose(); native?.dispose(); vi.unstubAllGlobals(); });
  it('renders the full corona within budget and resumes the exact retained state', () => {
    expect(SUN_FRAME_SIZE).toBe(SUN_SIZE);
    for (const { effect, x, y } of SUNS) {
      const stats = renderer.render(effect, x, y, 0, SUN_SIZE);
      expect(renderer.renderer.sceneBuilder.emissive.some((batch: any) => batch.count && batch.linear)).toBe(true);
      expect(stats.estimatedGPUBytes).toBeLessThan(SUN_GPU_BUDGET);
      expect(stats.particles).toBeGreaterThan(5000);
      const first = native.read(SUN_SIZE, SUN_SIZE);
      const center = (Math.floor(SUN_SIZE / 2) * SUN_SIZE + Math.floor(SUN_SIZE / 2)) * 4;
      expect(first[center + 3]).toBe(255);
      if (effect === 'dark_sun') expect([...first.slice(center, center + 4)]).toEqual([0, 0, 0, 255]);
      else expect(first[center]).toBeGreaterThan(200);
      let edge = 0;
      for (let i = 0; i < SUN_SIZE; i++) for (const pixel of [i, (SUN_SIZE - 1) * SUN_SIZE + i, i * SUN_SIZE, i * SUN_SIZE + SUN_SIZE - 1])
        edge = Math.max(edge, first[pixel * 4 + 3]);
      expect(edge).toBeLessThan(8); // No bright square edge when zooming out.
      const resumed = renderer.render(effect, x, y, 0, SUN_SIZE);
      expect(resumed.steps).toBe(0); expect(resumed.warm).toBe(false);
      expect(Buffer.from(native.read(SUN_SIZE, SUN_SIZE)).equals(Buffer.from(first))).toBe(true);
      expect((native.gl as any).getError()).toBe(0);
    }
    expect(renderer.stats().retainedSuns).toBe(2);
  }, 30_000);
  it('caps resumed work and measures actual buffers instead of estimating from live particles', () => {
    const { effect, x, y } = SUNS[0];
    const stats = renderer.render(effect, x, y, 60_000, SUN_SIZE);
    expect(stats.steps).toBe(2);
    expect(stats.estimatedGPUBytes).toBeLessThan(SUN_GPU_BUDGET);
    expect(stats.estimatedGPUBytes).toBeGreaterThan(SUN_SIZE * SUN_SIZE * 4 * 6);
  });
  it('sizes transferred frames for the display and keeps native simulation and glow buffers intact', () => {
    const { effect, x, y } = SUNS[1];
    const history = renderer.renderer.histories.get(effect);
    const small = renderer.render(effect, x, y, 0, 400);
    expect(small.outputSize).toBe(512);
    expect(small.outputPixels).toBe(SUN_SIZE ** 2 / 9);
    expect(renderer.renderer.histories.get(effect)).toBe(history);
    expect(history.width).toBe(SUN_SIZE);
    const pixels = native.read(512, 512);
    expect([...pixels.slice((256 * 512 + 256) * 4, (256 * 512 + 256) * 4 + 4)]).toEqual([0, 0, 0, 255]);
    expect(renderer.render(effect, x, y, 0, 510).outputSize).toBe(512);
    expect(renderer.render(effect, x, y, 0, 520).outputSize).toBe(768);
    expect(renderer.render(effect, x, y, 0, 500).outputSize).toBe(768);
    expect(renderer.render(effect, x, y, 0, SUN_SIZE).outputSize).toBe(SUN_SIZE);
  });
  it('preserves fractional frame time without a burst of catch-up steps after suspension', () => {
    const { effect, x, y } = SUNS[1];
    renderer.render(effect, x, y, 0, 512);
    let steps = 0;
    for (let i = 0; i < 25; i++) steps += renderer.render(effect, x, y, 16, 512).steps;
    expect(steps).toBe(24);
    expect(renderer.render(effect, x, y, 0, 512).steps).toBe(0);
    expect(renderer.render(effect, x, y, 60_000, 512).steps).toBe(2);
  });
  it('uses the upstream linear final sample instead of reintroducing nearest-neighbour edge blocks', () => {
    const { effect, x, y } = SUNS[1];
    renderer.render(effect, x, y, 0, 1000);
    const actual = native.read(1024, 1024);
    const r = renderer.renderer, source = (r as any).emissiveTarget, history = r.histories.get(effect);
    const tile = { x: 0, y: 0, width: 1024, imageHeight: 1024 };
    r.begin(1024, 1024, 0, true);
    r.compositeTo(null, tile, source, history, false, true);
    expect(Buffer.from(native.read(1024, 1024)).equals(Buffer.from(actual))).toBe(true);
    r.begin(1024, 1024, 0, true);
    r.compositeTo(null, tile, source, history, false, false);
    const nearest = native.read(1024, 1024);
    let changedEdgePixels = 0;
    for (let py = 390; py < 634; py++) for (let px = 390; px < 634; px++) {
      const radius = Math.hypot(px - 512, py - 512);
      if (radius < 90 || radius > 115) continue;
      const index = (py * 1024 + px) * 4;
      if (actual.slice(index, index + 4).some((value, channel) => value !== nearest[index + channel])) changedEdgePixels++;
    }
    expect(changedEdgePixels).toBeGreaterThan(500);
  });
  it('ships transparent stills with the same opaque cores and clear frame edges', async () => {
    for (const name of ['sun-preview.webp', 'dark-sun-preview.webp']) {
      const { data, info } = await sharp(new URL(`../src/portals/suns/${name}`, import.meta.url).pathname).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info).toMatchObject({ width: 512, height: 512, channels: 4 });
      expect(data[(256 * 512 + 256) * 4 + 3]).toBe(255);
      expect(data[3]).toBeLessThan(8);
    }
  });
});
