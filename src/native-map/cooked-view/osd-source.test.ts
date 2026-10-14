// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { CookedMapBuilder, SharedPixelStore } from "../cooked-pixels";
import { createCookedTileSource } from "./osd-source";

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

function fixture() {
  const store = new SharedPixelStore({ pageSize: 8 }),
    region = { horizontal: 0, vertical: 0 };
  const builder = new CookedMapBuilder(store, {
    pageSize: 8,
    regionColumns: 3,
    regionRows: 2,
    regions: [region],
    origin: { x: -17, y: -23 },
  });
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 3; x++)
      builder.put(region, x, y, store.solidPage([40 + x, 60 + y, 80, 255]));
  const map = builder.seal(),
    layer = createCookedTileSource({
      map,
      id: "map/revision:17",
      tileSize: 8,
      overlap: 2,
    });
  const loader = new OSD.ImageLoader({ jobLimit: 3, timeout: 3000 });
  let lastJob: any;
  const start = layer.source.downloadTileStart;
  layer.source.downloadTileStart = (job: any) => {
    lastJob = job;
    start(job);
  };
  const request = (level = map.maxLevel, x = 1, y = 1) => {
    const callback = vi.fn();
    loader.addJob({
      source: layer.source,
      src: layer.source.getTileUrl(level, x, y),
      tile: { level, x, y },
      callback,
    });
    return { callback, job: lastJob };
  };
  return { map, layer, loader, request };
}

describe("completed pixels through installed OpenSeadragon ImageLoader", () => {
  it("delivers exact stored tile rectangles asynchronously with independent OSD-owned canvases", async () => {
    const f = fixture();
    expect([
      f.layer.originX,
      f.layer.originY,
      f.layer.width,
      f.layer.height,
    ]).toEqual([-17, -23, 24, 16]);
    const first = f.request();
    expect(first.callback).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(first.callback).toHaveBeenCalledOnce());
    const context = first.callback.mock.calls[0][0],
      tile = f.layer.service.read({ level: f.map.maxLevel, x: 1, y: 1 });
    expect([context.canvas.width, context.canvas.height]).toEqual([
      tile.width,
      tile.height,
    ]);
    expect(
      Buffer.from(
        context.getImageData(0, 0, tile.width, tile.height).data,
      ).equals(Buffer.from(tile.rgba)),
    ).toBe(true);
    context.canvas.width = 0;
    context.canvas.height = 0;
    const again = f.request();
    await vi.waitFor(() => expect(again.callback).toHaveBeenCalledOnce());
    expect(again.callback.mock.calls[0][0]).not.toBe(context);
    expect(f.loader.jobsInProgress).toBe(0);
    const coarse = f.request(0, 0, 0);
    await vi.waitFor(() => expect(coarse.callback).toHaveBeenCalledOnce());
    expect([
      coarse.callback.mock.calls[0][0].canvas.width,
      coarse.callback.mock.calls[0][0].canvas.height,
    ]).toEqual([1, 1]);
    f.layer.source.destroy();
  });
  it("settles aborted/removed jobs once without late canvas delivery or procedural fallback", async () => {
    const f = fixture(),
      aborted = f.request();
    aborted.job.abort();
    expect(aborted.callback).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(aborted.callback).toHaveBeenCalledOnce();
    expect(f.loader.jobsInProgress).toBe(0);
    const removed = f.request();
    f.layer.source.destroy();
    expect(removed.callback).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(removed.callback).toHaveBeenCalledOnce();
    expect(f.layer.source.tileExists(f.map.maxLevel, 0, 0)).toBe(false);
    expect(f.loader.jobsInProgress).toBe(0);
  });
});
