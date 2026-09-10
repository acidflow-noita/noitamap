import { describe, expect, it } from "vitest";
import { PixelPyramid, type PyramidTile } from "../src/telescope/pixel-pyramid";

type Image = { width: number; height: number; pixels: number[] };
function fixture(width = 8, height = 8, maxCachedTiles = 32) {
  const rendered: number[] = [];
  const levels: number[] = [];
  const create = (tile: PyramidTile): Image => ({
    ...tile,
    pixels: Array(tile.width * tile.height).fill(0),
  });
  const pyramid = new PixelPyramid<Image>({
    width,
    height,
    tileSize: 2,
    maxCachedTiles,
    create,
    async renderLeaf(tile) {
      levels.push(tile.level);
      const out = create(tile);
      for (let y = 0; y < tile.height; y++)
        for (let x = 0; x < tile.width; x++) {
          const value = (tile.y * 2 + y) * width + tile.x * 2 + x + 1;
          out.pixels[y * tile.width + x] = value;
          rendered.push(value);
        }
      return out;
    },
    reduceChild(parent, child, dx, dy) {
      for (let y = 0; y < Math.ceil(child.height / 2); y++)
        for (let x = 0; x < Math.ceil(child.width / 2); x++) {
          parent.pixels[(dy + y) * parent.width + dx + x] = 0;
        }
      for (let y = 0; y < child.height; y++)
        for (let x = 0; x < child.width; x++) {
          const px = dx + Math.floor(x / 2),
            py = dy + Math.floor(y / 2);
          parent.pixels[py * parent.width + px] +=
            child.pixels[y * child.width + x] / 4;
        }
    },
  });
  return { pyramid, rendered, levels };
}
const signal = () => new AbortController().signal;

describe("full-pixel pyramid", () => {
  it("includes every source pixel even at the furthest zoom", async () => {
    const { pyramid, rendered, levels } = fixture();
    const root = await pyramid.get(0, 0, 0, signal());
    expect(root.pixels).toEqual([32.5]);
    expect(rendered.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 64 }, (_, i) => i + 1),
    );
    expect(new Set(levels)).toEqual(new Set([pyramid.maxLevel]));
  });

  it("includes odd right/bottom edges without stretching them", async () => {
    const { pyramid, rendered } = fixture(7, 5);
    expect(pyramid.tile(pyramid.maxLevel, 3, 2)).toMatchObject({
      width: 1,
      height: 1,
    });
    const root = await pyramid.get(0, 0, 0, signal());
    expect(root.pixels[0]).toBe((35 * 36) / 2 / 64);
    expect(rendered).toHaveLength(35);
    expect(rendered).toContain(35);
  });

  it("reuses derived pixels and reproduces them after cache eviction", async () => {
    const { pyramid, rendered } = fixture(8, 8, 1);
    const root = await pyramid.get(0, 0, 0, signal());
    await pyramid.get(0, 0, 0, signal());
    expect(rendered).toHaveLength(64);
    await pyramid.get(pyramid.maxLevel, 0, 0, signal());
    expect((await pyramid.get(0, 0, 0, signal())).pixels).toEqual(root.pixels);
  });

  it("cancels obsolete requests without caching partial results", async () => {
    const { pyramid, rendered } = fixture();
    const controller = new AbortController();
    const pending = pyramid.get(0, 0, 0, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(rendered.length).toBeLessThan(64);
    expect((await pyramid.get(0, 0, 0, signal())).pixels).toEqual([32.5]);
  });

  it("rejects invalid dimensions and out-of-range tiles", async () => {
    expect(() => fixture(0, 3)).toThrow("positive integers");
    const { pyramid } = fixture();
    expect(pyramid.tile(-1, 0, 0)).toBeNull();
    expect(pyramid.tile(2, 0.5, 0)).toBeNull();
    await expect(pyramid.get(0, 1, 0, signal())).rejects.toThrow(
      "outside pyramid",
    );
  });
  it("publishes completed pixels before the whole parent finishes", async () => {
    let renders = 0,
      firstProgress = 0;
    const pyramid = new PixelPyramid<Image>({
      width: 32,
      height: 32,
      tileSize: 2,
      create: (t) => ({ ...t, pixels: Array(t.width * t.height).fill(0) }),
      renderLeaf: async (t) => {
        renders++;
        return { ...t, pixels: Array(t.width * t.height).fill(1) };
      },
      reduceChild: (parent, child, x, y) => {
        parent.pixels[y * parent.width + x] = child.pixels[0];
      },
    });
    await pyramid.get(0, 0, 0, signal(), () => {
      firstProgress ||= renders;
    });
    expect(firstProgress).toBe(1);
    expect(renders).toBe(256);
  });
  it("reuses persisted completed pixels without publishing a coarse preview or regenerating", async () => {
    let renders = 0,
      previews = 0;
    const store = new Map<string, Image>();
    const build = () =>
      new PixelPyramid<Image>({
        width: 4,
        height: 4,
        tileSize: 2,
        maxCachedTiles: 1,
        create: (t) => ({ ...t, pixels: Array(t.width * t.height).fill(0) }),
        renderLeaf: async (t) => {
          renders++;
          return { ...t, pixels: Array(t.width * t.height).fill(19) };
        },
        reduceChild: (parent, child, x, y) => {
          parent.pixels[y * parent.width + x] = child.pixels[0];
        },
        readTile: async (t) => store.get(`${t.level}/${t.x}/${t.y}`) ?? null,
        writeTile: async (t, image) => {
          store.set(`${t.level}/${t.x}/${t.y}`, image);
        },
        onMissing: () => previews++,
      });
    const first = build();
    const image = await first.get(0, 0, 0, signal());
    const before = { renders, previews };
    const reloaded = build();
    expect(await reloaded.get(0, 0, 0, signal())).toEqual(image);
    expect({ renders, previews }).toEqual(before);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++)
        await reloaded.get(reloaded.maxLevel, x, y, signal());
    expect({ renders, previews }).toEqual(before);
    expect(reloaded.cachedTiles()).toHaveLength(1);
  });
});

