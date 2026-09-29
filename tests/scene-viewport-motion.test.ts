// @vitest-environment jsdom
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Blob as NativeBlob } from 'node:buffer';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPixelSceneTileSource } from '../src/telescope/pixel-scene-tile-source';
import { installViewportLayerDrawing } from '../src/telescope/instant-terrain-viewport';
import { createSceneViewportPages } from '../src/telescope/scene-viewport-pages';

let OSD: any;
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    return createCanvas(this.width || 1, this.height || 1).getContext('2d') as any;
  });
  OSD = (await import('openseadragon')).default;
  OSD.pixelDensityRatio = 1;
  vi.stubGlobal('OpenSeadragon', OSD);
  const original = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((name: string) =>
    name === 'canvas' ? createCanvas(1, 1) : original(name)) as any);
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const rgba = (canvas: any) => Buffer.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);

it('keeps actual scene artwork registered during installed OSD pan/zoom while newer pages are delayed and caches are pressured', async () => {
  const png = await readFile('lib/noita-telescope-vm/data/pixel_scenes/rainforest/oiltank_01_visual.png');
  const artwork = await loadImage(png);
  const blob = new NativeBlob([png]) as Blob;
  let paused = false;
  const releases: Array<() => void> = [];
  vi.stubGlobal('createImageBitmap', async (_: Blob, sx: number, sy: number, sw: number, sh: number, options: ImageBitmapOptions) => {
    if (paused) await new Promise<void>(resolve => releases.push(resolve));
    const bitmap = createCanvas(options.resizeWidth!, options.resizeHeight!) as any;
    const context = bitmap.getContext('2d'); context.imageSmoothingEnabled = options.resizeQuality !== 'pixelated';
    context.drawImage(artwork, sx, sy, sw, sh, 0, 0, bitmap.width, bitmap.height);
    bitmap.close = vi.fn(); return bitmap;
  });
  const canvas = createCanvas(96, 72), oracle = createCanvas(96, 72);
  const viewer: any = new OSD.EventSource(), world: any = new OSD.EventSource();
  let x = 16, y = 64, scale = 1, dirty = false;
  const viewport = {
    getZoom: () => scale / 96, getRotation: () => 0, getFlip: () => false,
    getContainerSize: () => new OSD.Point(96, 72),
    deltaPixelsFromPointsNoRotate: (point: any) => point.times(scale),
    pixelFromPoint: (point: any) => new OSD.Point((point.x - x) * scale, (point.y - y) * scale),
    pixelFromPointNoRotate: (point: any) => new OSD.Point((point.x - x) * scale, (point.y - y) * scale),
  };
  const items: any[] = [];
  Object.assign(world, { getItemCount: () => items.length, getItemAt: (i: number) => items[i] });
  Object.assign(viewer, { world, viewport, forceRedraw: () => { dirty = true; },
    tileCache: new OSD.TileCache({ maxImageCacheCount: 8 }), tileRetryMax: 0 });
  const drawer = Object.create(OSD.CanvasDrawer.prototype);
  Object.assign(drawer, { _renderingTarget: canvas, context: canvas.getContext('2d'),
    sketchCanvas: null, sketchContext: null, viewport, viewer, _imageSmoothingEnabled: false,
    options: { usePrivateCache: false }, getDataToDraw: (tile: any) => tile.pixels });
  viewer.drawer = drawer;
  const placements = Array.from({ length: 24 }, (_, i) => ({
    osdX: i * 512, osdY: 0, w: artwork.width, h: artwork.height, sceneKey: 'actual-art',
  }));
  const layer = createPixelSceneTileSource({ items: placements, bitmapByKey: new Map(),
    blobByKey: new Map([['actual-art', {blob, width: artwork.width, height: artwork.height}]]),
    maxCacheBytes: 1024 * 1024, maxBitmapBytes: 256 * 1024, generationId: 1, redraw: viewer.forceRedraw });
  const source = layer.source;
  installViewportLayerDrawing(viewer, source);
  const item = new OSD.TiledImage({ source, viewer, viewport, drawer, tileCache: viewer.tileCache,
    imageLoader: new OSD.ImageLoader({jobLimit: 2}), width: layer.width, x: layer.originX, y: layer.originY,
    immediateRender: true, maxTilesPerFrame: 16, discardLevelsBelowDownsampleRatio: 1, ajaxHeaders: {} });
  item.getDrawer = () => drawer;
  items.push(item); world.raiseEvent('add-item', {item});
  const draw = () => {
    dirty = false;
    for (const output of [canvas, oracle]) {
      const ctx = output.getContext('2d'); ctx.resetTransform(); ctx.clearRect(0, 0, 96, 72);
      ctx.fillStyle = '#634428'; ctx.fillRect(0, 0, 96, 72);
    }
    drawer._drawTiles(item, []);
    const expected = oracle.getContext('2d'); expected.imageSmoothingEnabled = scale < 1; expected.imageSmoothingQuality = 'high';
    expected.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
    for (const placement of placements) expected.drawImage(artwork, placement.osdX, placement.osdY);
  };
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      draw();
      if (source.__viewportReady()) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('Scene viewport did not become ready');
  };
  try {
    // Visit enough distant rooms to exercise actual page eviction, then return
    // to the subject. No OSD tile is requested or allowed to substitute an LOD.
    for (const offset of [0, 2048, 4096, 6144, 8192, 10240, 0]) {
      x = 16 + offset; await settle();
      expect(source.sceneTileStats.viewport.bytes + source.sceneTileStats.viewport.workingBytes).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(source.sceneTileStats.viewport.rendered).toBeGreaterThan(source.sceneTileStats.viewport.entries);
    paused = true;
    for (let frame = 1; frame < 48; frame++) {
      x = 16 + frame * .19; y = 64 + frame * .13;
      scale = frame < 16 ? 1 : frame < 32 ? 1 + (frame - 15) * .021 : 1 - (frame - 31) * .015;
      viewer.raiseEvent('viewport-change', {}); viewer.raiseEvent('animation', {});
      expect(source.__viewportReady()).toBe(false); // previous camera is not readiness
      draw();
      expect(rgba(canvas), `animated frame ${frame}`).toEqual(rgba(oracle));
      expect(source.sceneTileStats.rendered).toBe(0);
    }
    expect(source.sceneTileStats.viewport.nativeBytes).toBeGreaterThan(0);
    // Crossing into an uncached room begins a delayed decode; the previous
    // native pages remain readable while that work is pending.
    x = 512 + 16; draw(); await Promise.resolve(); await Promise.resolve();
    x = 20; scale = 1; draw();
    expect(rgba(canvas)).toEqual(rgba(oracle));
    paused = false; for (const release of releases.splice(0)) release();
    await settle();
    scale = .05; x = 16; y = 64; await settle();
    expect(source.sceneTileStats.viewport.level).toBeGreaterThan(0);
    scale = 2; x = 23.27; y = 67.19; await settle();
    expect(source.sceneTileStats.viewport.level).toBe(0);
    expect(rgba(canvas)).toEqual(rgba(oracle));
    expect(source.sceneTileStats.viewport.failed).toBe(false);
  } finally {
    paused = false; source.destroy(); for (const release of releases.splice(0)) release();
    viewer.raiseEvent('before-destroy', {});
  }
});

