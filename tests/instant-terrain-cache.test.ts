import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import {
  copyTerrainContext,
  InstantTerrainCache,
} from "../src/telescope/instant-terrain-cache";

const tileBytes = 4 * 4 * 4;
const pixels = (context: CanvasRenderingContext2D) => [
  ...context.getImageData(0, 0, context.canvas.width, context.canvas.height)
    .data,
];
function tile(
  color = "#fc8000",
  width = 4,
  height = 4,
): CanvasRenderingContext2D {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return context as unknown as CanvasRenderingContext2D;
}

beforeEach(() =>
  vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) }),
);
afterEach(() => vi.unstubAllGlobals());

describe("completed terrain cache (native canvas, no browser)", () => {
  it("copies exact pixels independently of source state and caller mutation", () => {
    const source = tile("#4080c080");
    source.fillStyle = "red";
    source.globalAlpha = 0.25;
    source.translate(2, 3);
    const expected = pixels(source);
    const copy = copyTerrainContext(source);
    expect(copy.canvas).not.toBe(source.canvas);
    expect(pixels(copy)).toEqual(expected);
    expect(copy.imageSmoothingEnabled).toBe(false);
    source.canvas.width = 1;
    expect(copy.canvas.width).toBe(4);
    expect(pixels(copy)).toEqual(expected);
  });

  it("protects stored pixels from both the input owner and every OSD consumer", () => {
    const cache = new InstantTerrainCache(tileBytes * 2),
      source = tile();
    const expected = pixels(source);
    expect(cache.set("main/8/0/0", source)).toBe(true);
    source.clearRect(0, 0, 4, 4);
    const first = cache.get("main/8/0/0")!;
    expect(pixels(first)).toEqual(expected);
    first.canvas.width = first.canvas.height = 1;
    const second = cache.get("main/8/0/0")!;
    expect(second.canvas).not.toBe(first.canvas);
    expect(pixels(second)).toEqual(expected);
    cache.clear();
    expect(pixels(second)).toEqual(expected);
    expect(source.canvas.width).toBe(4);
    expect(cache.stats).toMatchObject({
      entries: 0,
      bytes: 0,
      hits: 2,
      pinned: 0,
    });
  });

  it("evicts the least recently used tile across sources within the exact byte budget", () => {
    const cache = new InstantTerrainCache(tileBytes * 2);
    const source = tile();
    cache.set("main/12/0/0", source);
    cache.set("east/12/0/0", source);
    expect(cache.get("main/12/0/0")).toBeDefined();
    cache.set("west/12/0/0", source);
    expect(cache.get("east/12/0/0")).toBeUndefined();
    expect(cache.get("main/12/0/0")).toBeDefined();
    expect(cache.get("west/12/0/0")).toBeDefined();
    expect(cache.stats).toMatchObject({
      entries: 2,
      bytes: tileBytes * 2,
      hits: 3,
      misses: 1,
      evictions: 1,
    });
    cache.clear();
  });

  it("retains coarse pinned tiles before detail while keeping pins inside the same hard limit", () => {
    const cache = new InstantTerrainCache(tileBytes * 2),
      source = tile();
    cache.set("overview", source, true);
    cache.set("detail-a", source);
    cache.set("detail-b", source);
    expect(cache.get("overview")).toBeDefined();
    expect(cache.get("detail-a")).toBeUndefined();
    expect(cache.stats.pinned).toBe(1);
    cache.set("other-overview", source, true);
    expect(cache.set("detail-c", source)).toBe(false);
    expect(cache.get("detail-c")).toBeUndefined();
    expect(cache.stats).toMatchObject({ bytes: tileBytes * 2, pinned: 2 });
    cache.set("third-overview", source, true);
    expect(cache.get("overview")).toBeUndefined();
    expect(cache.stats).toMatchObject({
      entries: 2,
      bytes: tileBytes * 2,
      pinned: 2,
    });
    cache.clear();
  });

  it("checks readiness without copying pixels or changing eviction order", () => {
    const cache = new InstantTerrainCache(tileBytes * 2), source = tile();
    cache.set("old", source);
    cache.set("recent", source);
    const allocation = vi.spyOn(document, "createElement");
    const before = { ...cache.stats };
    expect(cache.has("old")).toBe(true);
    expect(cache.has("missing")).toBe(false);
    expect(allocation).not.toHaveBeenCalled();
    expect(cache.stats).toEqual(before);
    cache.set("new", source);
    expect(cache.has("old")).toBe(false);
    expect(cache.has("recent")).toBe(true);
    cache.clear();
    expect(cache.has("recent")).toBe(false);
    allocation.mockRestore();
  });

  it("replaces entries with correct accounting without destroying input or returned canvases", () => {
    const cache = new InstantTerrainCache(tileBytes * 2),
      original = tile("red");
    cache.set("same", original, true);
    const previousHit = cache.get("same")!;
    const replacement = tile("blue", 2, 4),
      expected = pixels(replacement);
    cache.set("same", replacement);
    expect(cache.stats).toMatchObject({
      entries: 1,
      bytes: 32,
      pinned: 0,
      evictions: 0,
    });
    expect(pixels(cache.get("same")!)).toEqual(expected);
    expect(pixels(previousHit)).toEqual(pixels(original));
    cache.clear();
    cache.clear();
    expect(pixels(replacement)).toEqual(expected);
    expect(cache.get("same")).toBeUndefined();
  });

  it("rejects oversized entries and a disabled cache without touching their source buffers", () => {
    const source = tile(),
      expected = pixels(source);
    for (const budget of [0, tileBytes - 1]) {
      const cache = new InstantTerrainCache(budget);
      expect(cache.set("large", source, true)).toBe(false);
      expect(cache.stats).toMatchObject({ entries: 0, bytes: 0, pinned: 0 });
      expect(pixels(source)).toEqual(expected);
    }
    expect(new InstantTerrainCache().stats.maxBytes).toBe(32 * 1024 * 1024);
    for (const budget of [-1, Infinity, NaN, 1.5])
      expect(() => new InstantTerrainCache(budget)).toThrow(RangeError);
  });

  it("resets only owned canvas buffers on eviction and clear", () => {
    const created: Canvas[] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = createCanvas(1, 1);
        created.push(canvas);
        return canvas;
      },
    });
    const cache = new InstantTerrainCache(tileBytes),
      source = tile();
    cache.set("old", source);
    const oldWidth = vi.spyOn(created[0], "width", "set");
    const oldHeight = vi.spyOn(created[0], "height", "set");
    const returned = cache.get("old")!;
    cache.set("new", source);
    expect(oldWidth).toHaveBeenLastCalledWith(0);
    expect(oldHeight).toHaveBeenLastCalledWith(0);
    const newWidth = vi.spyOn(created[2], "width", "set");
    const newHeight = vi.spyOn(created[2], "height", "set");
    cache.clear();
    expect(newWidth).toHaveBeenLastCalledWith(0);
    expect(newHeight).toHaveBeenLastCalledWith(0);
    expect(source.canvas.width).toBe(4);
    expect(returned.canvas.width).toBe(4);
    expect(pixels(returned)).toEqual(pixels(source));
    expect(cache.stats.bytes).toBe(0);
  });
});
