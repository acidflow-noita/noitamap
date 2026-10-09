import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { JSDOM } from "jsdom";
import { createInstantTileSource } from "../src/telescope/instant-terrain";
import { InstantTerrainWorkerClient } from "../src/telescope/instant-terrain-backend";
import { scheduleTerrainWork } from "../src/telescope/terrain-work-queue";

let OSD: any;
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
beforeAll(async () => {
  for (const key of ["window", "self", "document", "navigator", "HTMLCanvasElement", "Image"])
    vi.stubGlobal(key, (dom.window as any)[key]);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return createCanvas(this.width || 1, this.height || 1).getContext("2d") as any;
  });
  OSD = (await import("openseadragon")).default;
  vi.stubGlobal("OpenSeadragon", OSD);
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((name: string, options?: ElementCreationOptions) =>
    name === "canvas" ? createCanvas(1, 1) : createElement(name, options)) as any);
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close(); });

class HungWorker {
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: any[] = [];
  terminate = vi.fn();
  postMessage(data: any) { this.sent.push(data); }
  reply(data: any) { this.onmessage?.({ data }); }
}

it("recovers a hung admitted worker once before real OSD deadlines, releases the queue and closes late transfers", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const worker = new HungWorker(), client = new InstantTerrainWorkerClient(worker as any);
  const lifetime = new AbortController();
  // Match addInstantTerrain's generation-wide failure boundary: first failure
  // retires its sibling sources before the approximate fallback is installed.
  const fallback = vi.fn((_error: unknown) => lifetime.abort());
  const source = createInstantTileSource({
    region: { x: -17920, y: -7168, width: 1024, height: 256, pw: 0 },
    deps: {
      GLTerrainRenderer: class {} as any,
      initMaterialAtlas: async () => {},
      getWorldSize: () => 70,
      getWorldCenter: () => 35,
      GENERATOR_CONFIG: {},
    },
    gen: { seed: 42, isNGP: false, tileLayers: [], biomeData: { pixels: new Uint32Array(70 * 48) } },
    renderer: { render: async (view: any, signal: AbortSignal) => (await client.request("render", { view }, signal)).bitmap },
    clip: { draw: () => {}, dispose: () => {} },
    signal: lifetime.signal,
    onFailure: fallback,
  });
  const loader = new OSD.ImageLoader({ jobLimit: 3, timeout: 30_000, tileRetryMax: 0 });
  const callbacks = [0, 1, 2].map(x => {
    const callback = vi.fn();
    loader.addJob({ source, src: source.getTileUrl(source.maxLevel, x, 0),
      tile: { level: source.maxLevel, x, y: 0 }, callback });
    return callback;
  });
  try {
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.sent.filter(job => job.type === "render")).toHaveLength(2);
    expect(loader.jobsInProgress).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    expect(String(fallback.mock.calls[0][0])).toContain("Terrain worker render timed out");
    expect(loader.jobsInProgress).toBe(0);
    for (const callback of callbacks) expect(callback).toHaveBeenCalledOnce();
    const bitmap = { close: vi.fn() };
    worker.reply({ id: worker.sent.find(job => job.type === "render").id, bitmap });
    expect(bitmap.close).toHaveBeenCalledOnce();
    const recovery = scheduleTerrainWork(() => 42, new AbortController().signal, () => 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await recovery).toBe(42);
    await vi.advanceTimersByTimeAsync(30_000);
    for (const callback of callbacks) {
      expect(callback).toHaveBeenCalledOnce();
      expect(String(callback.mock.calls[0][1])).not.toContain("Image load exceeded timeout");
    }
    expect(fallback).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  } finally {
    lifetime.abort();
    client.dispose();
    vi.useRealTimers();
  }
});
