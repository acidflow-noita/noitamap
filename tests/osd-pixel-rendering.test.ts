// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { PIXEL_MAP_DRAW_OPTIONS, smoothInstantTile } from '../src/osd-pixel-rendering';

let OSD: any;
beforeAll(async () => {
  // Execute the installed OSD drawing/LOD methods, with native Skia pixels.
  // jsdom only supplies module globals; no browser or network is involved.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    return createCanvas(this.width || 1, this.height || 1).getContext('2d') as any;
  });
  OSD = (await import('openseadragon')).default;
  vi.stubGlobal('OpenSeadragon', OSD);
  OSD.pixelDensityRatio = 1;
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function firstRequestedLevel(immediateRender: boolean, targetRatio: number) {
  const requested: number[] = [];
  const tiled = Object.create(OSD.TiledImage.prototype);
  Object.assign(tiled, {
    immediateRender, minPixelRatio: .5, savedCutOffLevel: 0,
    loadDestinationTilesOnAnimation: true, _lastDrawn: [], _tilesToDraw: [],
    _scaleSpring: { current: { value: 1 } }, coverage: {},
    source: { minLevel: 0, maxLevel: 6, getPixelRatio: (level: number) => new OSD.Point(2 ** (6 - level), 1) },
    viewport: { deltaPixelsFromPointsNoRotate: (point: any, current: boolean) => point.times(current ? 1 : targetRatio) },
    viewer: { world: { ensureTilesUpToDate() {} } },
    getDrawArea: () => ({}), getLoadArea: () => ({}), _getCachedArray: () => [],
    _providesCoverage: () => false,
    _updateLevel(this: any, level: number, _opacity: number, visibility: number, _draw: any, _load: any, _time: number, candidates: any[]) {
      return { tilesToDraw: [], bestLoadTileCandidates: this._compareTiles(candidates,
        { level, visibility, squaredDistance: 0 }, 1) };
    },
    _loadTile: (tile: any) => requested.push(tile.level),
  });
  tiled._updateLevelsForViewport();
  return requested[0];
}

function stripes() {
  const canvas = createCanvas(4, 4), context = canvas.getContext('2d');
  for (let x = 0; x < 4; x++) {
    context.fillStyle = x % 2 ? '#0000ff' : '#ff0000';
    context.fillRect(x, 0, 1, 4);
  }
  return context;
}

function drawingFixture(filter = smoothInstantTile, animate = true, edgeZoom = Infinity) {
  const canvas = createCanvas(96, 32), sketch = createCanvas(96, 32);
  const drawer = Object.create(OSD.CanvasDrawer.prototype);
  const states: boolean[] = [];
  const viewport = {
    getRotation: () => 0, getFlip: () => false, getZoom: () => 4,
    getContainerSize: () => new OSD.Point(96, 32),
    viewportToViewerElementRectangle: () => new OSD.Rect(0, 0, 96, 32),
  };
  Object.assign(drawer, {
    _renderingTarget: canvas, context: canvas.getContext('2d'), sketchCanvas: sketch, sketchContext: sketch.getContext('2d'),
    viewport, _imageSmoothingEnabled: false,
    getDataToDraw: (tile: any) => tile.pixels,
    viewer: { viewport, isAnimating: () => animate, raiseEvent(name: string, event: any) {
      if (name === 'tile-drawing') {
        filter(event);
        states.push(event.context.imageSmoothingEnabled);
      }
    } },
  });
  drawer._updateImageSmoothingEnabled(drawer.context);
  drawer._updateImageSmoothingEnabled(drawer.sketchContext);
  const tile = (x: number, width = 16, level = 1) => ({
    loaded: true, opacity: 1, hasTransparency: true,
    position: new OSD.Point(x, 0.25), size: new OSD.Point(width, width),
    sourceBounds: new OSD.Rect(0, 0, 4, 4), level, pixels: stripes(),
    getUrl: () => 'native-test',
    getTranslationForEdgeSmoothing: OSD.Tile.prototype.getTranslationForEdgeSmoothing,
  });
  const image = (tiles: any[], instant: boolean, bottom = false) => ({
    opacity: 1, compositeOperation: 'source-over', smoothTileEdgesMinZoom: edgeZoom,
    subPixelRoundingForTransparency: OSD.SUBPIXEL_ROUNDING_OCCURRENCES.ONLY_AT_REST,
    getTilesToDraw: () => tiles.map(tile => ({ tile })),
    _isBottomItem: () => bottom, getRotation: () => 0, viewportToImageZoom: () => 4,
    getClippedBounds: () => new OSD.Rect(0, 0, 96, 32),
    source: { __instantTerrain: instant, maxLevel: 6, hasTransparency: () => true },
  });
  return { drawer, canvas, states, tile, image };
}