it("coalesces overlapping overview/detail requests before they enter the renderer", async () => {
  let calls = 0,
    release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  const pyramid = new PixelPyramid<number>({
    width: 2,
    height: 2,
    tileSize: 2,
    create: () => 0,
    renderLeaf: async () => {
      calls++;
      await barrier;
      return 17;
    },
    reduceChild() {},
  });
  const a = pyramid.get(1, 0, 0, new AbortController().signal),
    b = pyramid.get(1, 0, 0, new AbortController().signal);
  await Promise.resolve();
  expect(calls).toBe(1);
  release();
  expect(await Promise.all([a, b])).toEqual([17, 17]);
});
it("does not cancel a shared leaf that another viewport request still needs", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  const pyramid = new PixelPyramid<number>({
    width: 2,
    height: 2,
    tileSize: 2,
    create: () => 0,
    renderLeaf: async (_, signal) => {
      await barrier;
      signal.throwIfAborted();
      return 17;
    },
    reduceChild() {},
  });
  const a = new AbortController(),
    b = new AbortController();
  const p = pyramid.get(1, 0, 0, a.signal),
    q = pyramid.get(1, 0, 0, b.signal);
  a.abort();
  await expect(p).rejects.toMatchObject({ name: "AbortError" });
  release();
  expect(await q).toBe(17);
});
it("skips an exactly empty subtree without rendering a single leaf", async () => {
  let calls = 0;
  const pyramid = new PixelPyramid<number>({
    width: 32768,
    height: 32768,
    tileSize: 512,
    isEmpty: () => true,
    create: () => 0,
    renderLeaf: async () => ++calls,
    reduceChild() {},
  });
  expect(await pyramid.get(0, 0, 0, new AbortController().signal)).toBe(0);
  expect(calls).toBe(0);
});

it("feeds a bounded batch of real leaves concurrently instead of serializing one whole subtree", async () => {
  type Pixel = { sum: number; children?: number[] };
  let busy = 0,
    peak = 0,
    calls = 0;
  const build = (leafConcurrency: number) =>
    new PixelPyramid<Pixel>({
      width: 8,
      height: 8,
      tileSize: 1,
      leafConcurrency,
      create: () => ({ sum: 0, children: [0, 0, 0, 0] }),
      renderLeaf: async (tile) => {
        busy++;
        peak = Math.max(peak, busy);
        calls++;
        await new Promise((r) => setTimeout(r, 0));
        busy--;
        return { sum: tile.y * 8 + tile.x + 1 };
      },
      reduceChild: (parent, child, dx, dy) => {
        parent.children![dy * 2 + dx] = child.sum;
        parent.sum = parent.children!.reduce((a, b) => a + b, 0);
      },
    });
  const parallel = await build(4).get(0, 0, 0, new AbortController().signal);
  expect(calls).toBe(64);
  expect(peak).toBe(4);
  peak = 0;
  calls = 0;
  const serial = await build(1).get(0, 0, 0, new AbortController().signal);
  expect(peak).toBe(1);
  expect(calls).toBe(64);
  expect(parallel).toEqual(serial);
  expect(parallel.sum).toBe((64 * 65) / 2);
});
