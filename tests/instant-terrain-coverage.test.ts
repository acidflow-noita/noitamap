// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  createInstantCoverage,
  INSTANT_COVERAGE_EXTRA_LEVELS,
} from "../src/telescope/instant-terrain-coverage";
import { InstantTerrainCache } from "../src/telescope/instant-terrain-cache";
import { WORLD_HEIGHT, WORLD_TOP } from "../src/telescope/terrain-policy";
import { installTerrainAdmission } from "../src/osd-terrain-admission";

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
  function image(
    plane = 0,
    pw = 0,
    tiny = false,
    configure?: (source: any) => void,
  ) {
    const id = ++serial;
    const source = new OSD.TileSource({
      width: tiny ? 1 : 35840,
      height: tiny ? 1 : WORLD_HEIGHT,
      tileSize: 256,
      minLevel: 0,
      maxLevel: tiny ? 0 : 16,
    });
    source.__instantTerrain = !tiny;
    source.instantRegion = {
      x: -17920 + pw * 35840,
      y: WORLD_TOP + plane * WORLD_HEIGHT,
      pw,
    };
    source.getTileUrl = (level: number, x: number, y: number) =>
      `coverage://${id}/${level}/${x}/${y}`;
    source.hasTransparency = () => true;
    source.downloadTileStart = (job: any) => {
      const key = job.src;
      requests.push(key);
      const finish = () => {
        if (failure) {
          job.fail("fixture failure");
          return;
        }
        const hit = cache.get(key);
        if (hit) {
          job.finish(hit, null, "context2d");
          return;
        }
        const size = source.getTileBounds(
          job.tile.level,
          job.tile.x,
          job.tile.y,
          true,
        );
        const canvas = createCanvas(
          Math.ceil(size.width),
          Math.ceil(size.height),
        );
        const context = canvas.getContext("2d");
        context.fillStyle = "#2468ac";
        context.fillRect(0, 0, canvas.width, canvas.height);
        if (!tiny)
          context.clearRect(
            canvas.width / 4,
            canvas.height / 4,
            canvas.width / 4,
            canvas.height / 4,
          );
        cache.set(
          key,
          context as any,
          job.tile.level >= source.getClosestLevel() &&
            job.tile.level <=
              source.getClosestLevel() + INSTANT_COVERAGE_EXTRA_LEVELS,
        );
        rendered.push(key);
        job.finish(context, null, "context2d");
      };
      if (hold) waiting.push(finish);
      else queueMicrotask(finish);
    };
    source.downloadTileAbort = () => {};
    configure?.(source);
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

describe("retained coverage through the installed OSD loader/cache", () => {
  it("starts its coverage deadline only after admission, not during a busy render queue", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let dispose = () => {};
    try {
      const item = f.image();
      // Isolate the coverage deadline from ImageJob's separately tested clock:
      // this controlled loader holds admitted work without starting an ImageJob.
      item._loadTile = vi.fn();
      dispose = installTerrainAdmission(f.viewer);
      for (const x of [0, 1]) {
        const tile = item._getTile(
          x,
          0,
          11,
          OSD.now(),
          item.source.getNumTiles(11),
        );
        item._loadTile(tile, OSD.now());
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(f.viewer.terrainAdmissionStats.active).toBe(2);
      f.coverage.start();
      await vi.advanceTimersByTimeAsync(36000);
      expect(f.viewer.terrainAdmissionStats.queued).toBe(1);
      expect(f.coverage.stats.failed).toBe(0);
      const tile = item.tilesMatrix[11][0][0];
      f.viewer.raiseEvent("tile-loaded", { tile, promise: Promise.resolve() });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.viewer.terrainAdmissionStats.queued).toBe(0);
      await vi.advanceTimersByTimeAsync(34000);
      expect(f.coverage.stats.failed).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.coverage.stats.failed).toBe(1);
    } finally {
      f.close();
      dispose();
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it("waits for first paint, then warms three base levels for all nine regions", async () => {
    const f = fixture();
    try {
      const items = [];
      for (const plane of [1, -1, 0])
        for (const pw of [1, -1, 0]) {
          const item = f.image(plane, pw);
          items.push(item);
          f.coverage.add(item);
        }
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(f.requests).toHaveLength(0);
      f.coverage.start();
      await vi.waitFor(() => expect(f.coverage.stats.prepared).toBe(81));
      expect(f.rendered).toHaveLength(81);
      expect(items.every((item) => f.cutoff(item).loaded)).toBe(true);
      expect(f.requests[0]).toMatch(new RegExp(`coverage://${9}/10/`));
      expect(f.cache.stats.pinned).toBe(81);
      expect(f.cache.stats.bytes).toBe(
        9 * (140 * 96 + 280 * 192 + 560 * 384) * 4,
      );
      expect(f.coverage.stats.adaptiveTiles).toBe(0);
    } finally {
      f.close();
    }
  });

  it("draws the useful 560×384 base level instead of only a 140×96 thumbnail", async () => {
    const f = fixture();
    try {
      const item = f.image();
      f.coverage.add(item);
      f.coverage.start();
      await vi.waitFor(() => expect(f.coverage.stats.prepared).toBe(9));
      f.setHold(true);
      item._updateLevelsForViewport();
      const drawn = item.getTilesToDraw();
      expect(drawn).toHaveLength(6);
      expect(
        drawn.every((info: any) => info.level === 10 && info.tile.loaded),
      ).toBe(true);
      expect(f.rendered).toHaveLength(9);
      expect([...f.draw(item).slice(0, 4)]).toEqual([36, 104, 172, 255]);
      for (const finish of f.waiting.splice(0)) finish();
    } finally {
      f.close();
    }
  });

  it("keeps base pixels resident when tiny unrelated sources pressure the cache", async () => {
    const f = fixture(1);
    try {
      const item = f.image();
      f.coverage.start();
      await vi.waitFor(() => expect(f.coverage.stats.prepared).toBe(9));
      const tile = f.cutoff(item),
        original = tile.getCache().data;
      tile.beingDrawn = false;
      const tiny = f.image(0, 0, true);
      tiny._loadTile(f.cutoff(tiny), OSD.now());
      await vi.waitFor(() => expect(f.cutoff(tiny).loaded).toBe(true));
      expect(tile.loaded).toBe(true);
      expect(tile.getCache().data).toBe(original);
      expect(tile.beingDrawn).toBe(true);
      const before = f.requests.length;
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect(f.requests).toHaveLength(before);
      f.abort.abort();
      expect(tile.beingDrawn).toBe(false);
      expect(
        Object.getOwnPropertyDescriptor(tile, "beingDrawn")?.get,
      ).toBeUndefined();
    } finally {
      f.close();
    }
  });

  it("does not duplicate foreground loads and accepts images arriving after start", async () => {
    const f = fixture();
    try {
      f.coverage.start();
      f.setHold(true);
      const item = f.image();
      for (let level = 8; level <= 10; level++) {
        const count = item.source.getNumTiles(level);
        for (let y = 0; y < count.y; y++)
          for (let x = 0; x < count.x; x++)
            item._loadTile(
              item._getTile(x, y, level, OSD.now(), count),
              OSD.now(),
            );
      }
      f.coverage.add(item);
      f.coverage.add(item);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(f.requests).toHaveLength(9);
      for (const finish of f.waiting.splice(0)) finish();
      await vi.waitFor(() => expect(f.coverage.stats.prepared).toBe(9));
      expect(f.requests).toHaveLength(9);
      expect(f.coverage.stats.regions).toBe(1);
    } finally {
      f.close();
    }
  });

  it("clears undispatched work and handlers on item removal or generation cancellation", async () => {
    const f = fixture();
    try {
      const removed = f.image(),
        current = f.image(0, 1);
      f.coverage.add(removed);
      f.coverage.add(current);
      f.viewer.world.raiseEvent("remove-item", { item: removed });
      f.setHold(true);
      f.coverage.start();
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      expect(f.requests[0]).toContain("coverage://2/");
      f.abort.abort();
      f.viewer.raiseEvent("update-level", { tiledImage: removed });
      f.coverage.add(f.image(1));
      f.waiting.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(f.requests).toHaveLength(1);
      expect(f.coverage.stats.prepared).toBe(0);
      expect(f.viewer.numberOfHandlers("tile-loaded")).toBe(0);
      expect(f.viewer.numberOfHandlers("update-level")).toBe(0);
      expect(f.viewer.numberOfHandlers("zoom")).toBe(0);
    } finally {
      f.close();
    }
  });

  it("settles a failed load and continues preparing other base tiles", async () => {
    const f = fixture(),
      warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const item = f.image();
      f.coverage.add(item);
      f.setFailure(true);
      f.coverage.start();
      await vi.waitFor(() =>
        expect(f.coverage.stats.failed).toBeGreaterThan(0),
      );
      f.setFailure(false);
      await vi.waitFor(() => expect(f.requests.length).toBe(9));
      expect(f.coverage.stats.failed).toBeGreaterThan(0);
    } finally {
      f.close();
      warning.mockRestore();
      error.mockRestore();
    }
  });

  it("times out an existing OSD load without deadlocking the coverage queue", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const item = f.image();
      for (let level = 8; level <= 10; level++) {
        const count = item.source.getNumTiles(level);
        for (let y = 0; y < count.y; y++)
          for (let x = 0; x < count.x; x++)
            item._getTile(x, y, level, OSD.now(), count).loading = true;
      }
      f.coverage.add(item);
      f.coverage.start();
      await vi.advanceTimersByTimeAsync(35020);
      expect(f.coverage.stats.failed).toBe(1);
      expect(String(warning.mock.calls[0][1])).toContain("timed out");
      expect(f.requests).toHaveLength(0);
    } finally {
      f.close();
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it("prepares the full 2× zoom-out viewport one level below demand with bounded work", async () => {
    const f = fixture();
    try {
      f.setView(new OSD.Rect(-1024, 0, 2048, 1408));
      const item = f.image();
      f.coverage.add(item);
      f.coverage.start();
      await vi.waitFor(() => expect(f.coverage.stats.prepared).toBe(15));
      expect(f.coverage.stats.adaptiveTiles).toBe(6);
      const adaptive = f.requests.filter(
        (key) => Number(key.split("/")[3]) > 10,
      );
      expect(adaptive).toHaveLength(6);
      expect(adaptive.every((key) => key.includes("/13/"))).toBe(true);
      expect(f.requests[0]).toContain("/13/");
      // Move directly to the prepared 2× footprint. Installed OSD can draw the
      // six retained level-13 tiles without requesting replacement GPU work.
      f.setView(new OSD.Rect(-2048, -704, 4096, 2816));
      item._updateLevelsForViewport();
      expect(
        item
          .getTilesToDraw()
          .every((info: any) => info.level === 13 && info.tile.loaded),
      ).toBe(true);
    } finally {
      f.close();
    }
  });

  it("uses physical pixel density and coarsens the union of current and distant destination to 48 tiles", async () => {
    const f = fixture();
    try {
      OSD.pixelDensityRatio = 2;
      f.setView(new OSD.Rect(-1024, 0, 2048, 1408));
      f.setView(new OSD.Rect(34000, 0, 2048, 1408), true);
      for (const pw of [0, -1, 1]) f.coverage.add(f.image(0, pw));
      f.setHold(true);
      f.coverage.start();
      expect(f.coverage.stats.adaptiveTiles).toBeGreaterThan(0);
      expect(f.coverage.stats.adaptiveTiles).toBeLessThanOrEqual(48);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      // One coverage RPC remains active regardless of the size of the plan.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(f.requests).toHaveLength(1);
      f.abort.abort();
      for (const finish of f.waiting.splice(0)) finish();
    } finally {
      OSD.pixelDensityRatio = 1;
      f.close();
    }
  });

  it("drops obsolete queued adaptive tiles before dispatch without failing the active OSD tile", async () => {
    const f = fixture();
    try {
      f.setView(new OSD.Rect(-1024, 0, 2048, 1408));
      const item = f.image();
      f.coverage.add(item);
      f.setHold(true);
      f.coverage.start();
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      const active = f.requests[0];
      f.setView(new OSD.Rect(10000, 0, 2048, 1408));
      f.viewer.raiseEvent("pan");
      expect(f.coverage.stats.obsolete).toBe(5);
      expect(f.coverage.stats.adaptiveTiles).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 140));
      f.setHold(false);
      f.waiting.shift()!();
      await vi.waitFor(() =>
        expect(f.coverage.stats.prepared).toBeGreaterThan(9),
      );
      const adaptive = f.requests.filter((key) => key.includes("/13/"));
      expect(adaptive[0]).toBe(active);
      expect(
        adaptive.slice(1).every((key) => Number(key.split("/")[4]) >= 12),
      ).toBe(true);
      expect(f.coverage.stats.failed).toBe(0);
    } finally {
      f.close();
    }
  });

  it("reuses an existing OSD cache record before invoking the tile source", async () => {
    const f = fixture();
    try {
      const first = f.image();
      f.coverage.add(first);
      f.coverage.start();
      await vi.waitFor(() => expect(f.coverage.stats.prepared).toBe(9));
      const second = f.image(0, 0, false, (source) => {
        source.getTileUrl = first.source.getTileUrl;
      });
      f.coverage.add(second);
      await vi.waitFor(() => expect(f.coverage.stats.prepared).toBe(18));
      expect(f.requests).toHaveLength(9);
      expect(f.coverage.stats.cacheHits).toBe(9);
      expect(f.cutoff(second).loaded).toBe(true);
    } finally {
      f.close();
    }
  });

  it("selects a finer adaptive level on a double-density display", async () => {
    const f = fixture();
    try {
      OSD.pixelDensityRatio = 2;
      f.setView(new OSD.Rect(-1024, 0, 2048, 1408));
      const item = f.image();
      f.coverage.add(item);
      f.setHold(true);
      f.coverage.start();
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      expect(f.requests[0]).toContain("/14/");
      expect(f.coverage.stats.adaptiveTiles).toBeLessThanOrEqual(48);
      f.abort.abort();
      for (const finish of f.waiting.splice(0)) finish();
    } finally {
      OSD.pixelDensityRatio = 1;
      f.close();
    }
  });

  it("matches real OSD's level choice at the 0.69 physical-pixel boundary", async () => {
    const f = fixture();
    try {
      f.setView(new OSD.Rect(-256, 0, 560 / 0.69, 384 / 0.69));
      const item = f.image();
      f.setHold(true);
      item._updateLevelsForViewport();
      const foreground = f.requests.length;
      expect(foreground).toBeGreaterThan(0);
      expect(f.requests[0]).toContain("/16/");
      f.coverage.add(item);
      f.coverage.start();
      await vi.waitFor(() => expect(f.requests).toHaveLength(foreground + 1));
      // OSD prefers ratio 0.69 over its parent's 1.38; lookahead is exactly
      // one level below that demand, not two levels below it.
      expect(f.requests[foreground]).toContain("/15/");
      f.abort.abort();
      for (const finish of f.waiting.splice(0)) finish();
    } finally {
      f.close();
    }
  });

  it("continues immediately when real World.removeItem destroys the pending image", async () => {
    const f = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const removed = f.image(),
        next = f.image(0, 1);
      f.coverage.add(removed);
      f.coverage.add(next);
      f.setHold(true);
      f.coverage.start();
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      expect(f.requests[0]).toContain("coverage://1/");
      f.viewer.world.removeItem(removed);
      // No completion callback for the removed image and no 35-second wait.
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
      expect(f.requests[1]).toContain("coverage://2/");
      expect(f.coverage.stats.failed).toBe(0);
      f.abort.abort();
      for (const finish of f.waiting.splice(0)) finish();
    } finally {
      f.close();
      warning.mockRestore();
    }
  });
  it("registers only tagged sparse scene sources and releases their pins on removal", async () => {
    const f = fixture();
    try {
      f.coverage.start();
      const scene = f.image(0, 0, false, (source) => {
        source.__instantTerrain = false;
        source.__instantCoverage = true;
        source.instantCoverageExtraLevels = 1;
        source.tileExists = (_level: number, x: number) => x === 0;
      });
      await vi.waitFor(() => expect(f.coverage.stats.prepared).toBe(2));
      expect(f.coverage.stats.regions).toBe(1);
      const tile = f.cutoff(scene);
      expect(tile.beingDrawn).toBe(true);
      expect(f.requests.every((key) => key.split("/")[4] === "0")).toBe(true);
      f.viewer.world.removeItem(scene);
      expect(
        Object.getOwnPropertyDescriptor(tile, "beingDrawn")?.get,
      ).toBeUndefined();
      const ordinary = f.image(0, 0, true);
      f.viewer.raiseEvent("update-level", { tiledImage: ordinary });
      expect(f.coverage.stats.regions).toBe(1);
    } finally {
      f.close();
    }
  });

  it("counts a scene's full allocated canvas even when its cutoff bounds are tiny", async () => {
    const f = fixture();
    try {
      f.setView(new OSD.Rect(-17920, WORLD_TOP, 35840 * 8, WORLD_HEIGHT * 8));
      const scene = f.image(0, 0, false, (source) => {
        source.__instantTerrain = false;
        source.__instantCoverage = true;
        source.instantCoverageExtraLevels = 0;
        source.instantCoverageTileBytes = () => 512 * 512 * 4;
        source.downloadTileStart = (job: any) => {
          const context = createCanvas(512, 512).getContext("2d");
          queueMicrotask(() => job.finish(context, null, "context2d"));
        };
      });
      f.coverage.start();
      await vi.waitFor(() => expect(f.coverage.stats.prepared).toBe(1));
      expect(f.cutoff(scene).sourceBounds.width).toBe(140);
      expect(f.cutoff(scene).getCache().data.canvas.width).toBe(512);
      expect((f.coverage.stats as any).residency.residentBytes).toBe(
        512 * 512 * 4,
      );
    } finally {
      f.close();
    }
  });

  it("releases the old adaptive plan's residency immediately when the camera moves", async () => {
    const f = fixture();
    try {
      f.setView(new OSD.Rect(-1024, 0, 2048, 1408));
      const item = f.image();
      f.coverage.start();
      await vi.waitFor(() => expect(f.coverage.stats.prepared).toBe(15));
      const tiles: any[] = Object.values(item.tilesMatrix[13]).flatMap(
        (column: any) => Object.values(column),
      );
      expect(tiles).toHaveLength(6);
      for (const tile of tiles) tile.beingDrawn = false;
      expect((f.coverage.stats as any).residency.residentAdaptiveTiles).toBe(6);
      f.viewer.raiseEvent("pan");
      expect((f.coverage.stats as any).residency.residentAdaptiveTiles).toBe(0);
      expect(
        tiles.every(
          (tile) =>
            tile.loaded &&
            !tile.beingDrawn &&
            !Object.getOwnPropertyDescriptor(tile, "beingDrawn")?.get,
        ),
      ).toBe(true);
    } finally {
      f.close();
    }
  });
});
