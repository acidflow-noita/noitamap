// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Blob as NativeBlob } from "node:buffer";
import { createHash } from "node:crypto";
import { createPixelSceneTileSource, type SceneTileItem } from "../src/telescope/pixel-scene-tile-source";

let OSD: any;
const allocatedCanvases: any[] = [];
const canvasWidthSetters = new WeakMap<object, ReturnType<typeof vi.spyOn>>();
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return createCanvas(this.width || 1, this.height || 1).getContext("2d") as any;
  });
  OSD = (await import("openseadragon")).default;
  vi.stubGlobal("OpenSeadragon", OSD);
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((name: string, options?: ElementCreationOptions) =>
    name === "canvas" ? (() => { const canvas = createCanvas(1, 1); allocatedCanvases.push(canvas); canvasWidthSetters.set(canvas, vi.spyOn(canvas, "width", "set")); return canvas; })() : createElement(name, options)) as any);
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const hash = (ctx: any) => createHash("sha256")
  .update(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data).digest("hex");

function fixture(maxCacheBytes?: number, dense = false, timeout = 3000, compressed = false, lazy = false) {
  const bitmapByKey = new Map<string, ImageBitmap>();
  for (const [key, color] of [["a", "#da701b"], ["b", "#248ac780"]]) {
    const image = createCanvas(36, 20) as any, ctx = image.getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 36, 20);
    ctx.clearRect(7, 5, 9, 8);
    image.close = vi.fn();
    bitmapByKey.set(key, image);
  }
  const items: SceneTileItem[] = [
    { osdX: -900, osdY: -400, w: 360, h: 200, sceneKey: "a" },
    { osdX: -580, osdY: -330, w: 144, h: 80, sceneKey: "b" },
    { osdX: 490, osdY: 375, w: 72, h: 40, sceneKey: "a" },
    { osdX: 4200, osdY: 1450, w: 144, h: 80, sceneKey: "b" },
  ];
  if (dense) {
    for (let n = 0; n < 2000; n++)
      items.push({ osdX: -800 + n % 20, osdY: -350 + n % 40, w: 36, h: 20, sceneKey: n % 2 ? "b" : "a" });
  }
  const blobByKey = compressed || lazy ? new Map([...bitmapByKey].map(([key, bitmap]) => [key, {
    blob: new NativeBlob([new Uint8Array((bitmap as any).toBuffer('image/png'))]) as Blob,
    width: bitmap.width, height: bitmap.height,
  }])) : undefined;
  const loadBitmap = lazy ? vi.fn(async (key: string) => blobByKey?.get(key)) : undefined;
  const disposeBitmaps = lazy ? vi.fn() : undefined;
  const tiling = createPixelSceneTileSource({ items, bitmapByKey: compressed || lazy ? new Map() : bitmapByKey,
    blobByKey: lazy ? new Map() : blobByKey, loadBitmap, disposeBitmaps,
    generationId: 42, maxCacheBytes, maxBitmapBytes: 8192, directViewport: false });
  const { source } = tiling;
  const loader = new OSD.ImageLoader({ jobLimit: 8, timeout });
  let lastJob: any;
  const start = source.downloadTileStart;
  source.downloadTileStart = (job: any) => { lastJob = job; start(job); };
  function request(level: number, x = 0, y = 0) {
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    const callback = vi.fn((..._args: any[]) => resolve());
    loader.addJob({ source, src: source.getTileUrl(level, x, y), tile: { level, x, y }, callback });
    return { callback, job: lastJob, done };
  }
  async function read(level: number, x = 0, y = 0) {
    const req = request(level, x, y);
    await req.done;
    expect(req.callback).toHaveBeenCalledOnce();
    expect(req.callback.mock.calls[0][1]).toBeNull();
    return req.callback.mock.calls[0][0];
  }
  return { ...tiling, items, bitmapByKey, loader, request, read, loadBitmap, disposeBitmaps };
}

/** Render the original scene artwork at its world transform, independently
 * of tile rectangle rounding/cropping. Every LOD must retain this registration
 * with terrain masks and preserve the original scene paint order. */
function referenceTile(f: ReturnType<typeof fixture>, level: number, x: number, y: number) {
  const span = 512 * Math.pow(2, f.source.maxLevel - level), bx = x * span, by = y * span;
  const canvas = createCanvas(512, 512), ctx = canvas.getContext("2d");
  const scale = 512 / span;
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(scale, 0, 0, scale, -bx * scale, -by * scale);
  for (const item of f.items) {
    const bitmap = f.bitmapByKey.get(item.sceneKey)!;
    ctx.drawImage(bitmap as any, 0, 0, bitmap.width, bitmap.height,
      item.osdX - f.originX, item.osdY - f.originY, item.w, item.h);
  }
  return ctx;
}

