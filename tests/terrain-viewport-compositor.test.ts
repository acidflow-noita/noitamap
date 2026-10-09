import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { createTerrainViewportCompositor, terrainViewportStrips, type TerrainViewportPlan } from '../src/telescope/terrain-viewport-compositor';
import { WORLD_HEIGHT, WORLD_TOP, type TerrainOwnership, type VerticalPlane } from '../src/telescope/terrain-policy';
import type { StaticTerrainMask } from '../src/telescope/static-terrain-mask';

const surfaces: any[] = [];
beforeEach(() => {
  surfaces.length = 0;
  vi.stubGlobal('document', { createElement: () => {
    const canvas = createCanvas(1, 1), context = canvas.getContext('2d');
    vi.spyOn(context, 'getImageData');
    surfaces.push(canvas);
    return canvas;
  } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const owner = (enabled = true): TerrainOwnership => ({
  width: 70, owners: new Int16Array(70 * 48).fill(enabled ? 0 : -1), names: ['dynamic'], at: () => enabled ? 0 : -1,
});
const plan = (x: number, y: number, pixelWidth: number, pixelHeight: number, scale = 1): TerrainViewportPlan =>
  ({ x, y, pixelWidth, pixelHeight, scale, width: pixelWidth * scale, height: pixelHeight * scale });
const read = (canvas: any, x: number, y: number) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];

function resources() {
  let plane: VerticalPlane = 0;
  const render = vi.fn((view: any) => {
    const canvas = createCanvas(view.width, view.height), ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(view.width, view.height);
    // Evaluate the shipped renderer's camera conversion independently of the
    // compositor. Green encodes the horizontal PW; red encodes its plane.
    const x0 = view.camX - view.width / (2 * view.camZ) - 17920 + view.pw * 35840;
    const y0 = view.camY - view.height / (2 * view.camZ) - 7168 + view.pwVertical * WORLD_HEIGHT;
    for (let y = 0; y < view.height; y++) for (let x = 0; x < view.width; x++) {
      const wx = Math.floor(x0 + (x + .5) / view.camZ), wy = Math.floor(y0 + (y + .5) / view.camZ);
      const offset = (y * view.width + x) * 4, pw = Math.floor((wx + 17920) / 35840);
      pixels.data.set([128 + plane * 64, 100 + pw * 60, ((wy % 251) + 251) % 251, 255], offset);
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas;
  });
  return { setPlane: vi.fn((value: VerticalPlane) => { plane = value; }), render };
}

describe('atomic terrain viewport compositor', () => {
  it('renders all nine regions in at most three GPU draws without reading pixels back', () => {
    const compositor = createTerrainViewportCompositor({ owners: [owner(), owner(), owner()], masks: [], center: 35 });
    const renderer = resources();
    const result = compositor.render(renderer, plan(-53760, WORLD_TOP - WORLD_HEIGHT, 210, 144, 512));
    expect(renderer.render).toHaveBeenCalledTimes(3);
    expect(renderer.setPlane.mock.calls.map(call => call[0])).toEqual([-1, 0, 1]);
    for (const canvas of surfaces) expect(canvas.getContext('2d').getImageData).not.toHaveBeenCalled();
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
      const pixel = read(result, 35 + column * 70, 24 + row * 48);
      expect(pixel[0]).toBe(64 + row * 64);
      expect(pixel[1]).toBe(40 + column * 60);
      expect(pixel[3]).toBe(255);
    }
    compositor.dispose();
    // Native Skia normalizes a zero-sized canvas to its default empty size.
    const empty = createCanvas(0, 0);
    expect(surfaces.every(canvas => canvas.width === empty.width && canvas.height === empty.height)).toBe(true);
  });

  it('preserves static ownership and authored material/force-air holes without clearing empty scene pixels', () => {
    const owners = [owner(), owner(), owner()];
    owners[1].owners[34] = -1;
    const mask: StaticTerrainMask = { x: 2, y: WORLD_TOP + 2, width: 4, height: 2,
      bits: new Uint8Array([1]), airBits: new Uint8Array([2]) };
    const compositor = createTerrainViewportCompositor({ owners, masks: [mask], center: 35 });
    const renderer = resources(), result = compositor.render(renderer, plan(-520, WORLD_TOP, 1040, 8));
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(read(result, 2, 2)[3]).toBe(255);
    expect(read(result, 10, 2)[3]).toBe(0);
    expect(read(result, 519, 2)[3]).toBe(0);
    expect(read(result, 520, 2)[3]).toBe(255);
    expect(read(result, 522, 2)[3]).toBe(0);
    expect(read(result, 523, 2)[3]).toBe(0);
    expect(read(result, 524, 2)[3]).toBe(255);
    expect(read(result, 522, 3)[3]).toBe(255);
    compositor.dispose();
  });

  it.each([.2, .5, .8])('assigns a fractional boundary to the plane containing each pixel center (phase=%s)', phase => {
    const boundary = WORLD_TOP + WORLD_HEIGHT;
    const view = plan(0, boundary - 2 - phase, 2, 6);
    const strips = terrainViewportStrips(view, 35);
    const compositor = createTerrainViewportCompositor({ owners: [owner(), owner(), owner()], masks: [], center: 35 });
    const result = compositor.render(resources(), view);
    expect(strips).toHaveLength(2);
    expect(strips[0].view.height).toBe(strips[1].offsetY);
    for (let y = 0; y < view.pixelHeight; y++) {
      const expectedPlane = view.y + y + .5 >= boundary ? 1 : 0;
      expect(read(result, 0, y)[0]).toBe(128 + expectedPlane * 64);
      expect(read(result, 0, y)[3]).toBe(255);
    }
    compositor.dispose();
  });

  it('keeps a sub-world-pixel viewport visible across an ownership boundary at high zoom', () => {
    const owners = [owner(false), owner(false), owner(false)];
    owners[1].owners[35] = 0;
    const compositor = createTerrainViewportCompositor({ owners, masks: [], center: 35 });
    const renderer = resources(), result = compositor.render(renderer, plan(-.1, WORLD_TOP + .1, 1, 1, .25));
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(read(result, 0, 0)[3]).toBeGreaterThan(0);
    compositor.dispose();
  });

  it('never exposes a partially finished plane batch when a later GPU draw fails', () => {
    const compositor = createTerrainViewportCompositor({ owners: [owner(), owner(), owner()], masks: [], center: 35 });
    const renderer = resources();
    renderer.render.mockImplementationOnce(() => createCanvas(1, 48));
    renderer.render.mockImplementationOnce(() => { throw new Error('GPU lost'); });
    const publish = vi.fn();
    expect(() => publish(compositor.render(renderer, plan(0, WORLD_TOP - WORLD_HEIGHT, 1, 144, 512)))).toThrow('GPU lost');
    expect(publish).not.toHaveBeenCalled();
    expect(renderer.render).toHaveBeenCalledTimes(2);
    compositor.dispose();
  });

  it('does not draw or leave previous pixels in completely unowned regions', () => {
    const owners = [owner(false), owner(false), owner(false)];
    owners[1].owners[35] = 0;
    const compositor = createTerrainViewportCompositor({ owners, masks: [], center: 35 });
    const renderer = resources();
    const first = compositor.render(renderer, plan(0, WORLD_TOP, 4, 4));
    expect(read(first, 0, 0)[3]).toBe(255);
    const second = compositor.render(renderer, plan(512, WORLD_TOP, 4, 4));
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(read(second, 0, 0)[3]).toBe(0);
    compositor.dispose();
  });

  it.each([0, -1, Infinity, NaN])('rejects invalid pixel scale %s before allocating or shading', scale => {
    const compositor = createTerrainViewportCompositor({ owners: [owner(), owner(), owner()], masks: [], center: 35 });
    const renderer = resources();
    expect(() => compositor.render(renderer, plan(0, 0, 4, 4, scale))).toThrow('Invalid terrain viewport');
    expect(renderer.render).not.toHaveBeenCalled();
    compositor.dispose();
  });
});
