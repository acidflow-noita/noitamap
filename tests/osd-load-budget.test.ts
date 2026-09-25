// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { createInstantTileSource } from '../src/telescope/instant-terrain';
import { PIXEL_MAP_DRAW_OPTIONS } from '../src/osd-pixel-rendering';

vi.mock('../src/telescope/instant-terrain-backend', () => ({ prepareInstantTerrain: vi.fn() }));
vi.mock('../src/telescope/instant-terrain-plane', () => ({ setTerrainPlane: vi.fn() }));
let OSD: any;
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    return createCanvas(this.width || 1, this.height || 1).getContext('2d') as any;
  });
  OSD = (await import('openseadragon')).default;
  OSD.pixelDensityRatio = 1;
  vi.stubGlobal('OpenSeadragon', OSD);
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((name: string, options?: ElementCreationOptions) =>
    name === 'canvas' ? createCanvas(1, 1) : create(name, options)) as any);
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function replay(maxTilesPerFrame: number) {
  const signal = new AbortController(), viewer = new OSD.EventSource();
  viewer.world = new OSD.World({ viewer });
  viewer.world.requestTileInvalidateEvent = async () => {};
  viewer.world.ensureTilesUpToDate = () => {};
  viewer.forceRedraw = () => {};
  viewer.isDestroyed = () => false;
  viewer.tileRetryMax = 0;
  viewer.tileCache = new OSD.TileCache({ maxImageCacheCount: 200 });
  const bounds = new OSD.Rect(-1024, 0, 1920, 1080);
  const viewport = {
    _containerInnerSize: new OSD.Point(1920, 1080),
    getBounds: () => bounds, getBoundsWithMargins: () => bounds,
    getCenter: () => bounds.getCenter(),
    pixelFromPoint: (p: any) => p.minus(bounds.getTopLeft()),
    pixelFromPointNoRotate: (p: any) => p.minus(bounds.getTopLeft()),
    deltaPixelsFromPointsNoRotate: (p: any) => p,
    getRotation: () => 0, getFlip: () => false,
    getZoom: () => 1 / bounds.width, getContainerSize: () => new OSD.Point(1920, 1080),
  };
  viewer.viewport = viewport;
  const renderer = { render: vi.fn((view: any) => {
    const canvas = createCanvas(view.width, view.height), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fc8000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }) };
  const source = createInstantTileSource({
    region: { x: -17920, y: -7168, width: 35840, height: 24576, pw: 0 },
    deps: { GLTerrainRenderer: class {} as any, initMaterialAtlas: async () => {},
      getWorldSize: () => 70, getWorldCenter: () => 35, GENERATOR_CONFIG: {} },
    gen: { seed: 42, isNGP: false, tileLayers: [], biomeData: { pixels: new Uint32Array(70 * 48) } },
    renderer, signal: signal.signal, onFailure: error => { throw error; },
    clip: { draw: (ctx, image) => ctx.drawImage(image, 0, 0), dispose() {} },
  });
  const drawer = { minimumOverlapRequired: () => false, getSupportedDataFormats: () => ['context2d'],
    options: { usePrivateCache: false } };
  const item = new OSD.TiledImage({ source, viewer, viewport, drawer, tileCache: viewer.tileCache,
    imageLoader: new OSD.ImageLoader({ jobLimit: 0 }), width: 35840, x: -17920, y: -7168,
    ...PIXEL_MAP_DRAW_OPTIONS, maxTilesPerFrame, discardLevelsBelowDownsampleRatio: 1, ajaxHeaders: {} });
  item.getDrawer = () => drawer;
  viewer.world.addItem(item);
  const tiles: any[] = [];
  const area = item.getDrawArea();
  const first = source.getTileAtPoint(16, area.getTopLeft());
  const last = source.getTileAtPoint(16, area.getBottomRight());
  for (let y = first.y; y <= last.y; y++) for (let x = first.x; x <= last.x; x++) {
    const tile = item._getTile(x, y, 16, OSD.now(), source.getNumTiles(16));
    tiles.push(tile); item._loadTile(tile, OSD.now());
  }
  try {
    await vi.waitFor(() => expect(tiles.every(tile => tile.loaded)).toBe(true));
    const warmDraws = renderer.render.mock.calls.length;
    // Revisit after OSD evicts its own copies; production source pixels remain.
    for (const tile of tiles) viewer.tileCache.unloadTile(tile, true);
    item._currentMaxTilesPerFrame = maxTilesPerFrame; // normal post-startup budget
    let frames = 0;
    while (tiles.some(tile => !tile.loaded) && frames < 100) {
      item._updateLevelsForViewport();
      // Source-cache copies complete asynchronously, without any GPU work.
      await new Promise(resolve => setTimeout(resolve, 0));
      frames++;
    }
    expect(tiles.every(tile => tile.loaded)).toBe(true);
    expect(renderer.render.mock.calls.length).toBe(warmDraws);
    return { frames, tiles: tiles.length };
  } finally {
    signal.abort(); viewer.tileCache.clear();
  }
}

it('restores an FHD viewport from the production terrain cache without one-tile-per-frame loading', async () => {
  const previous = await replay(1);
  const current = await replay(PIXEL_MAP_DRAW_OPTIONS.maxTilesPerFrame ?? 1);
  expect(previous.frames).toBeGreaterThanOrEqual(30);
  expect(current.tiles).toBe(previous.tiles);
  expect(current.frames).toBeLessThanOrEqual(3);
  console.info('[OSD cached viewport replay]', { previous, current });
});
