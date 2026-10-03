import { afterEach, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { PixelPyramid } from "../src/telescope/pixel-pyramid";
import { mountTerrainViewport, renderTerrainFrame, type TerrainRegion } from "../src/telescope/terrain-viewport";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("assembles a complete clipped frame without publishing partial tile pixels", async () => {
  vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const requests: number[] = [];
  const region: TerrainRegion = {
    x: 0, y: 0, width: 1024, height: 512,
    source: {
      maxLevel: 10,
      async getFinalTile(_level, x) {
        requests.push(x);
        if (x === 1) await wait;
        const tile = createCanvas(512, 512), ctx = tile.getContext("2d");
        ctx.fillStyle = x === 0 ? "red" : "blue";
        ctx.fillRect(0, 0, 512, 512);
        return tile as unknown as HTMLCanvasElement;
      },
    },
  };
  let published = false;
  const pending = renderTerrainFrame([region], { x: 500, y: 100, width: 24, height: 16 }, 1, new AbortController().signal)
    .then(frame => { published = true; return frame; });
  await Promise.resolve();
  expect(requests.sort()).toEqual([0, 1]);
  expect(published).toBe(false);
  release();
  const canvas = await pending, ctx = canvas.getContext("2d")!;
  expect([canvas.width, canvas.height]).toEqual([24, 16]);
  expect([...ctx.getImageData(0, 0, 1, 1).data]).toEqual([255, 0, 0, 255]);
  expect([...ctx.getImageData(23, 15, 1, 1).data]).toEqual([0, 0, 255, 255]);
});

it("replaces frames below markers only after load, and removes tracking on disposal", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal("OpenSeadragon", { TileSource: class { constructor(options: object) { Object.assign(this, options); } } });
  const tile = createCanvas(512, 512);
  const regions: TerrainRegion[] = [{ x: 0, y: 0, width: 1024, height: 512,
    source: { maxLevel: 10, getFinalTile: async () => tile as unknown as HTMLCanvasElement } }];
  const base = {}, markers = {}, items: any[] = [base], added: any[] = [];
  const tracked = new Set(), firstPaint = vi.fn(), events = new Map<string, () => void>();
  let cameraX = 0;
  const viewer = {
    world: {
      getItemCount: () => items.length, getIndexOfItem: (item: any) => items.indexOf(item),
      removeItem: (item: any) => { items.splice(items.indexOf(item), 1); },
    },
    viewport: {
      getBounds: () => ({ getBoundingBox: () => ({ x: cameraX, y: 0, width: 128, height: 128 }) }),
      getBoundsNoRotate: () => ({ width: 128 }), getContainerSize: () => ({ x: 128, y: 128 }),
    },
    addHandler: (name: string, handler: () => void) => events.set(name, handler),
    removeHandler: (name: string) => events.delete(name), forceRedraw: vi.fn(),
    addTiledImage(options: any) {
      const handlers = new Map<string, any>();
      const item = { addHandler: (name: string, handler: any) => handlers.set(name, handler),
        removeHandler: (name: string) => handlers.delete(name), getFullyLoaded: () => false,
        loaded: () => handlers.get("fully-loaded-change")?.({ fullyLoaded: true }) };
      expect(options.tileSource.maxLevel).toBe(0);
      expect(options.tileSource.minLevel).toBe(0);
      items.splice(options.index, 0, item); added.push(item); options.success({ item });
    },
  };
  const dispose = mountTerrainViewport(viewer, regions, () => true,
    (item, removed) => { if (removed) tracked.delete(item); else tracked.add(item); }, firstPaint);
  items.push(markers);
  await vi.advanceTimersByTimeAsync(80);
  expect(firstPaint).not.toHaveBeenCalled();
  // Real OSD emits animation when a newly added TiledImage updates its bounds,
  // even with an unchanged camera. Loading the frame must not invalidate itself.
  events.get("animation")!();
  events.get("animation-finish")!();
  added[0].loaded();
  expect(firstPaint).toHaveBeenCalledTimes(1);
  expect(items).toEqual([base, added[0], markers]);
  cameraX = 128; events.get("animation-finish")!();
  await vi.advanceTimersByTimeAsync(80);
  expect(items).toContain(added[0]);
  added[1].loaded();
  expect(items).toEqual([base, added[1], markers]);
  expect(tracked.size).toBe(1);
  expect(firstPaint).toHaveBeenCalledTimes(1);
  dispose();
  expect(items).toEqual([base, markers]);
  expect(tracked.size).toBe(0);
  expect(events.size).toBe(0);
});


it("presents every visible CPU tile even while all disk writes are stalled", async () => {
  vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
  let release!: () => void;
  const disk = new Promise<void>(resolve => { release = resolve; });
  const write = vi.fn(() => disk);
  const pyramid = new PixelPyramid<HTMLCanvasElement>({
    width: 1536, height: 512, tileSize: 512,
    create: () => createCanvas(512, 512) as unknown as HTMLCanvasElement,
    renderLeaf: async tile => {
      const image = createCanvas(512, 512), ctx = image.getContext('2d');
      ctx.fillStyle = ['red', 'green', 'blue'][tile.x]; ctx.fillRect(0, 0, 512, 512);
      return image as unknown as HTMLCanvasElement;
    },
    reduceChild() {}, writeTile: write,
  });
  const region: TerrainRegion = { x: 0, y: 0, width: 1536, height: 512, nativeOnly: true,
    source: { maxLevel: pyramid.maxLevel, getFinalTile: (level, x, y, signal) => pyramid.get(level, x, y, signal) } };
  let frame: HTMLCanvasElement | undefined;
  const pending = renderTerrainFrame([region], { x: 0, y: 0, width: 1536, height: 512 }, 0.125, new AbortController().signal)
    .then(result => { frame = result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(write).toHaveBeenCalledTimes(3);
    expect(frame).toBeDefined();
    const ctx = frame!.getContext('2d')!;
    expect([...ctx.getImageData(16, 16, 1, 1).data]).toEqual([255, 0, 0, 255]);
    expect([...ctx.getImageData(80, 16, 1, 1).data]).toEqual([0, 128, 0, 255]);
    expect([...ctx.getImageData(144, 16, 1, 1).data]).toEqual([0, 0, 255, 255]);
  } finally { release(); await pending; }
});
