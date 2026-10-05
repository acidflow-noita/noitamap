// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import {
  createInstantTerrainViewport, installViewportLayerDrawing, planInstantTerrainViewport,
  type InstantTerrainViewportPlan,
} from '../src/telescope/instant-terrain-viewport';

let OSD: any;
const cleanups: Array<() => void> = [];
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    return createCanvas(this.width || 1, this.height || 1).getContext('2d') as any;
  });
  OSD = (await import('openseadragon')).default;
  vi.stubGlobal('OpenSeadragon', OSD);
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); OSD.pixelDensityRatio = 1; });
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(bounds = { x: -1000, y: -1000, width: 2000, height: 2000 }, maxRetainedPixels?: number, initialOverview = false) {
  OSD.pixelDensityRatio = 1;
  const viewer: any = new OSD.EventSource(), world: any = new OSD.EventSource();
  const items: any[] = [], canvas = createCanvas(32, 24), lifetime = new AbortController();
  let area = new OSD.Rect(0, 0, 32, 24), angle = 0, flip = false, version = 0;
  const viewport = {
    getBounds: () => area.rotate(-angle),
    getBoundsWithMargins: () => area.rotate(-angle),
    getBoundsNoRotate: () => area,
    getCenter: () => area.getCenter(),
    getRotation: () => angle,
    getFlip: () => flip,
    getZoom: () => 1 / area.width,
    getContainerSize: () => new OSD.Point(32, 24),
    deltaPixelsFromPointsNoRotate: (point: any) => point.times(32 / area.width),
    pixelFromPoint: (point: any) => point.rotate(angle, area.getCenter()).minus(area.getTopLeft()).times(32 / area.width),
    pixelFromPointNoRotate: (point: any) => point.minus(area.getTopLeft()).times(32 / area.width),
    viewportToViewerElementRectangle: (rect: any) => new OSD.Rect((rect.x - area.x) * 32 / area.width,
      (rect.y - area.y) * 32 / area.width, rect.width * 32 / area.width, rect.height * 32 / area.width),
  };
  Object.assign(world, {
    getItemCount: () => items.length, getItemAt: (i: number) => items[i], ensureTilesUpToDate() {},
  });
  Object.assign(viewer, { world, viewport, forceRedraw: vi.fn(), isAnimating: () => false,
    tileCache: new OSD.TileCache({ maxImageCacheCount: 20 }), tileRetryMax: 0 });
  const drawer = Object.create(OSD.CanvasDrawer.prototype);
  Object.assign(drawer, { _renderingTarget: canvas, context: canvas.getContext('2d'),
    sketchCanvas: null, sketchContext: null, viewport, viewer, _imageSmoothingEnabled: false,
    options: { usePrivateCache: false }, getDataToDraw: (tile: any) => tile.pixels });
  viewer.drawer = drawer;
  const originalDraw = drawer._drawTiles;
  const renders: Array<{ plan: InstantTerrainViewportPlan; signal: AbortSignal; resolve: (image: any) => void; reject: (error: unknown) => void }> = [];
  const failure = vi.fn(), firstPaint = vi.fn();
  const renderFrame = vi.fn((plan: InstantTerrainViewportPlan, signal: AbortSignal, _preparingOverview?: boolean) =>
    new Promise<any>((resolve, reject) => renders.push({ plan, signal, resolve, reject })));
  const layer = createInstantTerrainViewport({ viewer, bounds, signal: lifetime.signal,
    renderFrame, firstPaint, onFailure: failure, revision: () => version, maxRetainedPixels, initialOverview });
  function attach(source: any = layer.source) {
    const item = new OSD.TiledImage({ source, viewer, viewport, drawer, tileCache: viewer.tileCache,
      imageLoader: new OSD.ImageLoader({ jobLimit: 2 }), width: source.width, x: bounds.x, y: bounds.y,
      immediateRender: true, maxTilesPerFrame: 16, discardLevelsBelowDownsampleRatio: 1, ajaxHeaders: {} });
    item.getDrawer = () => drawer;
    items.push(item);
    world.raiseEvent('add-item', { item });
    return item;
  }
  const item = attach();
  function image(index = renders.length - 1, color = '#e04020') {
    const request = renders[index], pixels: any = createCanvas(request.plan.pixelWidth, request.plan.pixelHeight);
    const ctx = pixels.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, pixels.width, pixels.height);
    pixels.close = vi.fn();
    request.resolve(pixels);
    return pixels;
  }
  function navigate(x: number, width = area.width, rotation = angle, event = 'viewport-change') {
    area = new OSD.Rect(x, area.y, width, width * 24 / 32);
    angle = rotation;
    viewer.raiseEvent(event, {});
  }
  cleanups.push(() => { lifetime.abort(); for (const tracked of [...items]) tracked.source.destroy(); viewer.raiseEvent('before-destroy', {}); });
  return { viewer, world, canvas, viewport, drawer, originalDraw, lifetime, layer, item, items, attach,
    renders, renderFrame, firstPaint, failure, image, navigate,
    revise: () => { version++; layer.refresh(); },
    setFlip: (value: boolean) => { flip = value; viewer.raiseEvent('flip', {}); },
    remove: (removed: any) => { removed.destroy(); items.splice(items.indexOf(removed), 1); world.raiseEvent('remove-item', { item: removed }); },
    draw: () => drawer.draw(items),
    pixel: (x: number, y: number) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data],
  };
}

