import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  RetainedTerrain,
  type StoredTerrain,
} from "../src/telescope/retained-terrain";
import { createRetainedViewportRenderer } from "../src/telescope/retained-viewport-renderer";
import { InstantTerrainCache } from "../src/telescope/instant-terrain-cache";
import type { TerrainViewportPlan } from "../src/telescope/terrain-viewport-compositor";

const owners: RetainedTerrain[] = [];
const lifetimes: AbortController[] = [];
const pending: Array<() => void> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  pending.push(() => resolve(undefined as T));
  return { promise, resolve };
}
function context(width = 256, height = 256, color = "#0000ff") {
  const c = createCanvas(width, height),
    ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return ctx as unknown as CanvasRenderingContext2D;
}
const bytes = (canvas: any) =>
  canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
const pixel = (canvas: any, x: number, y: number) => [
  ...canvas.getContext("2d").getImageData(x, y, 1, 1).data,
];
const plan = (
  x = 0,
  y = 0,
  width = 512,
  height = 256,
  scale = 1,
): TerrainViewportPlan => ({
  x,
  y,
  width,
  height,
  scale,
  pixelWidth: Math.ceil(width / scale),
  pixelHeight: Math.ceil(height / scale),
});

function fixture({
  width = 512,
  height = 256,
  x = 0,
  y = 0,
  budget = 4 * 1024 * 1024,
  cache = undefined as InstantTerrainCache | undefined,
} = {}) {
  const records = new Map<string, StoredTerrain>();
  const store = {
    read: vi.fn(async (key: string) => records.get(key)),
    write: vi.fn(async (entries: { key: string; value: StoredTerrain }[]) => {
      for (const entry of entries)
        records.set(entry.key, structuredClone(entry.value));
    }),
  };
  const owner = new RetainedTerrain(store, budget),
    retention = owner.region("viewport-seed", width, height);
  owners.push(owner);
  const lifetime = new AbortController();
  lifetimes.push(lifetime);
  const captured: any[] = [];
  const renderer = {
    renderViewport: vi.fn(
      async (p: TerrainViewportPlan, _signal: AbortSignal) => {
        const image: any = context(p.pixelWidth, p.pixelHeight).canvas;
        image.close = vi.fn();
        captured.push(image);
        return image;
      },
    ),
  };
  let complete = false;
  const refresh = vi.fn();
  const render = createRetainedViewportRenderer({
    regions: [{ region: { x, y, width, height }, retention }],
    renderer,
    signal: lifetime.signal,
    complete: () => complete,
    refresh,
    cache,
  });
  const request = (
    p = plan(x, y, width, height),
    signal = new AbortController().signal,
  ) => render.render(p, signal);
  function saved(tileX: number, color: string, hole = false) {
    const ctx = context(256, 256, color);
    if (hole) ctx.clearRect(8, 8, 16, 16);
    records.set(`viewport-seed/${retention.maxLevel}/${tileX}/0`, {
      width: 256,
      height: 256,
      pixels: bytes(ctx.canvas),
      coverage: new Uint8Array([1]),
      columns: 1,
      rows: 1,
    });
  }
  return {
    owner,
    retention,
    store,
    records,
    lifetime,
    renderer,
    captured,
    refresh,
    render,
    request,
    saved,
    finishCooking: () => {
      complete = true;
    },
  };
}

beforeEach(() =>
  vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) }),
);
afterEach(async () => {
  for (const lifetime of lifetimes.splice(0)) lifetime.abort();
  for (const finish of pending.splice(0)) finish();
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) {
    await owner.flush();
    owner.dispose();
  }
  vi.unstubAllGlobals();
});

