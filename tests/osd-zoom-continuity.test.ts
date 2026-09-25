// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  PIXEL_MAP_DRAW_OPTIONS,
  smoothInstantTile,
} from "../src/osd-pixel-rendering";
import { protectTileContinuity } from "../src/osd-tile-continuity";

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

const FINE = [240, 128, 32, 255],
  COARSE = [32, 96, 160, 255],
  BACKGROUND = [24, 24, 24, 255];
let serial = 0;

/** The actual installed OSD source/loader/cache/LOD/drawer process a camera
 * transition. Only I/O after priming is held, keeping lower levels unavailable.
 * Colored tiles distinguish fine data, coarse coverage, and underlying artwork.
 */
function fixture(kind: "dzi" | "hd") {
  let currentScale = 1,
    targetScale = 1,
    hold = false;
  const viewer = new OSD.EventSource(),
    items: any[] = [];
  viewer.world = new OSD.EventSource();
  viewer.world.getItemAt = (index: number) => items[index];
  viewer.world.getItemCount = () => items.length;
  viewer.world.requestTileInvalidateEvent = async () => {};
  viewer.world.ensureTilesUpToDate = () => {};
  viewer.isDestroyed = () => false;
  viewer.isAnimating = () => currentScale !== targetScale;
  viewer.forceRedraw = vi.fn();
  viewer.tileRetryMax = 0;
  viewer.tileCache = new OSD.TileCache({ maxImageCacheCount: 200 });
  const loader = new OSD.ImageLoader({ jobLimit: 0 });
  const scale = (current: boolean) => (current ? currentScale : targetScale);
  const bounds = (current: boolean) =>
    new OSD.Rect(0, 0, 256 / scale(current), 256 / scale(current));
  const viewport = {
    _containerInnerSize: new OSD.Point(256, 256),
    getBounds: bounds,
    getBoundsWithMargins: bounds,
    getCenter: (current: boolean) => bounds(current).getCenter(),
    pixelFromPoint: (point: any, current: boolean) =>
      point.times(scale(current)),
    pixelFromPointNoRotate: (point: any, current: boolean) =>
      point.times(scale(current)),
    deltaPixelsFromPointsNoRotate: (point: any, current: boolean) =>
      point.times(scale(current)),
    viewportToViewerElementRectangle: (rect: any) => rect.times(currentScale),
    getRotation: () => 0,
    getFlip: () => false,
    getZoom: () => currentScale,
    getContainerSize: () => new OSD.Point(256, 256),
  };
  viewer.viewport = viewport;
  viewer.addHandler("tile-drawing", smoothInstantTile);
  const drawerContract = {
    minimumOverlapRequired: () => false,
    getSupportedDataFormats: () => ["context2d"],
    options: { usePrivateCache: false },
  };
  const requested: any[] = [];
  function image(background = false) {
    const id = ++serial;
    const options = {
      width: background ? 1 : 4096,
      height: background ? 1 : 4096,
      tileSize: background ? 1 : 256,
      minLevel: 0,
      maxLevel: background ? 0 : 12,
      tileOverlap: !background && kind === "dzi" ? 1 : 0,
      tilesUrl: `native-dzi://${id}/`,
      fileFormat: "png",
    };
    const source =
      !background && kind === "dzi"
        ? new OSD.DziTileSource(options)
        : new OSD.TileSource(options);
    source.__instantTerrain = !background && kind === "hd";
    source.getTileUrl = (level: number, x: number, y: number) =>
      `zoom://${id}/${level}/${x}/${y}`;
    source.hasTransparency = () => !background;
    source.downloadTileStart = (job: any) => {
      const { level, x, y } = job.tile;
      const size = source.getTileBounds(level, x, y, true);
      const canvas = createCanvas(size.width, size.height),
        context = canvas.getContext("2d");
      const color = background
        ? BACKGROUND
        : level === source.maxLevel
          ? FINE
          : COARSE;
      context.fillStyle = `rgb(${color.slice(0, 3).join(",")})`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (!background) {
        const world = source.getTileBounds(level, x, y),
          factor = source.getLevelScale(level);
        context.clearRect(
          (64 - world.x * source.width) * factor,
          (64 - world.y * source.width) * factor,
          64 * factor,
          64 * factor,
        );
      }
      queueMicrotask(() => job.finish(context, null, "context2d"));
    };
    const item = new OSD.TiledImage({
      source,
      viewer,
      viewport,
      tileCache: viewer.tileCache,
      drawer: drawerContract,
      imageLoader: loader,
      width: 4096,
      ...PIXEL_MAP_DRAW_OPTIONS,
      maxTilesPerFrame: 1,
      discardLevelsBelowDownsampleRatio: 1,
      smoothTileEdgesMinZoom: Infinity,
      ajaxHeaders: {},
    });
    item.getDrawer = () => drawerContract;
    const load = item._loadTile.bind(item);
    item._loadTile = (tile: any, now: number) => {
      if (hold) {
        requested.push(tile);
        tile.loading = true;
      } else load(tile, now);
    };
    items.push(item);
    return item;
  }
  const background = image(true),
    item = image();
  async function load(item: any, level: number, x = 0, y = 0) {
    const tile = item._getTile(
      x,
      y,
      level,
      OSD.now(),
      item.source.getNumTiles(level),
    );
    const wasHeld = hold;
    hold = false;
    item._loadTile(tile, OSD.now());
    hold = wasHeld;
    await vi.waitFor(() => expect(tile.loaded).toBe(true));
    return tile;
  }
  function draw() {
    for (const image of items) image._updateLevelsForViewport();
    const canvas = createCanvas(256, 256),
      sketch = createCanvas(256, 256),
      drawer = Object.create(OSD.CanvasDrawer.prototype);
    Object.assign(drawer, {
      _renderingTarget: canvas,
      context: canvas.getContext("2d"),
      sketchCanvas: sketch,
      sketchContext: sketch.getContext("2d"),
      viewport,
      viewer,
      _imageSmoothingEnabled: false,
      getDataToDraw: (tile: any) => tile.getCache().data,
    });
    drawer._updateImageSmoothingEnabled(drawer.context);
    drawer._updateImageSmoothingEnabled(drawer.sketchContext);
    drawer.draw(items);
    return canvas.getContext("2d");
  }
  return {
    viewer,
    item,
    background,
    load,
    draw,
    requested,
    hold: () => {
      hold = true;
    },
    zoom: (current: number, target = current) => {
      currentScale = current;
      targetScale = target;
    },
    close: () => {
      viewer.tileCache.clear();
    },
  };
}
const pixel = (context: any, x: number, y: number) => [
  ...context.getImageData(x, y, 1, 1).data,
];

