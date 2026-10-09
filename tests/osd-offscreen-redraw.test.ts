// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { installOffscreenRedrawGuard } from '../src/osd-offscreen-redraw';

let OSD: any;
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    return createCanvas(this.width || 1, this.height || 1).getContext('2d') as any;
  });
  OSD = (await import('openseadragon')).default;
});
afterAll(() => vi.restoreAllMocks());

function fixture() {
  const viewer: any = new OSD.EventSource(), world: any = new OSD.EventSource();
  const viewport = new OSD.Viewport({ containerSize: new OSD.Point(100, 100), contentSize: new OSD.Point(100, 100) });
  viewport.zoomTo(2, undefined, true); viewport.panTo(new OSD.Point(.5, .5), true);
  const items: any[] = [];
  Object.assign(world, { getItemCount: () => items.length, getItemAt: (i: number) => items[i] });
  Object.assign(viewer, { viewport, world, forceRedraw: vi.fn(), isAnimating: () => false,
    drawer: { getType: () => 'canvas' }, tileCache: new OSD.TileCache({ maxImageCacheCount: 20 }) });
  const add = (x: number) => {
    const source = new OSD.TileSource({ width: 100, height: 100, tileSize: 100, minLevel: 0, maxLevel: 0 });
    const item = new OSD.TiledImage({ source, viewer, viewport, drawer: viewer.drawer,
      tileCache: viewer.tileCache, imageLoader: new OSD.ImageLoader({ jobLimit: 2 }),
      width: 1, x, y: 0, ajaxHeaders: {} });
    items.push(item); world.raiseEvent('add-item', { item }); return item;
  };
  const middle = add(0), left = add(-1);
  let dynamic = true;
  return { viewer, world, viewport, middle, left, add,
    install: () => installOffscreenRedrawGuard(viewer, () => dynamic),
    setDynamic: (value: boolean) => { dynamic = value; } };
}

describe('offscreen redraw retirement', () => {
  it('stops the real OSD empty-tile redraw loop only for images outside its draw area', () => {
    const f = fixture();
    expect(f.left.getDrawArea()).toBeNull();
    expect(f.left.setDrawn()).toBe(true); // The production OSD behavior that caused the loop.
    const dispose = f.install();
    try {
      for (let i = 0; i < 100; i++) {
        expect(f.left.setDrawn()).toBe(false);
        expect(f.left.needsDraw()).toBe(false);
      }
      expect(f.middle.getDrawArea()).not.toBeNull();
      expect(f.middle.setDrawn()).toBe(true); // Visible and still waiting for its first tile.
    } finally { dispose(); }
  });

  it('resumes normal loading and painting as soon as a pan exposes the parallel world', () => {
    const f = fixture(), dispose = f.install();
    try {
      expect(f.left.setDrawn()).toBe(false);
      f.viewport.panTo(new OSD.Point(-.5, .5), true);
      expect(f.left.getDrawArea()).not.toBeNull();
      expect(f.left.setDrawn()).toBe(true);
      expect(f.left.needsDraw()).toBe(true);
      f.left._lastDrawn = [{}];
      expect(f.left.setDrawn()).toBe(false);
      f.left._isBlending = true;
      expect(f.left.setDrawn()).toBe(true);
    } finally { dispose(); }
  });

  it('preserves the original behavior for static maps and re-enables the guard on return', () => {
    const f = fixture(), dispose = f.install();
    try {
      expect(f.left.setDrawn()).toBe(false);
      f.setDynamic(false); expect(f.left.setDrawn()).toBe(true);
      f.setDynamic(true); expect(f.left.setDrawn()).toBe(false);
    } finally { dispose(); }
  });

  it('uses OSD draw areas for viewport rotation and clipping, without overriding visible redraws', () => {
    const f = fixture(), dispose = f.install();
    try {
      f.viewport.setRotation(35, true);
      expect(f.left.getDrawArea()).toBeNull(); expect(f.left.setDrawn()).toBe(false);
      expect(f.middle.getDrawArea()).not.toBeNull(); expect(f.middle.setDrawn()).toBe(true);
      f.middle._lastDrawn = [{}];
      expect(f.middle.setDrawn()).toBe(false);
    } finally { dispose(); }
  });

  it('covers later images and restores owned methods on removal and viewer teardown', () => {
    const f = fixture(), original = f.left.setDrawn;
    const dispose = f.install(); expect(f.install()).toBe(dispose);
    const right = f.add(1);
    expect(right.setDrawn()).toBe(false);
    f.world.raiseEvent('remove-item', { item: right });
    expect(right.setDrawn).toBe(original); expect(right.setDrawn()).toBe(true);
    f.viewer.raiseEvent('before-destroy', {});
    expect(f.left.setDrawn).toBe(original); expect(f.left.setDrawn()).toBe(true);
    dispose();
  });

  it('does not overwrite a later wrapper and makes retired callbacks inert', () => {
    const f = fixture(), dispose = f.install();
    const guarded = f.left.setDrawn;
    const later = function(this: any) { return guarded.call(this); };
    f.left.setDrawn = later;
    f.world.raiseEvent('remove-item', { item: f.left });
    expect(f.left.setDrawn).toBe(later);
    expect(f.left.setDrawn()).toBe(true);
    dispose(); expect(f.left.setDrawn).toBe(later);
  });
});
