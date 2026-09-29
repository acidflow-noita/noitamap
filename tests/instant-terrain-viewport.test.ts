// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { mapMemoryBudgetFor } from '../src/map-memory-budget';
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

function fixture(bounds = { x: -1000, y: -1000, width: 2000, height: 2000 }, maxRetainedPixels?: number, overviewMaxPixels?: number, frameMarginPixels?: number) {
  OSD.pixelDensityRatio = 1;
  const viewer: any = new OSD.EventSource(), world: any = new OSD.EventSource();
  const items: any[] = [], canvas = createCanvas(32, 24), lifetime = new AbortController();
  let area = new OSD.Rect(0, 0, 32, 24), angle = 0, flip = false, version = 0;
  let destination = area;
  const viewport = {
    getBounds: (current = false) => (current ? area : destination).rotate(-angle),
    getBoundsWithMargins: () => area.rotate(-angle),
    getBoundsNoRotate: () => area,
    getCenter: () => area.getCenter(),
    getRotation: () => angle,
    getFlip: () => flip,
    getZoom: () => 1 / area.width,
    getContainerSize: () => new OSD.Point(32, 24),
    deltaPixelsFromPointsNoRotate: (point: any, current = false) => point.times(32 / (current ? area : destination).width),
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
  const renderFrame = vi.fn((plan: InstantTerrainViewportPlan, signal: AbortSignal) =>
    new Promise<any>((resolve, reject) => renders.push({ plan, signal, resolve, reject })));
  const layer = createInstantTerrainViewport({ viewer, bounds, signal: lifetime.signal,
    renderFrame, firstPaint, onFailure: failure, revision: () => version, maxRetainedPixels, overviewMaxPixels, frameMarginPixels });
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
  function navigate(x: number, width = area.width, rotation = angle) {
    area = new OSD.Rect(x, area.y, width, width * 24 / 32);
    destination = area;
    angle = rotation;
    viewer.raiseEvent('viewport-change', {});
  }
  cleanups.push(() => { lifetime.abort(); for (const tracked of [...items]) tracked.source.destroy(); viewer.raiseEvent('before-destroy', {}); });
  return { viewer, world, canvas, viewport, drawer, originalDraw, lifetime, layer, item, items, attach,
    renders, renderFrame, firstPaint, failure, image, navigate,
    startZoomOut: (width: number) => {
      destination = new OSD.Rect(area.x, area.y, width, width * 24 / 32);
      viewer.raiseEvent('zoom', {});
    },
    animateWidth: (width: number) => {
      area = new OSD.Rect(area.x, area.y, width, width * 24 / 32);
      viewer.raiseEvent('animation', {});
    },
    revise: () => { version++; layer.refresh(); },
    setFlip: (value: boolean) => { flip = value; viewer.raiseEvent('flip', {}); },
    remove: (removed: any) => { removed.destroy(); items.splice(items.indexOf(removed), 1); world.raiseEvent('remove-item', { item: removed }); },
    draw: () => drawer.draw(items),
    pixel: (x: number, y: number) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data],
  };
}

