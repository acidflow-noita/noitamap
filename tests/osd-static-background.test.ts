// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import definitions from '../src/data/tilesources.json';
import { installStaticBackgroundResidency } from '../src/osd-static-background';
import { addBakedDZIsToOSD } from '../src/telescope/baked-dzi-loader';

vi.mock('../src/data_sources/overlays', () => ({ createOverlays: () => [] }));
vi.mock('../src/data_sources/tile_data', async importOriginal => ({
  ...await importOriginal<any>(),
  fetchMapVersions: async () => Object.fromEntries(definitions['dynamic-main-branch'].map(entry => [new URL(entry.url).origin, 'current-test-version'])),
}));
let OSD: any, AppOSD: any;
const native = new WeakMap<HTMLCanvasElement, Canvas>(), frames = new Map<number, FrameRequestCallback>();
const descriptors = new Map<string, PropertyDescriptor>();
let nextFrame = 0;
beforeAll(async () => {
  for (const key of ['width', 'height'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key)!;
    descriptors.set(key, descriptor);
    Object.defineProperty(HTMLCanvasElement.prototype, key, { ...descriptor,
      set(value) { descriptor.set!.call(this, value); const canvas = native.get(this); if (canvas) canvas[key] = value; },
    });
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    let canvas = native.get(this);
    if (!canvas) {
      canvas = createCanvas(this.width || 1, this.height || 1); native.set(this, canvas);
      const context = canvas.getContext('2d'), draw = context.drawImage;
      context.drawImage = function(source: any, ...args: any[]) {
        return (draw as any).call(this, native.get(source) ?? source, ...args);
      };
    }
    return canvas.getContext('2d') as any;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(512);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(512);
  OSD = (await import('openseadragon')).default;
  vi.stubGlobal('OpenSeadragon', OSD);
  vi.stubGlobal('localStorage', { getItem: () => null });
  ({ AppOSD } = await import('../src/app_osd'));
  OSD.pixelDensityRatio = 1;
  vi.spyOn(OSD, 'requestAnimationFrame').mockImplementation((callback: any) => {
    frames.set(++nextFrame, callback); return nextFrame;
  });
  vi.spyOn(OSD, 'cancelAnimationFrame').mockImplementation((id: any) => { frames.delete(id); });
});
afterAll(() => {
  for (const [key, descriptor] of descriptors) Object.defineProperty(HTMLCanvasElement.prototype, key, descriptor);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function draw(viewer: any) {
  viewer.forceRedraw();
  const callbacks = [...frames.values()]; frames.clear();
  for (const callback of callbacks) callback(performance.now());
}
const color = [48, 112, 176, 255];
function paint(job: any, tint = color, transparentHalf = false) {
  const source = job.source, { level, x, y } = job.tile;
  const bounds = source.getTileBounds(level, x, y, true);
  const canvas = createCanvas(bounds.width, bounds.height), context = canvas.getContext('2d');
  context.fillStyle = `rgb(${tint.slice(0, 3).join(',')})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (transparentHalf) {
    const scale = source.getLevelScale(level);
    context.clearRect(-x * source.getTileWidth(level), -y * source.getTileHeight(level),
      source.width * scale / 2, source.height * scale);
  }
  queueMicrotask(() => job.finish(context, null, 'context2d'));
}
async function appFixture(options: { hold?: boolean; loaderLimit?: number } = {}) {
  const mount = document.createElement('div'); document.body.appendChild(mount);
  const app = new AppOSD(mount, false), viewer = app.viewer, requests: any[] = [];
  let hold = !!options.hold;
  if (options.loaderLimit !== undefined) viewer.imageLoader.jobLimit = options.loaderLimit;
  const sources = definitions['dynamic-main-branch'].map(entry => {
    const image = JSON.parse(entry.dziContent).Image;
    const source = new OSD.DziTileSource({ width: +image.Size.Width, height: +image.Size.Height,
      tileSize: +image.TileSize, tileOverlap: +image.Overlap, fileFormat: image.Format,
      tilesUrl: entry.url.replace(/\.dzi$/, '_files/'), Image: image });
    source.downloadTileStart = (job: any) => { requests.push(job); if (!hold) paint(job); };
    return source;
  });
  // Keep actual AppOSD setMap/version binding/add-item placement and the real
  // Viewer/OSD loader/cache/drawer. Only DZI discovery and tile I/O are local.
  app.open = () => viewer.open(sources);
  await app.setMap('dynamic-main-branch', { x: 0, y: 5120, zoom: 1 / 1024 });
  viewer.autoResize = false;
  return { app, viewer, requests, sources,
    complete() { hold = false; for (const job of requests) if (job.jobId) paint(job); },
    close() { viewer.destroy(); mount.remove(); frames.clear(); } };
}

it('keeps every static world covered after a deep-link open and through unrelated cache eviction', async () => {
  const f = await appFixture(), { viewer } = f;
  try {
    await vi.waitFor(() => {
      expect(viewer.staticBackgroundResidency.images).toBe(3);
      expect(viewer.staticBackgroundResidency.pending).toBe(0);
      expect(viewer.staticBackgroundResidency.readyTiles).toBe(21);
    });
    expect(f.sources.every(source => source.__staticBackground)).toBe(true);
    expect(f.requests.every(job => job.src.endsWith('?v=current-test-version'))).toBe(true);
    expect(viewer.staticBackgroundResidency.decodedBytes).toBeLessThan(9 * 1024 * 1024);
    const items = Array.from({ length: 3 }, (_, i) => viewer.world.getItemAt(i));
    const overviews = items.flatMap((item: any) => viewer.tileCache.getLoadedTilesFor(item));
    expect(overviews).toHaveLength(21);
    console.info('[Static background residency]', { worlds: viewer.staticBackgroundResidency.images,
      tiles: viewer.staticBackgroundResidency.readyTiles, decodedBytes: viewer.staticBackgroundResidency.decodedBytes });

    const middle: any = items[0];
    const fine = middle._getTile(35, 72, 17, OSD.now(), middle.source.getNumTiles(17));
    middle._loadTile(fine, OSD.now());
    await vi.waitFor(() => expect(fine.loaded).toBe(true));

    // No new detail may arrive during the zoom-out; the overview was loaded
    // even for offscreen PWs and is still sufficient to avoid black holes.
    for (const item of items as any[]) item._loadTile = vi.fn();
    viewer.viewport.fitBounds(new OSD.Rect(0, 5120, 512, 512), true);
    draw(viewer);
    expect(middle._lastDrawn.some((info: any) => info.tile === fine)).toBe(true);
    expect([...viewer.drawer.context.getImageData(256, 256, 1, 1).data]).toEqual(color);
    for (const x of [-50000, -12000, 24000]) {
      viewer.viewport.fitBounds(new OSD.Rect(x, -18000, 24000, 24000), true);
      draw(viewer);
      for (const point of [[32, 32], [256, 256], [480, 480]])
        expect([...viewer.drawer.context.getImageData(...point, 1, 1).data]).toEqual(color);
    }

    // The incoming tiny source has cutoff=0. Vanilla OSD therefore evicts
    // level-nine background overviews despite their own higher cutoff.
    viewer.tileCache._maxCacheItemCount = 8;
    const other = new OSD.TileSource({ width: 64, height: 1, tileSize: 1, minLevel: 0, maxLevel: 6 });
    other.getTileUrl = (level: number, x: number, y: number) => `pressure://${level}/${x}/${y}`;
    other.downloadTileStart = paint;
    const pressure = await new Promise<any>(resolve => viewer.addTiledImage({ tileSource: other, x: 1000000, width: 64,
      success: (event: any) => resolve(event.item) }));
    for (const tile of overviews) tile.beingDrawn = false;
    for (let x = 0; x < 40; x++) {
      const tile = pressure._getTile(x, 0, 6, OSD.now(), other.getNumTiles(6));
      pressure._loadTile(tile, OSD.now());
      await vi.waitFor(() => expect(tile.loaded).toBe(true));
    }
    expect(overviews.every(tile => tile.loaded && tile.getCache())).toBe(true);
    expect(viewer.staticBackgroundResidency.readyTiles).toBe(21);
    viewer.viewport.fitBounds(new OSD.Rect(-12000, -18000, 24000, 24000), true);
    draw(viewer);
    expect([...viewer.drawer.context.getImageData(256, 256, 1, 1).data]).toEqual(color);
    for (const item of items) viewer.world.removeItem(item);
    expect(viewer.staticBackgroundResidency.images).toBe(0);
    expect(viewer.staticBackgroundResidency.decodedBytes).toBe(0);
    expect(viewer.staticBackgroundResidency.pending).toBe(0);
  } finally { f.close(); }
});

it.each(['daily', 'previous-daily'] as const)('keeps %s covered on the first zoom-out without waiting for new detail tiles', async prefix => {
  const f = await appFixture(), { viewer } = f;
  const bakedColor = [192, 80, 48, 255], items: any[] = [], requests: any[] = [];
  const placements = [-1, 0, 1].map(pw => ({
    pw, x: -17920 + pw * 35840, y: -31744, width: 35840,
    dziUrl: `https://${prefix}-${['left', 'middle', 'right'][pw + 1]}.acidflow.stream/map.dzi`, bust: `${prefix}-bake`,
  }));
  const originalAdd = viewer.addTiledImage.bind(viewer);
  // Keep the real baked loader's success tags, versioning and OSD event order;
  // supply local DZI metadata and painted tile responses instead of network I/O.
  const add = vi.spyOn(viewer, 'addTiledImage').mockImplementation((options: any) => {
    if (typeof options.tileSource !== 'string') return originalAdd(options);
    const source = new OSD.DziTileSource({ width: 35840, height: 73728, tileSize: 512,
      tileOverlap: 0, fileFormat: 'webp', tilesUrl: options.tileSource.replace(/\.dzi$/, '_files/') });
    source.downloadTileStart = (job: any) => { requests.push(job); paint(job, bakedColor, true); };
    return originalAdd({ ...options, tileSource: source });
  });
  try {
    addBakedDZIsToOSD(viewer, placements, item => items.push(item));
    await vi.waitFor(() => {
      expect(items).toHaveLength(3);
      expect(viewer.staticBackgroundResidency.pending).toBe(0);
    });
    const middle = items[0];
    const fine = middle._getTile(35, 72, 17, OSD.now(), middle.source.getNumTiles(17));
    middle._loadTile(fine, OSD.now());
    await vi.waitFor(() => expect(fine.loaded).toBe(true));
    // Hold every further tile request through rapid zoom changes and pans.
    // Only the resident whole-map coverage and one fine tile can be drawn.
    for (let i = 0; i < viewer.world.getItemCount(); i++) viewer.world.getItemAt(i)._loadTile = vi.fn();
    viewer.viewport.fitBounds(new OSD.Rect(0, 5120, 512, 512), true);
    draw(viewer);
    expect([...viewer.drawer.context.getImageData(256, 256, 1, 1).data]).toEqual(bakedColor);
    for (const pw of [0, -1, 1, 0]) {
      for (const width of [24000, 2048, 8192, 24000]) {
        viewer.viewport.fitBounds(new OSD.Rect(pw * 35840 - width / 2, 5120 - width / 2, width, width), true);
        draw(viewer);
        // Transparent bake pixels must reveal the original static background;
        // opaque biome pixels must retain baked coverage, including offscreen PWs.
        expect([...viewer.drawer.context.getImageData(64, 256, 1, 1).data]).toEqual(color);
        expect([...viewer.drawer.context.getImageData(448, 256, 1, 1).data]).toEqual(bakedColor);
      }
    }
    expect(items.every(item => item.source.__bakedDzi && !item.source.__staticBackground)).toBe(true);
    expect(requests.every(job => job.src.endsWith(`?v=${prefix}-bake`))).toBe(true);
    expect(viewer.staticBackgroundResidency.images).toBe(6);
    expect(viewer.staticBackgroundResidency.readyTiles).toBe(42);
    expect(viewer.staticBackgroundResidency.reservedBytes).toBeLessThanOrEqual(24 * 1024 * 1024);

    // Other overlays must not evict the baked fallback between camera frames.
    const overviews = items.flatMap(item => viewer.tileCache.getLoadedTilesFor(item).filter((tile: any) => tile !== fine));
    expect(overviews).toHaveLength(21);
    viewer.tileCache._maxCacheItemCount = 8;
    const other = new OSD.TileSource({ width: 32, height: 1, tileSize: 1, minLevel: 0, maxLevel: 5 });
    other.getTileUrl = (level: number, x: number, y: number) => `baked-pressure://${prefix}/${level}/${x}/${y}`;
    other.downloadTileStart = paint;
    const pressure = await new Promise<any>(resolve => viewer.addTiledImage({ tileSource: other, x: 1000000, width: 32,
      success: (event: any) => resolve(event.item) }));
    for (const tile of overviews) tile.beingDrawn = false;
    for (let x = 0; x < 16; x++) {
      const tile = pressure._getTile(x, 0, 5, OSD.now(), other.getNumTiles(5));
      pressure._loadTile(tile, OSD.now());
      await vi.waitFor(() => expect(tile.loaded).toBe(true));
    }
    expect(overviews.every(tile => tile.loaded && tile.getCache())).toBe(true);
    draw(viewer);
    expect([...viewer.drawer.context.getImageData(448, 256, 1, 1).data]).toEqual(bakedColor);
    for (const item of items) viewer.world.removeItem(item);
    expect(viewer.staticBackgroundResidency.images).toBe(3);
    expect(viewer.staticBackgroundResidency.readyTiles).toBe(21);
    expect(viewer.staticBackgroundResidency.pending).toBe(0);
  } finally { add.mockRestore(); f.close(); }
});

it('bounds planned residency and releases its hooks and queued loads when disposed', async () => {
  const f = await appFixture(), { viewer } = f;
  try {
    await vi.waitFor(() => expect(viewer.staticBackgroundResidency.pending).toBe(0));
    // A separate owner with an explicit tiny budget may retain only complete
    // levels, never a partial overview that pretends to cover the whole map.
    const before = viewer.tileCache._freeOldRecordRoutine;
    const release = installStaticBackgroundResidency(viewer, { maxBytes: 512 * 1024 });
    await vi.waitFor(() => expect(viewer.staticBackgroundResidency.images).toBe(3));
    expect(viewer.staticBackgroundResidency.decodedBytes).toBeLessThanOrEqual(512 * 1024);
    expect(viewer.staticBackgroundResidency.reservedBytes).toBeLessThanOrEqual(512 * 1024);
    expect(viewer.staticBackgroundResidency.tiles).toBe(3);
    release();
    expect(viewer.tileCache._freeOldRecordRoutine).toBe(before);
    expect(viewer.staticBackgroundResidency).toBeUndefined();
  } finally { f.close(); }
});

it('does not strand overview work when OSD clears a capacity-limited download queue', async () => {
  const f = await appFixture({ hold: true, loaderLimit: 1 }), { viewer } = f;
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(viewer.staticBackgroundResidency.decodedBytes).toBe(0);
    expect(viewer.staticBackgroundResidency.reservedBytes).toBeGreaterThan(0);
    // OSD clears queued jobs on each drawing update. Our extra overview work
    // stays outside that queue until the loader can actually start it.
    for (let i = 0; i < 4; i++) { draw(viewer); await Promise.resolve(); }
    f.complete();
    await vi.waitFor(() => {
      expect(viewer.staticBackgroundResidency.pending).toBe(0);
      expect(viewer.staticBackgroundResidency.readyTiles).toBe(21);
    });
  } finally { f.complete(); f.close(); }
});

it('drops pending overview work on map removal and ignores the old in-flight response', async () => {
  const f = await appFixture({ hold: true, loaderLimit: 1 }), { viewer } = f;
  const warning = vi.spyOn(OSD.console, 'warn').mockImplementation(() => {});
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 2));
    viewer.world.removeAll();
    expect(viewer.staticBackgroundResidency.pending).toBe(0);
    expect(viewer.staticBackgroundResidency.reservedBytes).toBe(0);
    f.complete();
    await vi.waitFor(() => expect(viewer.imageLoader.jobsInProgress).toBe(0));
    expect(f.requests).toHaveLength(1);
    expect(viewer.tileCache.getLoadedTilesFor(f.requests[0].tile.tiledImage)).toHaveLength(0);
    expect(viewer.staticBackgroundResidency.readyTiles).toBe(0);
  } finally { warning.mockRestore(); f.complete(); f.close(); }
});