function mixedPixels(canvas: any, x: number, width: number) {
  const pixels = canvas.getContext('2d').getImageData(x, 2, width, 10).data;
  let mixed = 0;
  for (let p = 0; p < pixels.length; p += 4)
    if (pixels[p + 3] === 255 && pixels[p] > 0 && pixels[p + 2] > 0) mixed++;
  return mixed;
}

describe('pixel map rendering through the installed OpenSeadragon', () => {
  it('requests the closest detail before the coarse overview during zoom', () => {
    expect(PIXEL_MAP_DRAW_OPTIONS.imageSmoothingEnabled).toBe(false);
    expect(firstRequestedLevel(false, 4)).toBe(0);
    expect(firstRequestedLevel(PIXEL_MAP_DRAW_OPTIONS.immediateRender, 4)).toBe(6);
    expect(firstRequestedLevel(false, .25)).toBe(0);
    expect(firstRequestedLevel(PIXEL_MAP_DRAW_OPTIONS.immediateRender, .25)).toBe(4);
  });

  it.each([true, false])('keeps static and enlarged GPU pixels crisp through direct/sketch passes (animating=%s)', animate => {
    const { drawer, canvas, states, tile, image } = drawingFixture(smoothInstantTile, animate);
    drawer.draw([image([tile(.25)], false, true), image([tile(24.25)], true), image([tile(48.25)], false)]);
    expect(states).toEqual([false, false, false]);
    expect(mixedPixels(canvas, 1, 14)).toBe(0);
    expect(mixedPixels(canvas, 25, 14)).toBe(0);
    expect(mixedPixels(canvas, 49, 14)).toBe(0);
    expect(drawer.context.imageSmoothingEnabled).toBe(false);
    expect(drawer.sketchContext.imageSmoothingEnabled).toBe(false);
  });

  it('removes interpolation blur previously applied to enlarged coarse terrain', () => {
    const previous = (event: any) => {
      if (event.tiledImage.source.__instantTerrain)
        event.context.imageSmoothingEnabled = event.tile.level < event.tiledImage.source.maxLevel;
    };
    const old = drawingFixture(previous), fixed = drawingFixture();
    old.drawer.draw([old.image([old.tile(24.25)], true)]);
    fixed.drawer.draw([fixed.image([fixed.tile(24.25)], true)]);
    expect(mixedPixels(old.canvas, 25, 14)).toBeGreaterThan(80);
    expect(mixedPixels(fixed.canvas, 25, 14)).toBe(0);
  });

  it('still filters GPU reductions and restores both contexts before following static tiles', () => {
    const { drawer, canvas, states, tile, image } = drawingFixture();
    drawer.draw([image([tile(20, 2)], true), image([tile(48.25)], false)]);
    expect(states).toEqual([true, false]);
    const [red, , blue, alpha] = canvas.getContext('2d').getImageData(20, 1, 1, 1).data;
    expect(red).toBeGreaterThan(100); expect(blue).toBeGreaterThan(100); expect(alpha).toBe(255);
    expect(mixedPixels(canvas, 49, 14)).toBe(0);
    expect(drawer.context.imageSmoothingEnabled).toBe(false);
    expect(drawer.sketchContext.imageSmoothingEnabled).toBe(false);
  });

  it('keeps the installed tile-edge sketch pass crisp without disabling seam protection', () => {
    const { drawer, canvas, states, tile, image } = drawingFixture(smoothInstantTile, true, 1.1);
    drawer.draw([image([tile(.25), tile(16.25)], false, true), image([tile(48.25), tile(64.25)], true)]);
    expect(states).toEqual([false, false, false, false]);
    expect(mixedPixels(canvas, 1, 29)).toBe(0);
    expect(mixedPixels(canvas, 49, 29)).toBe(0);
  });
});
