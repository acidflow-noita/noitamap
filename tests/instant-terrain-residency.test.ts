// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  createInstantCoverage,
  INSTANT_COVERAGE_EXTRA_LEVELS,
} from "../src/telescope/instant-terrain-coverage";
import { InstantTerrainCache } from "../src/telescope/instant-terrain-cache";
import { WORLD_HEIGHT, WORLD_TOP } from "../src/telescope/terrain-policy";

import { createInstantTileSource } from "../src/telescope/instant-terrain";
vi.mock("../src/telescope/instant-terrain-backend", () => ({
  prepareInstantTerrain: vi.fn(),
}));
vi.mock("../src/telescope/instant-terrain-plane", () => ({
  setTerrainPlane: vi.fn(),
}));
let OSD: any;
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      return createCanvas(this.width || 1, this.height || 1).getContext(
        "2d",
      ) as any;
    },
  );
  OSD = (await import("openseadragon")).default;
  OSD.pixelDensityRatio = 1;
  vi.stubGlobal("OpenSeadragon", OSD);
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    name: string,
    options?: ElementCreationOptions,
  ) =>
    name === "canvas"
      ? createCanvas(1, 1)
      : createElement(name, options)) as any);
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(maxImages = 200) {
  const abort = new AbortController(),
    viewer = new OSD.EventSource();
  viewer.world = new OSD.World({ viewer });
  viewer.world.requestTileInvalidateEvent = async () => {};
  viewer.world.ensureTilesUpToDate = () => {};
  viewer.forceRedraw = vi.fn();
  viewer.isDestroyed = () => false;
  viewer.tileRetryMax = 0;
  viewer.tileCache = new OSD.TileCache({ maxImageCacheCount: maxImages });
  const imageLoader = new OSD.ImageLoader({ jobLimit: 0 });
  const cache = new InstantTerrainCache();
  const requests: string[] = [],
    rendered: string[] = [],
    waiting: (() => void)[] = [];
  const images: any[] = [];
  viewer.world.getItemAt = (index: number) => images[index];
  viewer.isAnimating = () => false;
  let hold = false,
    failure = false;
  let currentBounds = new OSD.Rect(-17920, WORLD_TOP, 35840, WORLD_HEIGHT);
  let targetBounds = currentBounds;
  const viewport = {
    _containerInnerSize: new OSD.Point(560, 384),
    getBounds: (current = false) => (current ? currentBounds : targetBounds),
    getBoundsWithMargins: (current = false) =>
      current ? currentBounds : targetBounds,
    getCenter: (current = false) =>
      (current ? currentBounds : targetBounds).getCenter(),
    pixelFromPoint: (p: any) =>
      p.minus(currentBounds.getTopLeft()).times(560 / currentBounds.width),
    pixelFromPointNoRotate: (p: any) =>
      p.minus(currentBounds.getTopLeft()).times(560 / currentBounds.width),
    deltaPixelsFromPointsNoRotate: (p: any, current = false) =>
      p.times(560 / (current ? currentBounds : targetBounds).width),
    getRotation: () => 0,
    getFlip: () => false,
    getZoom: () => 1 / currentBounds.width,
    getContainerSize: () => new OSD.Point(560, 384),
    viewportToViewerElementRectangle: (rect: any) =>
      new OSD.Rect(
        ((rect.x - currentBounds.x) * 560) / currentBounds.width,
        ((rect.y - currentBounds.y) * 560) / currentBounds.width,
        (rect.width * 560) / currentBounds.width,
        (rect.height * 560) / currentBounds.width,
      ),
  };
  const drawer = {
    minimumOverlapRequired: () => false,
    getSupportedDataFormats: () => ["context2d"],
    options: { usePrivateCache: false },
  };
  viewer.viewport = viewport;
  const coverage = createInstantCoverage(viewer, abort.signal);
  let serial = 0;
  function image(plane = 0, pw = 0, tiny = false) {
    const id = ++serial;
    const region = {
      x: -17920 + pw * 35840,
      y: WORLD_TOP + plane * WORLD_HEIGHT,
      width: tiny ? 1 : 35840,
      height: tiny ? 1 : WORLD_HEIGHT,
      pw,
    };
    const source = createInstantTileSource({
      region,
      deps: {
        getWorldCenter: () => 35,
        getWorldSize: () => 70,
        GENERATOR_CONFIG: {},
        initMaterialAtlas: async () => {},
        GLTerrainRenderer: class {} as any,
      },
      gen: {
        seed: 42,
        isNGP: false,
        tileLayers: [],
        biomeData: { pixels: new Uint32Array(70 * 48) },
      },
      renderer: {
        render(view: any) {
          const canvas = createCanvas(view.width, view.height);
          canvas.getContext("2d").fillRect(0, 0, view.width, view.height);
          rendered.push(String(view.scale));
          return canvas;
        },
      },
      clip: {
        draw(ctx, image) {
          ctx.drawImage(image, 0, 0);
        },
        dispose() {},
      },
      cache,
      signal: abort.signal,
      onFailure: (error) => {
        throw error;
      },
    });
    const originalDownload = source.downloadTileStart;
    source.downloadTileStart = (job: any) => {
      requests.push(job.src);
      originalDownload(job);
    };
    const item = new OSD.TiledImage({
      source,
      viewer,
      viewport,
      tileCache: viewer.tileCache,
      drawer,
      imageLoader,
      width: source.width,
      x: source.instantRegion.x,
      y: source.instantRegion.y,
      immediateRender: true,
      maxTilesPerFrame: 1,
      discardLevelsBelowDownsampleRatio: 1,
      ajaxHeaders: {},
    });
    item.getDrawer = () => drawer;
    images.push(item);
    viewer.world.addItem(item);
    return item;
  }
  function draw(item: any) {
    item._updateLevelsForViewport();
    const canvas = createCanvas(560, 384);
    const nativeDrawer = Object.create(OSD.CanvasDrawer.prototype);
    Object.assign(nativeDrawer, {
      _renderingTarget: canvas,
      context: canvas.getContext("2d"),
      sketchCanvas: null,
      sketchContext: null,
      viewport,
      viewer,
      _imageSmoothingEnabled: false,
      getDataToDraw: (tile: any) => tile.getCache().data,
    });
    nativeDrawer._updateImageSmoothingEnabled(nativeDrawer.context);
    nativeDrawer.draw([item]);
    return canvas.getContext("2d").getImageData(0, 0, 560, 384).data;
  }
  const cutoff = (item: any) =>
    item._getTile(
      0,
      0,
      item.savedCutOffLevel,
      OSD.now(),
      item.source.getNumTiles(item.savedCutOffLevel),
    );
  const close = () => {
    abort.abort();
    cache.clear();
    viewer.tileCache.clear();
  };
  return {
    viewer,
    coverage,
    abort,
    image,
    cutoff,
    draw,
    requests,
    rendered,
    waiting,
    cache,
    close,
    setView: (bounds: any, destinationOnly = false) => {
      targetBounds = bounds;
      if (!destinationOnly) currentBounds = bounds;
    },
    setHold: (value: boolean) => {
      hold = value;
    },
    setFailure: (value: boolean) => {
      failure = value;
    },
  };
}