describe('direct viewport terrain with installed OSD and native canvas', () => {
  it.each([
    { width: 390, height: 844, density: 3, rotation: 0 },
    { width: 430, height: 932, density: 4, rotation: 45 },
    { width: 1366, height: 1024, density: 3, rotation: 90 },
    { width: 8192, height: 2048, density: 4, rotation: 45 },
  ])('bounds high-DPI viewport allocation without losing world coverage: $width×$height @$density', ({ width, height, density, rotation }) => {
    OSD.pixelDensityRatio = density;
    const budget = mapMemoryBudgetFor({ coarsePointer: true });
    const area = new OSD.Rect(0, 0, width, height).rotate(rotation);
    const viewport = { getBounds: () => area, deltaPixelsFromPointsNoRotate: (point: any) => point };
    const visible = area.getBoundingBox();
    const bounds = { x: -20000, y: -20000, width: 40000, height: 40000 };
    const plan = planInstantTerrainViewport(viewport, bounds, budget)!;
    expect(plan.pixelWidth * plan.pixelHeight).toBeLessThanOrEqual(budget.viewportMaxPixels);
    expect(Math.max(plan.pixelWidth, plan.pixelHeight)).toBeLessThanOrEqual(budget.viewportMaxDimension);
    expect(plan.x).toBe(visible.x);
    expect(plan.y).toBe(visible.y);
    expect(plan.x + plan.width).toBeGreaterThanOrEqual(visible.x + visible.width - 1e-8);
    expect(plan.y + plan.height).toBeGreaterThanOrEqual(visible.y + visible.height - 1e-8);
    expect(plan.width / plan.pixelWidth).toBeCloseTo(plan.height / plan.pixelHeight, 10);
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
    expect(detail.close).not.toHaveBeenCalled();
    expect(f.pixel(24, 12)).toEqual([32, 192, 96, 255]);
  });

  it('renders the zoom-out destination once instead of chasing narrower spring positions', async () => {
    const f = fixture(); await drain();
    f.image(); await drain();
    f.startZoomOut(128); await drain();
    expect(f.renders[1].plan).toMatchObject({ width: 128, height: 96, scale: 4 });
    f.image(1, '#2060f0'); await drain();
    for (const width of [36, 48, 64, 80, 112, 128]) {
      f.animateWidth(width); await drain(); f.draw();
      expect(f.renders).toHaveLength(2);
      expect(f.pixel(31, 12)).toEqual([32, 96, 240, 255]);
    }
    expect(f.layer.isBusy()).toBe(false);
  });

  it('does not magnify an early zoom-out destination over existing native detail', async () => {
    const f = fixture(); await drain();
    const detail = f.image(), ctx = detail.getContext('2d');
    for (let x = 0; x < 32; x++) {
      ctx.fillStyle = x % 2 ? '#0000ff' : '#ff0000'; ctx.fillRect(x, 0, 1, 24);
    }
    await drain(); f.draw();
    f.startZoomOut(128); await drain();
    f.image(1, '#00ff00'); await drain(); f.draw();
    for (let x = 0; x < 32; x++) expect(f.pixel(x, 10)).toEqual(x % 2 ? [0, 0, 255, 255] : [255, 0, 0, 255]);
    expect(detail.close).not.toHaveBeenCalled();
    f.animateWidth(128); await drain(); f.draw();
    expect(f.pixel(4, 4)).toEqual([0, 255, 0, 255]);
  });

  it('filters native detail when shrinking it during an unresolved zoom-out', async () => {
    const f = fixture(); await drain();
    const detail = f.image(), ctx = detail.getContext('2d');
    for (let x = 0; x < 32; x++) {
      ctx.fillStyle = x % 2 ? '#0000ff' : '#ff0000'; ctx.fillRect(x, 0, 1, 24);
    }
    await drain(); f.navigate(0, 64); await drain(); f.draw();
    const sample = f.pixel(5, 5);
    expect(sample[0]).toBeGreaterThan(100);
    expect(sample[2]).toBeGreaterThan(100);
    expect(sample[3]).toBe(255);
  });

  it('keeps never-visited biomes covered throughout continuous zoom while worker frames are delayed', async () => {
    const pixels = 32 * 24;
    const f = fixture({ x: 0, y: 0, width: 256, height: 192 }, pixels * 2, pixels);
    await drain();
    const detail = f.image(0, '#e04020');
    detail.getContext('2d').clearRect(4, 4, 4, 4);
    await drain(); f.draw(); await drain();
    expect(f.firstPaint).not.toHaveBeenCalled();
    expect(f.layer.source.__viewportReady()).toBe(false);
    expect(f.renders[1].plan).toMatchObject({ x: 0, y: 0, width: 256, height: 192, pixelWidth: 32, pixelHeight: 24 });
    const overview = f.image(1, '#20c060'); await drain(); f.draw(); await drain();
    expect(f.firstPaint).toHaveBeenCalledOnce();
    expect(f.layer.source.__viewportReady()).toBe(true);
    // A broad backing frame must not fill an authoritative transparent cave.
    expect(f.pixel(5, 5)).toEqual([0, 0, 0, 0]);
    expect((f.layer.stats as any).retainedBytes).toBe(pixels * 4);
    f.startZoomOut(256); await drain();
    for (const width of [48, 64, 96, 128, 192, 256]) {
      f.animateWidth(width); await drain(); f.draw();
      // The newest worker request is intentionally never resolved here.
      // CanvasDrawer clears every animation frame, so coverage must be redrawn.
      expect(f.renders).toHaveLength(3);
      expect(f.pixel(31, 12)).toEqual([32, 192, 96, 255]);
      expect(f.pixel(20, 22)[3]).toBe(255);
      expect((f.layer.stats as any).retainedBytes).toBeLessThanOrEqual(pixels * 2 * 4);
    }
    f.image(2, '#2060f0'); await drain(); f.draw();
    expect(f.pixel(31, 12)).toEqual([32, 96, 240, 255]);
    expect(overview.close).not.toHaveBeenCalled();
    f.remove(f.item);
    expect(overview.close).toHaveBeenCalledOnce();
    expect((f.layer.stats as any).retainedBytes).toBe(0);
  });

  it.each([[0, 1], [17, .4], [45, 1], [90, .7], [-32, 1]])('does not expose seams between complete frames at fractional animated zoom positions (rotation %s, opacity %s)', async (angle, opacity) => {
    const f = fixture(undefined, 32 * 24 * 3, 32 * 24, 1);
    f.item.opacity = opacity;
    await drain(); f.image(0); await drain(); f.image(1); await drain();
    f.navigate(3.17, 17.43, angle); await drain(); f.image(2); await drain();
    f.startZoomOut(128); await drain();
    for (const width of [21.3, 29.7, 54.31, 83.17, 128]) {
      f.animateWidth(width); await drain(); f.draw();
      const pixels = f.canvas.getContext('2d').getImageData(0, 0, 32, 24).data;
      let partial = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== Math.round(255 * opacity)) partial++;
      expect(partial, `width=${width}`).toBe(0);
      expect((f.layer.stats as any).overviewBytes).toBeLessThanOrEqual(32 * 24 * 4);
      expect((f.layer.stats as any).retainedBytes).toBeLessThanOrEqual(32 * 24 * 3 * 4);
    }
  });

  it('keeps guarded native pixels sharp and flips them without blending or shifting the image', async () => {
    const f = fixture(undefined, undefined, undefined, 1);
    await drain();
    expect(f.renders[0].plan).toMatchObject({ x: -1, y: -1, pixelWidth: 34, pixelHeight: 26 });
    const image = f.image(), ctx = image.getContext('2d');
    for (let x = 0; x < image.width; x++) {
      ctx.fillStyle = (x - 1) % 2 ? '#0000ff' : '#ff0000'; ctx.fillRect(x, 0, 1, image.height);
    }
    await drain(); f.draw();
    for (let x = 0; x < 32; x++) expect(f.pixel(x, 10)).toEqual(x % 2 ? [0, 0, 255, 255] : [255, 0, 0, 255]);
    f.setFlip(true); f.draw();
    for (let x = 0; x < 32; x++) expect(f.pixel(x, 10)).toEqual(x % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
  });

  it('keeps authoritative air transparent when guarded detail is projected above a broader frame', async () => {
    const f = fixture(undefined, undefined, undefined, 1);
    await drain(); f.image(); await drain();
    f.navigate(0, 16); await drain();
    const detail = f.image(); detail.getContext('2d').clearRect(9, 9, 8, 8);
    await drain(); f.navigate(0, 32); await drain(); f.draw();
    expect(f.pixel(5, 5)).toEqual([0, 0, 0, 0]);
    expect(f.pixel(9, 5)[3]).toBe(255);
    expect(f.pixel(24, 5)[3]).toBe(255);
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

  it('publishes same-generation frames during cooking revisions and aborts retired requests', async () => {
    const f = fixture();
    await drain();
    f.revise();
    const obsolete = f.image(); await drain();
    expect(obsolete.close).not.toHaveBeenCalled();
    expect(f.layer.stats.discarded).toBe(0);
    const retained = f.image(); await drain(); f.draw();
    expect(obsolete.close).toHaveBeenCalledOnce();
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

  it('upgrades a zoomed-in view even when background cooking advances during every foreground draw', async () => {
    const f = fixture(); await drain();
    f.image(0, '#00ff00'); await drain(); f.draw();
    f.navigate(0, 8); await drain();
    for (let i = 1; i <= 5; i++) {
      f.revise();
      f.image(i, '#ff0000'); await drain(); f.draw();
      expect(f.pixel(10, 10)).toEqual([255, 0, 0, 255]);
      expect(f.layer.stats.discarded).toBe(0);
    }
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
