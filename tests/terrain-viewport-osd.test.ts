// @vitest-environment jsdom
import { it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { mountTerrainViewport } from '../src/telescope/terrain-viewport';

beforeAll(() => vi.useFakeTimers());
afterAll(() => vi.useRealTimers());

it.each([1, 2])('keeps and draws a terrain frame through real OSD layer animations at DPR %s', async dpr => {
  const canvases = new WeakMap<HTMLCanvasElement, Canvas>();
  const prototype = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d'));
  const drawImage = prototype.drawImage;
  const drawing = vi.spyOn(prototype, 'drawImage').mockImplementation(function(this: any, source: any, ...args: any[]) {
    return drawImage.call(this, source instanceof HTMLCanvasElement ? canvases.get(source) : source, ...args);
  });
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null;
    let native = canvases.get(this);
    if (!native) { native = createCanvas(this.width, this.height); canvases.set(this, native); }
    if (native.width !== this.width) native.width = this.width;
    if (native.height !== this.height) native.height = this.height;
    return native.getContext('2d') as any;
  } as any);
  const sizeX = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(256);
  const sizeY = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(192);
  vi.stubGlobal('devicePixelRatio', dpr);
  let viewer: any, dispose: (() => void) | undefined;
  try {
    const { default: OSD } = await import('openseadragon');
    vi.stubGlobal('OpenSeadragon', OSD);
    (OSD as any).pixelDensityRatio = dpr;
    const element = document.createElement('div'); document.body.appendChild(element);
    viewer = new OSD.Viewer({ element, drawer: 'canvas', showNavigationControl: false,
      showNavigator: false, blendTime: 0, animationTime: 0, minZoomImageRatio: 0,
      preserveViewport: true });
    viewer.viewport.fitBounds(new OSD.Rect(-800, 6980, 256, 192), true);
    const paint = vi.fn(), render = vi.fn(async (bounds: any, scale: number) => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(bounds.width * scale); canvas.height = Math.ceil(bounds.height * scale);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = render.mock.calls.length === 1 ? '#2468ac' : '#ac6824';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas;
    });
    let animations = 0;
    viewer.addHandler('animation', () => animations++);
    dispose = mountTerrainViewport(viewer, render, () => true, () => {}, paint);
    for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(20);
    expect(animations).toBeGreaterThan(0);
    expect(paint).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(viewer.world.getItemCount()).toBe(1);
    expect(viewer.world.getItemAt(0).getFullyLoaded()).toBe(true);
    const raster = canvases.get(viewer.drawer.canvas)!;
    expect([...raster.getContext('2d').getImageData(raster.width >> 1, raster.height >> 1, 1, 1).data])
      .toEqual([36, 104, 172, 255]);
    viewer.viewport.panTo(viewer.viewport.getCenter(true).plus(new OSD.Point(64, 0)), true);
    for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(20);
    expect(render).toHaveBeenCalledTimes(2);
    expect(paint).toHaveBeenCalledTimes(1);
    expect(viewer.world.getItemCount()).toBe(1);
    expect([...raster.getContext('2d').getImageData(raster.width >> 1, raster.height >> 1, 1, 1).data])
      .toEqual([172, 104, 36, 255]);
  } finally {
    dispose?.(); viewer?.destroy(); document.body.innerHTML = '';
    drawing.mockRestore(); context.mockRestore(); sizeX.mockRestore(); sizeY.mockRestore(); vi.unstubAllGlobals();
  }
});
