// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { createInstantTileSource } from "../src/telescope/instant-terrain";

// The TileSource is under test; no terrain worker or shader initialization is
// needed because the fixture supplies its renderer directly.
vi.mock("../src/telescope/instant-terrain-backend", () => ({
  prepareInstantTerrain: vi.fn(),
}));
vi.mock("../src/telescope/instant-terrain-plane", () => ({
  setTerrainPlane: vi.fn(),
}));

let OSD: any;
beforeAll(async () => {
  // jsdom supplies the installed OSD module's DOM globals. All rendered and
  // cached pixels below use native Skia; no browser or network is involved.
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
afterEach(() => vi.useRealTimers());

function fixture(timeout = 3000, tileRetryMax = 0) {
  const lifetime = new AbortController(),
    failure = vi.fn();
  const renders: {
    resolve: (image: any) => void;
    signal: AbortSignal;
    width: number;
    height: number;
  }[] = [];
  const render = vi.fn(
    (view: { width: number; height: number }, signal: AbortSignal) =>
      new Promise((resolve) => renders.push({ resolve, signal, ...view })),
  );
  const source = createInstantTileSource({
    region: { x: -17920, y: -7168, width: 256, height: 256, pw: 0 },
    deps: {
      GLTerrainRenderer: class {} as any,
      initMaterialAtlas: async () => {},
      getWorldSize: () => 70,
      getWorldCenter: () => 35,
      GENERATOR_CONFIG: {},
    },
    gen: {
      seed: 42,
      isNGP: false,
      tileLayers: [],
      biomeData: { pixels: new Uint32Array(70 * 48) },
    },
    renderer: { render, gl: { getError: () => 0 } },
    clip: {
      draw(context, image) {
        context.drawImage(image, 0, 0);
      },
      dispose() {},
    },
    signal: lifetime.signal,
    onFailure: failure,
  });
  const loader = new OSD.ImageLoader({
    jobLimit: 3,
    tileRetryMax,
    tileRetryDelay: 0,
    timeout,
  });
  const jobs: any[] = [];
  const start = source.downloadTileStart;
  source.downloadTileStart = (job: any) => {
    jobs.push(job);
    start(job);
  };
  function request() {
    const callback = vi.fn(),
      aborted = vi.fn();
    loader.addJob({
      source,
      src: source.getTileUrl(source.maxLevel, 0, 0),
      tile: { level: source.maxLevel, x: 0, y: 0 },
      callback,
      abort: aborted,
    });
    return { job: jobs.at(-1), callback, aborted };
  }
  function finishRender(index = 0) {
    const pending = renders[index],
      image = createCanvas(pending.width, pending.height) as any;
    const context = image.getContext("2d");
    context.fillStyle = "#2468ac";
    context.fillRect(0, 0, image.width, image.height);
    image.close = vi.fn();
    pending.resolve(image);
    return image;
  }
  return {
    lifetime,
    failure,
    source,
    loader,
    renders,
    render,
    request,
    finishRender,
  };
}

describe("terrain cancellation through installed OpenSeadragon ImageJob/ImageLoader", () => {
  it("settles an OSD-aborted job once and closes its late bitmap without another completion", async () => {
    const f = fixture();
    try {
      const request = f.request();
      await vi.waitFor(() => expect(f.render).toHaveBeenCalledOnce());
      expect(f.loader.jobsInProgress).toBe(1);
      request.job.abort();
      expect(request.callback).toHaveBeenCalledOnce();
      expect(request.callback.mock.calls[0][1]).toContain("aborted");
      expect(request.aborted).toHaveBeenCalledOnce();
      expect(f.loader.jobsInProgress).toBe(0);
      expect(f.renders[0].signal.aborted).toBe(true);
      const image = f.finishRender();
      await vi.waitFor(() => expect(image.close).toHaveBeenCalledOnce());
      expect(request.callback).toHaveBeenCalledOnce();
      expect(f.loader.jobsInProgress).toBe(0);
      expect(f.source.instantCacheStats.bytes).toBe(0);
      expect(f.failure).not.toHaveBeenCalled();
    } finally {
      f.lifetime.abort();
    }
  });

  it("keeps a shared render alive for the other consumer and leaves the loader count correct", async () => {
    const f = fixture();
    try {
      const first = f.request(),
        second = f.request();
      await vi.waitFor(() => expect(f.render).toHaveBeenCalledOnce());
      expect(f.loader.jobsInProgress).toBe(2);
      first.job.abort();
      expect(first.callback).toHaveBeenCalledOnce();
      expect(f.loader.jobsInProgress).toBe(1);
      expect(f.renders[0].signal.aborted).toBe(false);
      const image = f.finishRender();
      await vi.waitFor(() => expect(second.callback).toHaveBeenCalledOnce());
      expect(f.loader.jobsInProgress).toBe(0);
      expect(first.callback).toHaveBeenCalledOnce();
      expect(second.callback.mock.calls[0][1]).toBeNull();
      expect([
        ...second.callback.mock.calls[0][0].getImageData(0, 0, 1, 1).data,
      ]).toEqual([36, 104, 172, 255]);
      expect(image.close).toHaveBeenCalledOnce();
      const cached = f.request();
      await vi.waitFor(() => expect(cached.callback).toHaveBeenCalledOnce());
      expect(f.render).toHaveBeenCalledOnce();
      expect(f.loader.jobsInProgress).toBe(0);
      expect(f.failure).not.toHaveBeenCalled();
    } finally {
      f.lifetime.abort();
    }
  });

  it("cancels one pending cache hit without losing the other hit or completing either twice", async () => {
    const f = fixture();
    try {
      const prime = f.request();
      await vi.waitFor(() => expect(f.render).toHaveBeenCalledOnce());
      f.finishRender();
      await vi.waitFor(() => expect(prime.callback).toHaveBeenCalledOnce());
      const first = f.request(),
        second = f.request();
      first.job.abort();
      expect(first.callback).toHaveBeenCalledOnce();
      expect(f.loader.jobsInProgress).toBe(1);
      await vi.waitFor(() => expect(second.callback).toHaveBeenCalledOnce());
      expect(first.callback).toHaveBeenCalledOnce();
      expect(second.callback.mock.calls[0][1]).toBeNull();
      expect(f.loader.jobsInProgress).toBe(0);
      expect(f.render).toHaveBeenCalledOnce();
      expect(f.source.instantCacheStats.hits).toBe(2);
    } finally {
      f.lifetime.abort();
    }
  });

  it("settles all consumers once when the seed expires and never repopulates its cache", async () => {
    const f = fixture();
    try {
      const first = f.request(),
        second = f.request();
      await vi.waitFor(() => expect(f.render).toHaveBeenCalledOnce());
      f.lifetime.abort();
      expect(first.callback).toHaveBeenCalledOnce();
      expect(second.callback).toHaveBeenCalledOnce();
      expect(f.loader.jobsInProgress).toBe(0);
      const image = f.finishRender();
      await vi.waitFor(() => expect(image.close).toHaveBeenCalledOnce());
      expect(first.callback).toHaveBeenCalledOnce();
      expect(second.callback).toHaveBeenCalledOnce();
      expect(f.loader.jobsInProgress).toBe(0);
      expect(f.source.instantCacheStats.bytes).toBe(0);
      expect(f.failure).not.toHaveBeenCalled();
    } finally {
      f.lifetime.abort();
    }
  });

  it("releases a timed-out ImageJob and ignores its late result without another loader callback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(150);
    try {
      const request = f.request();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.render).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(150);
      expect(request.callback).toHaveBeenCalledOnce();
      expect(request.callback.mock.calls[0][1]).toContain("timeout");
      expect(f.loader.jobsInProgress).toBe(0);
      expect(f.renders[0].signal.aborted).toBe(true);
      const image = f.finishRender();
      await vi.advanceTimersByTimeAsync(0);
      expect(image.close).toHaveBeenCalledOnce();
      expect(request.callback).toHaveBeenCalledOnce();
      expect(f.source.instantCacheStats.bytes).toBe(0);
      expect(f.loader.jobsInProgress).toBe(0);
      expect(f.failure).not.toHaveBeenCalled();
    } finally {
      f.lifetime.abort();
    }
  });

  it("retries the same real ImageJob and keeps a late first attempt from settling the retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(150, 1);
    try {
      const request = f.request();
      await vi.advanceTimersByTimeAsync(160);
      expect(f.render).toHaveBeenCalledTimes(2);
      expect(request.job.tries).toBe(2);
      expect(request.callback).toHaveBeenCalledOnce();
      expect(request.callback.mock.calls[0][1]).toContain("timeout");
      expect(f.renders[0].signal.aborted).toBe(true);
      expect(f.renders[1].signal.aborted).toBe(false);
      expect(f.loader.jobsInProgress).toBe(1);
      const oldImage = f.finishRender(0),
        retryImage = f.finishRender(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(request.callback).toHaveBeenCalledTimes(2);
      expect(request.callback.mock.calls[1][1]).toBeNull();
      expect([
        ...request.callback.mock.calls[1][0].getImageData(0, 0, 1, 1).data,
      ]).toEqual([36, 104, 172, 255]);
      expect(oldImage.close).toHaveBeenCalledOnce();
      expect(retryImage.close).toHaveBeenCalledOnce();
      expect(f.loader.jobsInProgress).toBe(0);
      expect(f.loader.failedTiles).toHaveLength(0);
      expect(f.source.instantCacheStats.entries).toBe(1);
      expect(f.failure).not.toHaveBeenCalled();
    } finally {
      f.lifetime.abort();
    }
  });
});