describe("production terrain source residency through real OSD", () => {
  it("draws retained useful bases immediately after 240 detail tiles pressure both caches", async () => {
    const f = fixture();
    try {
      const items: any[] = [];
      for (const plane of [0, -1, 1])
        for (const pw of [0, -1, 1]) {
          const item = f.image(plane, pw);
          items.push(item);
          f.coverage.add(item);
        }
      f.coverage.start();
      await vi.waitFor(() => expect(f.coverage.stats.prepared).toBe(81), {
        timeout: 10000,
      });
      const resident = () =>
        items
          .flatMap((item) =>
            [8, 9, 10].flatMap((level) => {
              const n = item.source.getNumTiles(level);
              const tiles: any[] = [];
              for (let y = 0; y < n.y; y++)
                for (let x = 0; x < n.x; x++)
                  tiles.push(item._getTile(x, y, level, 0, n));
              return tiles;
            }),
          )
          .reduce(
            (a, t) => {
              if (t.loaded) a[t.level]++;
              return a;
            },
            { 8: 0, 9: 0, 10: 0 } as any,
          );
      const before = resident();
      const item = items[0];
      for (let i = 0; i < 240; i++) {
        const tile = item._getTile(
          i % 20,
          Math.floor(i / 20),
          16,
          OSD.now(),
          item.source.getNumTiles(16),
        );
        item._loadTile(tile, OSD.now());
        await vi.waitFor(() => expect(tile.loaded).toBe(true), { interval: 1 });
      }
      const after = resident(),
        cached = { ...f.cache.stats };
      f.setView(new OSD.Rect(-17920, WORLD_TOP, 35840, WORLD_HEIGHT));
      item._currentMaxTilesPerFrame = item.maxTilesPerFrame;
      item._updateLevelsForViewport();
      const drawLevels = item.getTilesToDraw().map((info: any) => info.level);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(before).toEqual({ 8: 9, 9: 18, 10: 54 });
      expect(after).toEqual(before);
      expect(cached.pinned).toBe(81);
      expect(cached.evictions).toBeGreaterThan(100);
      expect(drawLevels).toEqual([10, 10, 10, 10, 10, 10]);
      const pixels = f.draw(item);
      expect(pixels[3]).toBe(255);
      expect(pixels[pixels.length - 1]).toBe(255);
      // OSD may start an eligible finer refinement, but no source request is
      // needed to make these already-resident useful bases drawable.
      expect(item._lastDrawn.every((info: any) => info.tile.loaded)).toBe(true);
      const selected = item._lastDrawn[0].tile;
      selected.beingDrawn = false;
      expect(selected.beingDrawn).toBe(true);
      f.abort.abort();
      expect(selected.beingDrawn).toBe(false);
      expect(
        Object.getOwnPropertyDescriptor(selected, "beingDrawn")?.get,
      ).toBeUndefined();
    } finally {
      f.close();
    }
  });
});