it.each([[1920, 1080, 16 * 1024 * 1024], [375, 667, 4 * 1024 * 1024]])(
  'keeps native scene sampling at1x for a %i×%i viewport within its real cache budget', (width, height, maxBytes) => {
    const pages = createSceneViewportPages({ maxBytes, contains: () => true,
      render: () => new Promise(() => {}), changed() {}, ready() {}, failure() {} });
    const context = createCanvas(width, height).getContext('2d');
    try {
      for (const offset of [.01, 63.75, 127.99, 128.01]) {
        context.setTransform(1, 0, 0, 1, -offset, -offset);
        pages.draw(context as any, {left: offset, top: offset, right: width + offset, bottom: height + offset, scale: 1});
        expect(pages.stats.level).toBe(0);
        expect(pages.stats.bytes + pages.stats.workingBytes).toBeLessThanOrEqual(maxBytes);
      }
    } finally { pages.dispose(); }
  });

it('reports a failed direct-art decode and never claims that the failed viewport is ready', async () => {
  const source = createPixelSceneTileSource({ generationId: 2,
    items: [{osdX: 0, osdY: 0, w: 32, h: 32, sceneKey: 'broken'}], bitmapByKey: new Map(),
    loadBitmap: async () => { throw new Error('Native artwork failed'); }, maxCacheBytes: 4096 }).source;
  const errors: unknown[] = [];
  source.addHandler('scene-viewport-error', (event: any) => errors.push(event.error));
  try {
    source.__drawViewport(createCanvas(32, 32).getContext('2d'), {
      opacity: 1, imageToViewportCoordinates: (x: number, y: number) => ({x: x - 50, y: y - 50}),
    }, {pixelFromPoint: (point: any) => point});
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('Native artwork failed');
    expect(source.__viewportReady()).toBe(false);
    expect(source.sceneTileStats.viewport.bytes).toBe(0);
  } finally { source.destroy(); }
});