describe("scene artwork tiles through native canvas and installed OSD loader", () => {
  it('indexes every placement before native artwork loads, then paints exact asynchronous tiles', async () => {
    vi.stubGlobal('createImageBitmap', async (blob: Blob, sx: number, sy: number, sw: number, sh: number, options: ImageBitmapOptions) => {
      const image = await loadImage(Buffer.from(await blob.arrayBuffer()));
      const bitmap = createCanvas(options.resizeWidth!, options.resizeHeight!) as any;
      const context = bitmap.getContext('2d'); context.imageSmoothingEnabled = false;
      context.drawImage(image, sx, sy, sw, sh, 0, 0, bitmap.width, bitmap.height);
      bitmap.close = vi.fn(); return bitmap;
    });
    const f = fixture(undefined, false, 3000, false, true);
    try {
      expect(f.loadBitmap).not.toHaveBeenCalled();
      expect(f.source.__viewportReady).toBeUndefined();
      expect(f.source.tileExists(13, 0, 0)).toBe(true);
      expect(f.source.sceneTileStats.bitmapCache.loadedScenes).toBe(0);
      for (const [level, x, y] of [[13, 0, 0], [13, 10, 3], [11, 2, 0], [13, 0, 0]])
        expect(hash(await f.read(level, x, y))).toBe(hash(referenceTile(f, level, x, y)));
      expect(f.loadBitmap).toHaveBeenCalledTimes(2);
      expect(f.source.sceneTileStats.bitmapCache).toMatchObject({ loadedScenes: 2, loads: 2, loading: 0 });
      f.disposeBitmaps!.mockImplementation(() => {
        // The owning renderer retires before provider cleanup clears its PNGs.
        expect(f.source.sceneTileStats.bitmapCache.loadedScenes).toBe(2);
      });
    } finally { f.source.destroy(); }
    f.source.destroy();
    expect(f.disposeBitmaps).toHaveBeenCalledOnce();
    expect(f.source.sceneTileStats.bitmapCache.loadedScenes).toBe(0);
  });
  it("keeps complete coarse coverage while compact compressed detail is evicted and decoded again", async () => {
    vi.stubGlobal('createImageBitmap', async (blob: Blob, sx: number, sy: number, sw: number, sh: number, options: ImageBitmapOptions) => {
      const image = await loadImage(Buffer.from(await blob.arrayBuffer()));
      const bitmap = createCanvas(options.resizeWidth!, options.resizeHeight!) as any;
      const context = bitmap.getContext('2d'); context.imageSmoothingEnabled = false;
      context.drawImage(image, sx, sy, sw, sh, 0, 0, bitmap.width, bitmap.height);
      bitmap.close = vi.fn(); return bitmap;
    });
    const f = fixture(3 * 512 * 512 * 4, false, 3000, true);
    try {
      expect(f.source.__viewportReady).toBeUndefined();
      const cutoff = f.source.getClosestLevel();
      const first = hash(await f.read(cutoff)), second = hash(await f.read(cutoff + 1));
      for (const [level, x, y] of [[13, 0, 0], [13, 1, 0], [13, 10, 3], [11, 2, 0], [12, 1, 0], [13, 0, 0]]) {
        expect(hash(await f.read(level, x, y))).toBe(hash(referenceTile(f, level, x, y)));
        expect(f.source.sceneTileStats.bitmapCache.bytes).toBeLessThanOrEqual(8192);
      }
      const rendered = f.source.sceneTileStats.rendered;
      expect(hash(await f.read(cutoff))).toBe(first);
      expect(hash(await f.read(cutoff + 1))).toBe(second);
      expect(f.source.sceneTileStats.rendered).toBe(rendered);
      expect(f.source.sceneTileStats.pinned).toBe(2);
    } finally { f.source.destroy(); }
    expect(f.source.sceneTileStats.bitmapCache.bytes).toBe(0);
  });

  it("releases each temporary compositor after duplicate subscribers have copied it", async () => {
    const f = fixture(), start = allocatedCanvases.length;
    try {
      const a = f.request(13), b = f.request(13);
      await Promise.all([a.done, b.done]);
      const [temporary, cached, first, second] = allocatedCanvases.slice(start);
      expect(allocatedCanvases.length - start).toBe(4);
      expect(canvasWidthSetters.get(temporary)).toHaveBeenLastCalledWith(0);
      expect([cached.width, first.width, second.width]).toEqual([512, 512, 512]);
      expect(hash(first.getContext('2d'))).toBe(hash(second.getContext('2d')));
      expect(hash(first.getContext('2d'))).toBe(hash(referenceTile(f, 13, 0, 0)));
      f.source.destroy();
      expect(canvasWidthSetters.get(cached)).toHaveBeenLastCalledWith(0);
      expect([first.width, second.width]).toEqual([512, 512]);
    } finally { f.source.destroy(); }
  });

  it("keeps authored artwork aligned to terrain through zoom levels and translated scenes", async () => {
    const f = fixture();
    try {
      for (const [level, x, y] of [[9, 0, 0], [10, 0, 0], [10, 1, 0],
        [11, 2, 0], [12, 0, 0], [12, 1, 0], [13, 0, 0], [13, 1, 0], [13, 10, 3]]) {
        expect(hash(await f.read(level, x, y))).toBe(hash(referenceTile(f, level, x, y)));
      }
      expect(f.loader.jobsInProgress).toBe(0);
      expect(f.source.__instantTerrain).toBeUndefined();
      expect(f.source.__instantCoverage).toBe(true);
      expect(f.source.instantCoverageExtraLevels).toBe(1);
      expect(f.source.instantCoverageTileBytes(9, 0, 0)).toBe(512 * 512 * 4);
      expect((await f.read(9)).canvas.width).toBe(512);
    } finally { f.source.destroy(); }
  });

  it("replays completed zoom tiles without scene redraws after OSD destroys its canvas", async () => {
    const f = fixture();
    try {
      const first = await f.read(13), expected = hash(first);
      first.canvas.width = first.canvas.height = 1;
      for (let i = 0; i < 12; i++) {
        const replay = await f.read(13);
        expect(hash(replay)).toBe(expected);
        replay.canvas.width = replay.canvas.height = 1;
      }
      expect(f.source.sceneTileStats).toMatchObject({ rendered: 1, hits: 12, entries: 1 });
    } finally { f.source.destroy(); }
  });

  it("retains two coarse levels through bounded detail eviction", async () => {
    const f = fixture(3 * 512 * 512 * 4);
    try {
      const cutoff = f.source.getClosestLevel();
      await f.read(cutoff);
      await f.read(cutoff + 1);
      for (let x = 0; x < 11; x++) await f.read(13, x);
      expect(f.source.sceneTileStats).toMatchObject({ entries: 3, pinned: 2 });
      expect(f.source.sceneTileStats.bytes).toBeLessThanOrEqual(3 * 512 * 512 * 4);
      const rendered = f.source.sceneTileStats.rendered;
      await f.read(cutoff);
      await f.read(cutoff + 1);
      expect(f.source.sceneTileStats.rendered).toBe(rendered);
    } finally { f.source.destroy(); }
  });

  it("settles one aborted duplicate exactly once while the other consumer succeeds", async () => {
    const f = fixture();
    try {
      const first = f.request(13), second = f.request(13);
      first.job.abort();
      await second.done;
      expect(first.callback).toHaveBeenCalledOnce();
      expect(first.callback.mock.calls[0][1]).toContain("aborted");
      expect(second.callback).toHaveBeenCalledOnce();
      expect(second.callback.mock.calls[0][1]).toBeNull();
      expect(hash(second.callback.mock.calls[0][0])).toBe(hash(referenceTile(f, 13, 0, 0)));
      expect(f.loader.jobsInProgress).toBe(0);
      expect(f.source.sceneTileStats).toMatchObject({ rendered: 1, hits: 0 });
    } finally { f.source.destroy(); }
  });

  it("releases owned bitmaps/cache on removal while previously delivered pixels survive", async () => {
    const f = fixture(), bitmaps = [...f.bitmapByKey.values()];
    const ready = await f.read(13), expected = hash(ready);
    const pending = f.request(12);
    f.source.destroy();
    f.source.destroy();
    await Promise.resolve();
    expect(pending.callback).toHaveBeenCalledOnce();
    expect(pending.callback.mock.calls[0][1]).toBe("Scene layer removed");
    expect(f.loader.jobsInProgress).toBe(0);
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledOnce();
    expect(f.bitmapByKey.size).toBe(0);
    expect(f.source.sceneTileStats).toMatchObject({ bytes: 0, entries: 0 });
    expect(hash(ready)).toBe(expected);
    expect(f.source.tileExists(13, 0, 0)).toBe(false);
  });

  it("yields between dense scene batches, preserving pixels while letting camera work run", async () => {
    const f = fixture(undefined, true);
    try {
      const pending = f.request(9);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(f.source.sceneTileStats.rendered).toBe(0);
      expect(pending.callback).not.toHaveBeenCalled();
      await pending.done;
      expect(hash(pending.callback.mock.calls[0][0])).toBe(hash(referenceTile(f, 9, 0, 0)));
      expect(f.source.sceneTileStats.chunks).toBeGreaterThanOrEqual(16);
      expect(f.source.sceneTileStats.rendered).toBe(1);
    } finally { f.source.destroy(); }
  });

  it("retires a real OSD timeout during yielded compositing without late completion or cache writes", async () => {
    const f = fixture(undefined, true, 1);
    try {
      const pending = f.request(9);
      await pending.done;
      expect(pending.callback.mock.calls[0][1]).toContain("timeout");
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      expect(pending.callback).toHaveBeenCalledOnce();
      expect(f.loader.jobsInProgress).toBe(0);
      expect(f.source.sceneTileStats).toMatchObject({ rendered: 0, entries: 0 });
    } finally { f.source.destroy(); }
  });
});
