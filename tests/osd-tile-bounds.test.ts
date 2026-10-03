// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { createInstantCoverage } from '../src/telescope/instant-terrain-coverage';
import { createPixelSceneTileSource } from '../src/telescope/pixel-scene-tile-source';

let OSD: any;
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    return createCanvas(this.width || 1, this.height || 1).getContext('2d') as any;
  });
  OSD = (await import('openseadragon')).default;
  OSD.pixelDensityRatio = 1;
  vi.stubGlobal('OpenSeadragon', OSD);
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  let bounds: any;
  const viewer = new OSD.EventSource();
  viewer.world = new OSD.World({ viewer });
  viewer.tileCache = new OSD.TileCache({ maxImageCacheCount: 100 });
  const viewport = {
    getBounds: () => bounds, getBoundsWithMargins: () => bounds,
    getCenter: () => bounds.getCenter(), getRotation: () => 0,
  };
  const drawer = { minimumOverlapRequired: () => false };
  function image(x: number, y: number, width: number, height: number,
    source = new OSD.TileSource({ width, height, tileSize: 256 })) {
    const item = new OSD.TiledImage({ source, viewer, viewport, drawer,
      tileCache: viewer.tileCache, imageLoader: new OSD.ImageLoader({ jobLimit: 0 }),
      x, y, width, ajaxHeaders: {}, discardLevelsBelowDownsampleRatio: 1 });
    item.getDrawer = () => drawer;
    return item;
  }
  return { image, viewer, move: (x: number, y: number, width: number) => {
    bounds = new OSD.Rect(x, y, width, width * 9 / 16);
  } };
}

it('keeps real OSD lookups within every shifted region and marker source at world edges', () => {
  const f = fixture(), items: any[] = [];
  for (const plane of [-1, 0, 1]) for (const pw of [-1, 0, 1])
    items.push(f.image(-17920 + pw * 35840, -7168 + plane * 24576, 35840, 24576));
  items.push(f.image(-52785, -29871, 104801, 71901));
  const invalid: any[] = [];
  const assertion = vi.spyOn(OSD.console, 'assert').mockImplementation(() => {});
  for (const item of items) {
    const original = item.source.getTileAtPoint;
    item.source.getTileAtPoint = function(level: number, point: any) {
      if (!(point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 / this.aspectRatio))
        invalid.push({ source: [this.width, this.height], point, area: item.getDrawArea(), level });
      return original.call(this, level, point);
    };
  }
  try {
    for (const width of [128, 512, 2048, 35840, 100000, 200000]) {
      for (const item of items) {
        const b = item.getBounds(true);
        for (const x of [b.x - width, b.x, b.x + b.width, b.x + b.width - 1e-11])
          for (const y of [b.y - width * 9 / 16, b.y, b.y + b.height, b.y + b.height - 1e-11]) {
            f.move(x, y, width);
            for (const image of items) {
              const area = image.getDrawArea();
              if (!area) continue;
              for (const level of [0, 8, image.source.maxLevel])
                image._visitTiles(level, area, () => false);
            }
          }
      }
    }
    expect(invalid.slice(0, 10)).toEqual([]);
    expect(assertion.mock.calls.filter(([valid]) => !valid)).toEqual([]);
  } finally { assertion.mockRestore(); }
});

it('warms a real sparse scene source without exceeding OSD’s normalized bottom edge', () => {
  const f = fixture(), controller = new AbortController();
  const layer = createPixelSceneTileSource({
    items: [
      { osdX: -52735, osdY: -29821, w: 1, h: 1, sceneKey: 'first' },
      { osdX: -52735 + 107419, osdY: -29821 + 71799, w: 1, h: 1, sceneKey: 'last' },
    ], bitmapByKey: new Map(), generationId: 1,
  });
  const source = layer.source;
  const item = f.image(-52785, -29871, source.width, source.height, source);
  const coverage = createInstantCoverage(f.viewer, controller.signal);
  const assertion = vi.spyOn(OSD.console, 'assert').mockImplementation(() => {});
  const lookup = vi.spyOn(source, 'getTileAtPoint');
  try {
    expect(source.width).toBe(107520);
    expect(source.height).toBe(71900);
    // Both expressions are mathematically equivalent, but differ by one ULP.
    expect(source.height / source.width).toBeGreaterThan(1 / source.aspectRatio);
    coverage.add(item);
    expect(assertion.mock.calls.filter(([valid]) => !valid)).toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(lookup.mock.calls[1][1]).toEqual(new OSD.Point(1, 1 / source.aspectRatio));
    // Matching OSD's boundary still includes the final scene and edge tile.
    const level = source.getClosestLevel() + 1, count = source.getNumTiles(level);
    expect(item.tilesMatrix[level][count.x - 1][count.y - 1].exists).toBe(true);
    expect(coverage.stats.regions).toBe(1);
  } finally {
    controller.abort(); source.destroy(); lookup.mockRestore(); assertion.mockRestore();
  }
});