describe('direct viewport terrain with installed OSD and native canvas', () => {
  it('starts preparing a drag on pan input before OSD enters its draw loop', async () => {
    const f=fixture(); await drain(); f.image(); await drain(); f.draw(); await drain();
    f.navigate(8,32,0,'pan'); await drain();
    expect(f.renders).toHaveLength(2);
    expect(f.renders[1].plan.x).toBe(8);
    f.image(undefined,'#20c060'); await drain();
    f.viewer.raiseEvent('viewport-change',{}); f.draw(); await drain();
    expect(f.renders).toHaveLength(2);
    expect(f.pixel(31,8)).toEqual([32,192,96,255]);
  });

  it('covers the first zoom-out after a close-up reseed without painting over sharp pixels or their air', async () => {
    const bounds = { x: -64, y: 0, width: 128, height: 96 };
    const f = fixture(bounds, undefined, true);
    await drain();
    expect(f.renders[0].plan).toMatchObject({ ...bounds, scale: 4, pixelWidth: 32, pixelHeight: 24 });
    expect(f.renderFrame.mock.calls[0][2]).toBe(true);
    const overview = f.image(0, '#e04020'); await drain(); f.draw();
    expect(f.firstPaint).not.toHaveBeenCalled();
    expect(f.pixel(12, 12)).toEqual([0, 0, 0, 0]);
    expect(f.renders[1].plan.scale).toBe(1);
    expect(f.renderFrame.mock.calls[1][2]).toBe(false);
    const detail = f.image(1, '#2060f0');
    detail.getContext('2d').clearRect(8, 8, 8, 8);
    await drain(); f.draw(); await drain();
    expect(f.firstPaint).toHaveBeenCalledOnce();
    f.navigate(0, 128); await drain(); f.draw();
    expect(f.pixel(12, 12)).toEqual([224, 64, 32, 255]);
    expect(f.pixel(1, 1)).toEqual([32, 96, 240, 255]);
    expect(f.pixel(2, 2)).toEqual([0, 0, 0, 0]);
    expect(overview.close).not.toHaveBeenCalled();
    expect(f.failure).not.toHaveBeenCalled();
  });

  it('keeps first-visit coverage within the existing memory budget across many camera changes', async () => {
    const f = fixture({ x: -64, y: 0, width: 128, height: 96 }, 512, true);
    await drain();
    const plan = f.renders[0].plan;
    expect(plan.x).toBe(-64);
    expect(plan.pixelWidth * plan.pixelHeight).toBeLessThanOrEqual(512);
    const overview = f.image(); await drain(); f.image(); await drain(); f.draw(); await drain();
    for (let i = 0; i < 12; i++) {
      f.navigate(-48 + i * 4); await drain(); f.image(undefined, '#2060f0'); await drain(); f.draw();
      expect((f.layer.stats as any).retainedBytes).toBeLessThanOrEqual(512 * 4);
      expect((f.layer.stats as any).retainedFrames).toBeLessThanOrEqual(3);
    }
    f.navigate(-64, 128); await drain(); f.draw();
    expect(f.pixel(30, 12)).toEqual([224, 64, 32, 255]);
    expect(overview.close).not.toHaveBeenCalled();
    f.lifetime.abort(); f.draw();
    expect(overview.close).not.toHaveBeenCalled();
    f.remove(f.item);
    expect(overview.close).toHaveBeenCalledOnce();
  });

  it('does not add a fallback render when the initial view already covers the whole map', async () => {
    const f = fixture({ x: 0, y: 0, width: 32, height: 24 }, undefined, true);
    await drain();
    expect(f.renders[0].plan.scale).toBe(1);
    f.image(); await drain(); f.draw(); await drain();
    expect(f.renderFrame).toHaveBeenCalledOnce();
    expect(f.firstPaint).toHaveBeenCalledOnce();
  });

  it('prepares only the latest camera after navigation during the overview render', async () => {
    const f = fixture(undefined, undefined, true);
    await drain();
    f.navigate(10); f.navigate(20); f.navigate(100, 256);
    f.image(); await drain();
    expect(f.renders).toHaveLength(2);
    expect(f.renders[1].plan).toMatchObject({ x: 100, scale: 8 });
    f.image(); await drain(); f.draw(); await drain();
    expect(f.firstPaint).toHaveBeenCalledOnce();
    expect(f.renders).toHaveLength(2);
  });

  it('does not render an overview outside the generated map or with no retention budget', async () => {
    const outside = fixture({ x: 100, y: 0, width: 100, height: 100 }, undefined, true);
    await drain();
    expect(outside.renderFrame).not.toHaveBeenCalled();
    outside.navigate(120); await drain();
    expect(outside.renders[0].plan.x).toBe(100);
    const unretained = fixture(undefined, 0, true);
    await drain();
    expect(unretained.renders[0].plan).toMatchObject({ x: 0, scale: 1 });
    unretained.image(); await drain(); unretained.draw(); await drain();
    expect(unretained.firstPaint).toHaveBeenCalledOnce();
    expect((unretained.layer.stats as any).retainedBytes).toBe(0);
  });

  it('keeps the existing three useful detail frames alongside the bounded overview', async () => {
    const f = fixture(undefined, undefined, true);
    await drain(); const overview = f.image(); await drain();
    const details = [f.image()]; await drain(); f.draw(); await drain();
    for (const x of [32, 64, 96]) {
      f.navigate(x); await drain(); details.push(f.image()); await drain(); f.draw();
    }
    expect((f.layer.stats as any).retainedFrames).toBe(4);
    for (const detail of details) expect(detail.close).not.toHaveBeenCalled();
    expect(overview.close).not.toHaveBeenCalled();
  });

  it('keeps the overview bounded for a large map and tight memory budgets', async () => {
    for (const budget of [729, 8 * 1024 * 1024]) {
      const f = fixture({ x: -53760, y: -31744, width: 107520, height: 73728 }, budget, true);
      await drain();
      const p = f.renders[0].plan;
      expect(p.x).toBe(-53760); expect(p.y).toBe(-31744);
      expect(p.pixelWidth * p.pixelHeight).toBeLessThanOrEqual(Math.min(budget, 1024 * 1024));
      expect(p.width + 1e-8).toBeGreaterThanOrEqual(107520);
      expect(p.height + 1e-8).toBeGreaterThanOrEqual(73728);
    }
  });

  it('discards an obsolete overview and cancels an unfinished reseed without publishing its pixels', async () => {
    const f = fixture({ x: -64, y: 0, width: 128, height: 96 }, undefined, true);
    await drain(); f.revise();
    const obsolete = f.image(); await drain();
    expect(obsolete.close).toHaveBeenCalledOnce();
    expect(f.renders[1].plan.x).toBe(-64);
    f.lifetime.abort();
    const late = f.image(); await drain(); f.draw();
    expect(late.close).toHaveBeenCalledOnce();
    expect(f.firstPaint).not.toHaveBeenCalled();
    expect(f.failure).not.toHaveBeenCalled();
    expect(f.renderFrame).toHaveBeenCalledTimes(2);
  });

  it('samples physical display pixels, including a rotated viewport, and limits the plan to map bounds', async () => {
    const f = fixture();
    await drain();
    expect(f.renders[0].plan).toMatchObject({ x: 0, y: 0, width: 32, height: 24, pixelWidth: 32, pixelHeight: 24, scale: 1 });
    OSD.pixelDensityRatio = 2;
    f.navigate(0, 16, 90);
    const plan = planInstantTerrainViewport(f.viewport, { x: 0, y: 0, width: 10, height: 10 })!;
    expect(plan).toMatchObject({ x: 2, y: 0, pixelWidth: 32, pixelHeight: 40, width: 8, height: 10, scale: .25 });
    expect(planInstantTerrainViewport(f.viewport, { x: 100, y: 100, width: 1, height: 1 })).toBeNull();
  });

  it('never enters the OSD tile loader and does not spin idle redraws', async () => {
    const f = fixture(), download = vi.spyOn(f.layer.source, 'downloadTileStart');
    await drain();
    f.item.update(true);
    expect(f.layer.source.tileExists(0, 0, 0)).toBe(false);
    expect(f.layer.source.maxLevel).toBe(0);
    expect(download).not.toHaveBeenCalled();
    expect(f.item.setDrawn()).toBe(false);
    expect(f.item.needsDraw()).toBe(false);
    f.image(); await drain();
    expect(f.firstPaint).not.toHaveBeenCalled();
    f.draw();
    expect(f.firstPaint).not.toHaveBeenCalled();
    await drain();
    expect(f.firstPaint).toHaveBeenCalledOnce();
    expect(f.pixel(12, 12)).toEqual([224, 64, 32, 255]);
    f.draw();
    expect(f.firstPaint).toHaveBeenCalledOnce();
    expect(f.renderFrame).toHaveBeenCalledOnce();
  });

  it('coalesces a moving camera to one active render plus the newest request', async () => {
    const f = fixture();
    await drain();
    for (let x = 1; x <= 100; x++) f.navigate(x);
    expect(f.renderFrame).toHaveBeenCalledOnce();
    const old = f.image(0); await drain();
    expect(f.renders).toHaveLength(2);
    expect(f.renders[1].plan.x).toBe(100);
    // Same-revision old-camera pixels remain available while the latest view
    // renders; they are reprojected, never stretched over the new world area.
    f.navigate(8); f.draw();
    expect(f.pixel(0, 12)).toEqual([224, 64, 32, 255]);
    expect(f.pixel(30, 12)[3]).toBe(0);
    const second = f.image(1, '#20c060'); await drain();
    expect(old.close).not.toHaveBeenCalled();
    expect(f.renders).toHaveLength(3);
    expect(f.renders[2].plan.x).toBe(8);
    f.image(2); await drain();
    expect(second.close).not.toHaveBeenCalled();
    expect(f.layer.isBusy()).toBe(false);
  });

  it('keeps the surrounding map visible while a zoom-out frame is still rendering', async () => {
    const f = fixture(); await drain();
    const overview = f.image(0, '#e04020'); await drain();
    f.navigate(0, 16); await drain();
    const detail = f.image(1, '#2060f0');
    detail.getContext('2d').clearRect(8, 8, 8, 8);
    await drain();
    expect(overview.close).not.toHaveBeenCalled();
    f.navigate(0, 32); await drain(); f.draw();
    // Native OSD has already cleared the drawer. Both old coverage and the
    // current detail must survive while the replacement promise is unresolved.
    expect(f.pixel(24, 12)).toEqual([224, 64, 32, 255]);
    expect(f.pixel(2, 2)).toEqual([32, 96, 240, 255]);
    expect(f.pixel(5, 5)).toEqual([0, 0, 0, 0]);
    f.image(2, '#20c060'); await drain(); f.draw();
    expect(overview.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
    expect(f.pixel(24, 12)).toEqual([32, 192, 96, 255]);
  });

  it('keeps the broad view through small zoom steps within a strict pixel budget', async () => {
    const f = fixture(undefined, 32 * 24); await drain();
    const overview = f.image(); await drain();
    const detailFrames: any[] = [];
    for (const width of [28, 24, 20, 16, 12, 8]) {
      f.navigate(0, width); await drain();
      detailFrames.push(f.image()); await drain();
      expect((f.layer.stats as any).retainedBytes).toBeLessThanOrEqual(32 * 24 * 4);
      expect((f.layer.stats as any).retainedFrames).toBe(1);
    }
    expect(overview.close).not.toHaveBeenCalled();
    for (const pixels of detailFrames.slice(0, -1)) expect(pixels.close).toHaveBeenCalledOnce();
    f.navigate(0, 32); f.draw();
    expect(f.pixel(24, 12)).toEqual([224, 64, 32, 255]);
    f.remove(f.item);
    expect(overview.close).toHaveBeenCalledOnce();
    expect(detailFrames.at(-1).close).toHaveBeenCalledOnce();
    expect((f.layer.stats as any).retainedBytes).toBe(0);
  });

  it.each([true, false])('keeps nearby detail for one wheel step after repeated zoom-in (initial overview %s)', async initialOverview => {
    const f = fixture({ x: -64, y: 0, width: 128, height: 96 }, undefined, initialOverview);
    await drain();
    if (initialOverview) { f.image(undefined, '#e04020'); await drain(); }
    const broad = f.image(undefined, '#e04020'); await drain(); f.draw(); await drain();
    let nearby: any;
    for (const width of [24, 20, 16, 12, 8]) {
      f.navigate(0, width); await drain();
      const frame = f.image(undefined, width === 12 ? '#20c060' : '#2060f0');
      if (width === 12) nearby = frame;
      await drain(); f.draw();
    }
    // Leave the replacement pending: the newly exposed strip must use the
    // immediately preceding detailed view, not a magnified broad snapshot.
    f.navigate(0, 8 * 1.2); await drain(); f.draw();
    expect(f.pixel(31, 8)).toEqual([32, 192, 96, 255]);
    expect(nearby.close).not.toHaveBeenCalled();
    expect(f.pixel(8, 8)).toEqual([32, 96, 240, 255]);
    expect((f.layer.stats as any).retainedBytes).toBeLessThanOrEqual((initialOverview ? 4 : 3) * 32 * 24 * 4);
    if (!initialOverview) expect(broad.close).not.toHaveBeenCalled();
    // The full-map fallback still covers a large jump without fresh pixels.
    if (initialOverview) {
      f.navigate(-64, 128); f.draw();
      expect(f.pixel(1, 8)).toEqual([224, 64, 32, 255]);
    }
  });

  it('discards obsolete revisions and aborts requests while preserving the handoff frame until destroy', async () => {
    const f = fixture();
    await drain();
    f.revise();
    const obsolete = f.image(); await drain();
    expect(obsolete.close).toHaveBeenCalledOnce();
    expect(f.layer.stats.discarded).toBe(1);
    const retained = f.image(); await drain(); f.draw();
    f.navigate(1); await drain();
    const lastRequest = f.renders.at(-1)!;
    f.lifetime.abort();
    expect(lastRequest.signal.aborted).toBe(true);
    expect(retained.close).not.toHaveBeenCalled();
    f.draw();
    expect(f.pixel(0, 12)).toEqual([224, 64, 32, 255]);
    const late = f.image(); await drain();
    expect(late.close).toHaveBeenCalledOnce();
    expect(retained.close).not.toHaveBeenCalled();
    f.remove(f.item);
    expect(retained.close).toHaveBeenCalledOnce();
    expect(f.drawer._drawTiles).toBe(f.originalDraw);
    expect(f.failure).not.toHaveBeenCalled();
  });

  it('draws whole frames in layer order and retains transparent holes for the background', async () => {
    const f = fixture(); await drain();
    const pixels = f.image(), context = pixels.getContext('2d');
    context.clearRect(4, 4, 4, 4);
    const direct = (color: string, box: number[]) => {
      const source = new OSD.TileSource({ width: 2000, height: 2000, tileSize: 256 });
      source.__drawViewport = (ctx: any) => { ctx.fillStyle = color; ctx.fillRect(...box); return true; };
      source.downloadTileStart = vi.fn();
      return f.attach(source);
    };
    const background = direct('#1020f0', [0, 0, 32, 24]);
    f.items.splice(f.items.indexOf(background), 1); f.items.unshift(background);
    const marker = direct('#f0e020', [10, 10, 3, 3]);
    await drain(); f.draw();
    expect(f.pixel(5, 5)).toEqual([16, 32, 240, 255]);
    expect(f.pixel(1, 1)).toEqual([224, 64, 32, 255]);
    expect(f.pixel(11, 11)).toEqual([240, 224, 32, 255]);
    for (const item of [background, marker]) {
      item.update(true);
      expect(item.source.downloadTileStart).not.toHaveBeenCalled();
      expect(item.setDrawn()).toBe(false);
    }
    f.remove(f.item);
    expect(f.drawer._drawTiles).not.toBe(f.originalDraw);
    f.remove(background); f.remove(marker);
    expect(f.drawer._drawTiles).toBe(f.originalDraw);
  });

  it('preserves native pixels, viewport rotation, density and the CanvasDrawer flip transform', async () => {
    const f = fixture();
    await drain();
    const pixels = f.image(), ctx = pixels.getContext('2d');
    ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 2, 24);
    await drain();
    f.draw(); expect(f.pixel(0, 10)).toEqual([0, 0, 255, 255]);
    f.setFlip(true); f.draw();
    expect(f.pixel(31, 10)).toEqual([0, 0, 255, 255]);
    // OSD's drawer owns the persistent flip matrix. Reset that matrix before
    // changing to a rotated camera, just as a resized OSD canvas would do.
    f.drawer.context.setTransform(1, 0, 0, 1, 0, 0); f.setFlip(false);
    f.navigate(0, 32, 90); f.draw();
    expect(f.pixel(16, 0)).toEqual([224, 64, 32, 255]);
    OSD.pixelDensityRatio = 2;
    f.navigate(0, 16, 0); await drain();
    f.image(); await drain();
    expect(f.renders.at(-1)!.plan.scale).toBe(.25);
  });

  it('keeps a matching retained frame when the camera returns during another render', async () => {
    const f = fixture(); await drain();
    const retained = f.image(); await drain();
    f.navigate(100); await drain();
    f.navigate(0);
    const obsolete = f.image(); await drain(); f.draw();
    expect(obsolete.close).toHaveBeenCalledOnce();
    expect(retained.close).not.toHaveBeenCalled();
    expect(f.renderFrame).toHaveBeenCalledTimes(2);
    expect(f.pixel(12, 12)).toEqual([224, 64, 32, 255]);
  });

  it('clips rounded sampling overscan to map bounds', async () => {
    const f = fixture({ x: 0, y: 0, width: 5.2, height: 24 });
    await drain();
    expect(f.renders[0].plan.width).toBe(6);
    f.image(); await drain(); f.draw();
    expect(f.pixel(4, 12)).toEqual([224, 64, 32, 255]);
    expect(f.pixel(6, 12)[3]).toBe(0);
  });

  it('defers old-layer cleanup until following scene and POI layers have drawn', async () => {
    const f = fixture(); await drain();
    const source = (color: string) => {
      const value = new OSD.TileSource({ width: 2000, height: 2000, tileSize: 256 });
      value.__drawViewport = vi.fn((ctx: any) => { ctx.fillStyle = color; ctx.fillRect(0, 0, 2, 2); return true; });
      return value;
    };
    const old = f.attach(source('#202020'));
    f.items.splice(f.items.indexOf(old), 1); f.items.unshift(old);
    const marker = f.attach(source('#20f040'));
    f.firstPaint.mockImplementation(() => f.remove(old));
    f.image(); await drain(); f.draw();
    expect(marker.source.__drawViewport).toHaveBeenCalledOnce();
    expect(f.pixel(0, 0)).toEqual([32, 240, 64, 255]);
    expect(f.items).toContain(old);
    await drain();
    expect(f.items).not.toContain(old);
    expect(f.firstPaint).toHaveBeenCalledOnce();
  });

  it('does not publish a queued first-paint notification after the generation is cancelled', async () => {
    const f = fixture(); await drain();
    f.image(); await drain(); f.draw(); f.lifetime.abort(); await drain();
    expect(f.firstPaint).not.toHaveBeenCalled();
  });

  it('reports a render failure once and releases a frame on viewer destruction', async () => {
    const f = fixture(); await drain();
    const pixels = f.image(); await drain();
    f.navigate(1); await drain();
    f.renders[1].reject(new Error('GPU lost')); await drain();
    f.layer.refresh(); f.draw();
    expect(f.failure).toHaveBeenCalledOnce();
    expect(f.renderFrame).toHaveBeenCalledTimes(2);
    f.viewer.raiseEvent('before-destroy', {});
    expect(pixels.close).toHaveBeenCalledOnce();
    expect(f.drawer._drawTiles).toBe(f.originalDraw);
    expect(f.layer.source.isDisposed).toBe(true);
  });

  it('declines non-canvas drawers without mutating their drawing methods', () => {
    const original = vi.fn(), viewer = { drawer: { getType: () => 'webgl', _drawTiles: original, context: {} } };
    expect(installViewportLayerDrawing(viewer)).toBe(false);
    expect(viewer.drawer._drawTiles).toBe(original);
  });
});
