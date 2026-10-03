// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import Flatbush from "flatbush";
import { createPixelSceneTileSource, type SceneTileItem } from "../src/telescope/pixel-scene-tile-source";

let OSD: any;
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return createCanvas(this.width || 1, this.height || 1).getContext("2d") as any;
  });
  OSD = (await import("openseadragon")).default;
  vi.stubGlobal("OpenSeadragon", OSD);
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((name: string, options?: ElementCreationOptions) =>
    name === "canvas" ? createCanvas(1, 1) : createElement(name, options)) as any);
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const hash = (ctx: any) => createHash("sha256")
  .update(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data).digest("hex");

function fixture(maxCacheBytes?: number, dense = false, timeout = 3000) {
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
      items.push({ osdX: -800 + n % 20, osdY: -350 + n % 40, w: 36, h: 20, sceneKey: "a" });
  }
  const tiling = createPixelSceneTileSource({ items, bitmapByKey, generationId: 42, maxCacheBytes });
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
  return { ...tiling, items, bitmapByKey, loader, request, read };
}

/** Snapshot of the former bridge compositor. Compare actual RGBA output at
 * overview/detail levels, overlapping scenes, alpha holes and translated PW
 * coordinates; no browser or mocked canvas drawing is involved. */
function legacyTile(f: ReturnType<typeof fixture>, level: number, x: number, y: number) {
  const index = new Flatbush(f.items.length);
  let padding = 0;
  for (const i of f.items) {
    index.add(i.osdX - f.originX, i.osdY - f.originY,
      i.osdX + i.w - f.originX, i.osdY + i.h - f.originY);
    padding = Math.max(padding, i.w, i.h);
  }
  index.finish();
  const span = 512 * Math.pow(2, f.source.maxLevel - level), bx = x * span, by = y * span;
  const results = index.search(bx - padding, by - padding, bx + span + padding, by + span + padding);
  const canvas = createCanvas(512, 512), ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  for (const idx of results) {
    const i = f.items[idx], bitmap = f.bitmapByKey.get(i.sceneKey)!;
    const dx = Math.floor((i.osdX - f.originX - bx) * (512 / span));
    const dy = Math.floor((i.osdY - f.originY - by) * (512 / span));
    const dw = Math.ceil(i.w * (512 / span)) + 1, dh = Math.ceil(i.h * (512 / span)) + 1;
    ctx.drawImage(bitmap as any, 0, 0, bitmap.width, bitmap.height, dx, dy, dw, dh);
  }
  return ctx;
}

describe("scene artwork tiles through native canvas and installed OSD loader", () => {
  it("preserves the former compositor's exact pixels across zoom levels and translated scenes", async () => {
    const f = fixture();
    try {
      for (const [level, x, y] of [[9, 0, 0], [10, 0, 0], [10, 1, 0],
        [11, 2, 0], [12, 0, 0], [12, 1, 0], [13, 0, 0], [13, 1, 0], [13, 10, 3]]) {
        expect(hash(await f.read(level, x, y))).toBe(hash(legacyTile(f, level, x, y)));
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
      expect(hash(second.callback.mock.calls[0][0])).toBe(hash(legacyTile(f, 13, 0, 0)));
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
      expect(hash(pending.callback.mock.calls[0][0])).toBe(hash(legacyTile(f, 9, 0, 0)));
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