describe("retained native pixels with atomic viewport presentation", () => {
  it("delivers the GPU frame while storage and retention capacity are unresolved", async () => {
    const f = fixture(),
      held = deferred<StoredTerrain | undefined>();
    f.store.read.mockReturnValue(held.promise);
    const capacity = vi
      .spyOn(f.owner, "capacity")
      .mockReturnValue(new Promise(() => {}));
    const output = await f.request();
    expect(pixel(output, 40, 40)).toEqual([0, 0, 255, 255]);
    expect(f.renderer.renderViewport).toHaveBeenCalledOnce();
    expect(capacity).not.toHaveBeenCalled();
    expect(f.store.write).not.toHaveBeenCalled();
    expect(f.captured[0].close).toHaveBeenCalledOnce();
  });

  it("reuses one GPU base when native revisions arrive, clearing known air and retaining independent returned frames", async () => {
    const f = fixture();
    const first: any = await f.request();
    const native = context(256, 256, "#ff0000");
    native.clearRect(8, 8, 16, 16);
    await f.retention.record(0, 0, native);
    const second: any = await f.request();
    expect(pixel(second, 20, 20)).toEqual([0, 0, 0, 0]);
    expect(pixel(second, 40, 40)).toEqual([255, 0, 0, 255]);
    expect(pixel(second, 300, 40)).toEqual([0, 0, 255, 255]);
    expect(pixel(first, 40, 40)).toEqual([0, 0, 255, 255]);
    first.width = first.height = second.width = second.height = 0;
    f.captured[0].width = f.captured[0].height = 0;
    const third = await f.request();
    expect(pixel(third, 300, 40)).toEqual([0, 0, 255, 255]);
    expect(f.renderer.renderViewport).toHaveBeenCalledOnce();
    expect(f.render.stats).toEqual({
      gpuFrames: 1,
      retainedFrames: 0,
      reusedFrames: 2,
    });
  });

  it("draws fully resident native pixels without requesting a GPU frame", async () => {
    const f = fixture({ width: 256 }),
      native = context(256, 256, "#17aa40");
    native.clearRect(0, 0, 12, 12);
    await f.retention.record(0, 0, native);
    const output = await f.request();
    expect(
      Buffer.from(bytes(output)).equals(Buffer.from(bytes(native.canvas))),
    ).toBe(true);
    expect(f.renderer.renderViewport).not.toHaveBeenCalled();
    expect(f.render.stats.retainedFrames).toBe(1);
  });

  it("reuses a recent camera after zooming out and back, with native transparent pixels authoritative", async () => {
    const cache = new InstantTerrainCache(2 * 512 * 256 * 4);
    const f = fixture({ cache });
    const first: any = await f.request();
    const overview: any = await f.request(plan(0, 0, 512, 256, 2));
    first.width = first.height = overview.width = overview.height = 0;
    for (const image of f.captured) image.width = image.height = 0;
    const native = context(256, 256, "#ff0000");
    native.clearRect(8, 8, 16, 16);
    await f.retention.record(0, 0, native);
    const revisited = await f.request();
    expect(pixel(revisited, 20, 20)).toEqual([0, 0, 0, 0]);
    expect(pixel(revisited, 40, 40)).toEqual([255, 0, 0, 255]);
    expect(pixel(revisited, 300, 40)).toEqual([0, 0, 255, 255]);
    expect(f.renderer.renderViewport).toHaveBeenCalledTimes(2);
    expect(cache.stats.hits).toBe(1);
    expect(f.render.stats.reusedFrames).toBe(1);
    cache.clear();
  });

  it("evicts old cameras within the shared byte budget while preserving the current base", async () => {
    const cache = new InstantTerrainCache(2 * 256 * 256 * 4);
    const f = fixture({ width: 1024, cache });
    const a = plan(0, 0, 256, 256),
      b = plan(256, 0, 256, 256),
      c = plan(512, 0, 256, 256);
    await f.request(a);
    await f.request(b);
    await f.request(a); // A is most recently used; C must evict B.
    await f.request(c);
    expect(cache.stats.bytes).toBe(cache.maxBytes);
    expect(cache.stats.entries).toBe(2);
    expect(cache.stats.evictions).toBe(1);
    await f.request(a);
    expect(f.renderer.renderViewport).toHaveBeenCalledTimes(3);
    await f.request(b);
    expect(f.renderer.renderViewport).toHaveBeenCalledTimes(4);
    expect(cache.stats.bytes).toBeLessThanOrEqual(cache.maxBytes);
    cache.clear();
    await f.request(b); // Clearing optional history cannot destroy the active base.
    expect(f.renderer.renderViewport).toHaveBeenCalledTimes(4);
  });

  it("carries viewed detail into a wider camera even after the optional camera cache is cleared", async () => {
    const cache = new InstantTerrainCache();
    const f = fixture({ cache });
    f.renderer.renderViewport.mockImplementationOnce(async (p) => {
      const detail: any = context(p.pixelWidth, p.pixelHeight, "#ff0000").canvas;
      detail.getContext("2d").clearRect(32, 32, 64, 64);
      detail.close = vi.fn();
      return detail;
    });
    await f.request(plan(0, 0, 256, 256));
    cache.clear();
    const wider = await f.request(plan(0, 0, 512, 256, 2));
    expect(pixel(wider, 20, 20)).toEqual([0, 0, 0, 0]);
    expect(pixel(wider, 80, 40)).toEqual([255, 0, 0, 255]);
    expect(pixel(wider, 180, 40)).toEqual([0, 0, 255, 255]);
    cache.clear();
  });

  it.each(["same camera", "farther out", "back in", "pan away and revisit"])(
    "keeps canonical air over older fine previews after native-page eviction: %s",
    async (navigation) => {
      const f = fixture({ width: 1024, budget: 1024 * 1024 });
      const fine = plan(0, 0, 512, 256), coarse = plan(0, 0, 512, 256, 2);
      await f.request(fine); // Fine, opaque provisional pixels remain cached.
      const native = context(256, 256, "#ff0000");
      native.clearRect(64, 64, 64, 64);
      await f.retention.record(0, 0, native);
      const corrected = await f.request(coarse);
      expect(pixel(corrected, 40, 40)).toEqual([0, 0, 0, 0]);
      await f.owner.flush();

      // Real retention eviction: a clean page larger than the budget evicts
      // both all old native/mip pages and itself. Optional disk reads stay
      // pending, so the following view can only use its completed frames.
      const pressure = f.owner.install("pressure", context(512, 513), new Uint8Array([1]), 1, 1, false);
      f.owner.release(pressure);
      expect(f.owner.stats.pages).toBe(0);
      expect(f.owner.stats.bytes).toBe(0);
      const held = deferred<StoredTerrain | undefined>();
      f.store.read.mockReturnValue(held.promise);

      if (navigation === "pan away and revisit") await f.request(plan(512, 0, 512, 256, 2));
      const target = navigation === "farther out" ? plan(0, 0, 1024, 256, 4)
        : navigation === "back in" ? fine : coarse;
      const result = await f.request(target);
      expect(pixel(result, 80 / target.scale, 80 / target.scale)).toEqual([0, 0, 0, 0]);
      expect(pixel(result, 160 / target.scale, 80 / target.scale)).toEqual([255, 0, 0, 255]);
      expect(pixel(result, 400 / target.scale, 80 / target.scale)).toEqual([0, 0, 255, 255]);
    },
  );

  it("reprojects preserved detail at fractional camera coordinates without leaving opaque coverage holes", async () => {
    const f = fixture();
    const source = context(256, 256, "#ff0000");
    source.clearRect(64, 64, 64, 64);
    f.renderer.renderViewport.mockImplementationOnce(async () => source.canvas);
    await f.request(plan(0, 0, 256, 256));
    const target = plan(-11.3, -7.7, 544, 289, 1.7);
    const result = await f.request(target);
    const expected = context(target.pixelWidth, target.pixelHeight);
    expected.setTransform(1 / target.scale, 0, 0, 1 / target.scale,
      -target.x / target.scale, -target.y / target.scale);
    expected.imageSmoothingEnabled = true;
    expected.imageSmoothingQuality = "low";
    expected.clearRect(0, 0, 256, 256);
    expected.drawImage(source.canvas, 0, 0, 256, 256);
    expect(Buffer.from(bytes(result)).equals(Buffer.from(bytes(expected.canvas)))).toBe(true);
  });

  it("keeps cached native checkerboard detail when revisiting it after a newer coarse canonical frame and page eviction", async () => {
    const f = fixture({ width: 1024, budget: 1024 * 1024 });
    const native = context(256, 256), image = native.createImageData(256, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const offset = (y * 256 + x) * 4;
      image.data[offset] = (x + y) % 2 ? 255 : 0;
      image.data[offset + 1] = (x + y) % 2 ? 0 : 255;
      image.data[offset + 3] = 255;
    }
    native.putImageData(image, 0, 0);
    native.clearRect(64, 64, 64, 64);
    await f.retention.record(0, 0, native);
    const fine = plan(0, 0, 512, 256);
    await f.request(fine);
    await f.request(plan(0, 0, 512, 256, 2));
    await f.owner.flush();
    const pressure = f.owner.install("pressure", context(512, 513), new Uint8Array([1]), 1, 1, false);
    f.owner.release(pressure);
    expect(f.owner.stats.pages).toBe(0);
    const held = deferred<StoredTerrain | undefined>();
    f.store.read.mockReturnValue(held.promise);
    const revisited: any = await f.request(fine);
    const actual = revisited.getContext("2d").getImageData(0, 0, 256, 256).data;
    expect(Buffer.from(actual).equals(Buffer.from(bytes(native.canvas))))
      .toBe(true);
  });

  it("isolates renderer identities when a cache is shared between map lifetimes", async () => {
    const cache = new InstantTerrainCache();
    const first = fixture({ cache }),
      second = fixture({ cache });
    await first.request();
    await second.request();
    expect(first.renderer.renderViewport).toHaveBeenCalledOnce();
    expect(second.renderer.renderViewport).toHaveBeenCalledOnce();
    expect(cache.stats.entries).toBe(2);
    cache.clear();
  });

  it("replays a completed map from persisted pages under a one-page budget without GPU work", async () => {
    const f = fixture({ width: 768, budget: 256 * 256 * 4 + 1 });
    f.saved(0, "#ff0000");
    f.saved(1, "#00ff00", true);
    f.saved(2, "#0000ff");
    f.finishCooking();
    const output = await f.request();
    expect(pixel(output, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(output, 264, 8)).toEqual([0, 0, 0, 0]);
    expect(pixel(output, 300, 40)).toEqual([0, 255, 0, 255]);
    expect(pixel(output, 767, 40)).toEqual([0, 0, 255, 255]);
    expect(f.renderer.renderViewport).not.toHaveBeenCalled();
    expect(f.store.read).toHaveBeenCalledTimes(3);
    expect(f.owner.stats.bytes).toBeLessThanOrEqual(f.owner.maxBytes);
  });

  it("keeps every saved page in the completed viewport while background cooking is unfinished and RAM holds only one page", async () => {
    const f = fixture({ width: 768, budget: 256 * 256 * 4 + 1 });
    f.saved(0, "#ff0000");
    f.saved(1, "#00ff00", true);
    f.saved(2, "#ffff00");
    await f.request();
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalled());
    const hydrated = await f.request();
    expect(pixel(hydrated, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(hydrated, 264, 8)).toEqual([0, 0, 0, 0]);
    expect(pixel(hydrated, 300, 40)).toEqual([0, 255, 0, 255]);
    expect(pixel(hydrated, 767, 40)).toEqual([255, 255, 0, 255]);
    expect(f.renderer.renderViewport).toHaveBeenCalledOnce();
    expect(f.owner.stats.bytes).toBeLessThanOrEqual(f.owner.maxBytes);
  });

  it("resets a translated stored-view transform before GPU fallback when a saved page is missing", async () => {
    const f = fixture({ x: 1000, y: 2000 });
    f.finishCooking();
    // The view begins 32 native pixels inside this world. The stored-view
    // transform translates by -32/-16 and must not leak into the GPU copy.
    const output = await f.request(plan(1032, 2016, 256, 128, 2));
    expect(pixel(output, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(output, 127, 63)).toEqual([0, 0, 255, 255]);
    expect(f.renderer.renderViewport).toHaveBeenCalledOnce();
  });

  it.each(["frame", "lifetime"])(
    "closes a late GPU bitmap after %s cancellation without publishing it",
    async (kind) => {
      const f = fixture(),
        held = deferred<CanvasImageSource>(),
        request = new AbortController();
      f.renderer.renderViewport.mockReturnValue(held.promise);
      const result = f
        .request(undefined, request.signal)
        .catch((error) => error);
      await vi.waitFor(() =>
        expect(f.renderer.renderViewport).toHaveBeenCalledOnce(),
      );
      (kind === "frame" ? request : f.lifetime).abort();
      const bitmap: any = context(512, 256).canvas;
      bitmap.close = vi.fn();
      held.resolve(bitmap);
      expect((await result).name).toBe("AbortError");
      expect(bitmap.close).toHaveBeenCalledOnce();
      expect(f.render.stats.gpuFrames).toBe(0);
    },
  );

  it("bounds optional hydration to one camera and stops obsolete page reads after lifetime cancellation", async () => {
    const f = fixture({ width: 768 }),
      held = deferred<StoredTerrain | undefined>();
    f.store.read.mockReturnValue(held.promise);
    await f.request(plan(0, 0, 512, 256));
    await vi.waitFor(() => expect(f.store.read).toHaveBeenCalledOnce());
    await f.request(plan(512, 0, 256, 256));
    expect(f.store.read).toHaveBeenCalledOnce();
    f.lifetime.abort();
    held.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.store.read).toHaveBeenCalledOnce();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("rejects completed-map replay if the renderer lifetime ends during a stored read", async () => {
    const f = fixture({ width: 256 }),
      held = deferred<StoredTerrain | undefined>();
    f.saved(0, "#ff0000");
    f.store.read.mockReturnValue(held.promise);
    f.finishCooking();
    const result = f.request().catch((error) => error);
    await vi.waitFor(() => expect(f.store.read).toHaveBeenCalledOnce());
    f.lifetime.abort();
    held.resolve([...f.records.values()][0]);
    expect((await result).name).toBe("AbortError");
    expect(f.renderer.renderViewport).not.toHaveBeenCalled();
  });
});