describe("actual detail-to-overview camera transitions", () => {
  it.each(["dzi", "hd"] as const)(
    "reproduces cached fine %s pixels disappearing below OSD's downsample threshold",
    async (kind) => {
      const f = fixture(kind);
      try {
        await f.load(f.background, 0);
        await f.load(f.item, 8);
        const fine = await f.load(f.item, 12);
        f.hold();
        const close = f.draw();
        expect(pixel(close, 32, 32)).toEqual(FINE);
        expect(pixel(close, 96, 96)).toEqual(BACKGROUND);
        f.zoom(0.25);
        const far = f.draw();
        expect(fine.loaded).toBe(true);
        expect(pixel(far, 8, 8)).toEqual(COARSE);
        expect(pixel(far, 24, 24)).toEqual(BACKGROUND);
        expect(f.requested.some((tile) => tile.level === 10)).toBe(true);
      } finally {
        f.close();
      }
    },
  );

  it.each([
    ["dzi", true],
    ["hd", true],
    ["dzi", false],
    ["hd", false],
  ] as const)(
    "retains fine %s pixels through repeated zoom-out while replacement loads (coarse ready=%s)",
    async (kind, coarseReady) => {
      const f = fixture(kind),
        stop = protectTileContinuity(f.item);
      try {
        await f.load(f.background, 0);
        if (coarseReady) await f.load(f.item, 8);
        const fine = await f.load(f.item, 12);
        f.hold();
        expect(pixel(f.draw(), 32, 32)).toEqual(FINE);
        const expectedOutside = coarseReady ? COARSE : BACKGROUND;
        // Change both the destination and the actual camera, not only which
        // tile happens to be cached. Repeated draws must preserve sharp content.
        for (const [current, target] of [
          [1, 0.25],
          [0.25, 0.25],
          [0.25, 0.125],
          [0.125, 0.125],
          [0.125, 0.125],
        ]) {
          f.zoom(current, target);
          const output = f.draw();
          expect(fine.loaded).toBe(true);
          expect(pixel(output, 32 * current, 32 * current)).toEqual(FINE);
          expect(pixel(output, 96 * current, 96 * current)).toEqual(BACKGROUND);
          // Fine imagery covers only its original world footprint. New areas
          // retain their baseline, instead of stretching old pixels across them.
          if (current < 1)
            expect(pixel(output, 180, 180)).toEqual(expectedOutside);
        }
        expect(f.requested.some((tile) => tile.level === 10)).toBe(true);
        expect(f.requested.some((tile) => tile.level === 9)).toBe(true);
        // Real loader completion replaces retained old detail once the current
        // lower level is ready. Its alpha hole still reveals the static layer.
        await f.load(f.item, 9);
        const replaced = f.draw();
        expect(pixel(replaced, 4, 4)).toEqual(COARSE);
        expect(pixel(replaced, 12, 12)).toEqual(BACKGROUND);
        expect(f.item._lastDrawn.some((info: any) => info.tile === fine)).toBe(
          false,
        );
      } finally {
        stop();
        f.close();
      }
    },
  );
});
