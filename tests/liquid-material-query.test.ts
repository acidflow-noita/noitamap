import { describe, expect, it, vi } from "vitest";
import { queryLiquidMaterials } from "../src/telescope/liquid-material-query";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { decodeLiquidMask } from "../src/liquids/mask-codec";
import { LiquidMaskIndex } from "../src/liquids/mask-index";

function setup() {
  const calls: unknown[] = [];
  let finish!: (data: Uint8Array[]) => void;
  const pending = new Promise<Uint8Array[]>(resolve => finish = resolve);
  const uniform = {}, gl = {
    useProgram: vi.fn(() => calls.push("program")), getUniformLocation: vi.fn(() => uniform),
    uniform1i: vi.fn((_at: unknown, value: number) => calls.push(value)),
  };
  const resources = { setPlane: vi.fn((plane: number) => calls.push(["plane", plane])), ensureResources: vi.fn() };
  const renderer = { gl, program: {}, engineReady: true, contextLost: false,
    ensureResources: vi.fn(), resolveMaterialTiles: vi.fn(() => { calls.push("draw"); return pending; }) };
  return { calls, gl, resources, renderer, pending, finish };
}
const rect = { x0: -3230, y0: 810, w: 200, h: 120 };

describe("liquid-only material query state and limits", () => {
  it("restores the flag immediately after enqueueing draws, before asynchronous readback settles", async () => {
    const s = setup(), result = queryLiquidMaterials(s.renderer, s.resources, [rect], -1);
    expect(result).toBe(s.pending);
    expect(s.calls).toEqual([["plane", -1], "program", 1, "draw", 0]);
    expect(s.renderer.resolveMaterialTiles).toHaveBeenCalledWith([rect]);
    const bytes = new Uint8Array(rect.w * rect.h * 4);
    s.finish([bytes]); expect(await result).toEqual([bytes]);
    expect(s.gl.getUniformLocation).toHaveBeenCalledWith(s.renderer.program, "u_liquidMaskOut");
  });
  it("restores the flag if enqueueing fails synchronously", () => {
    const s = setup();
    s.renderer.resolveMaterialTiles.mockImplementation(() => { throw new Error("draw failed"); });
    expect(() => queryLiquidMaterials(s.renderer, s.resources, [rect], 0)).toThrow("draw failed");
    expect(s.gl.uniform1i.mock.calls.map(call => call[1])).toEqual([1, 0]);
  });
  it("does no plane, program, resource-warm or query work on an unavailable backend", async () => {
    for (const state of [{ engineReady: false, contextLost: false }, { engineReady: true, contextLost: true }]) {
      const s = setup(); Object.assign(s.renderer, state);
      expect(await queryLiquidMaterials(s.renderer, s.resources, [rect], 0)).toBeNull();
      expect(s.calls).toEqual([]);
      expect(s.renderer.ensureResources).not.toHaveBeenCalled();
      expect(s.resources.ensureResources).not.toHaveBeenCalled();
      expect(s.renderer.resolveMaterialTiles).not.toHaveBeenCalled();
    }
  });
  it("declines a program without the mask uniform", async () => {
    const s = setup(); s.gl.getUniformLocation.mockReturnValue(null as any);
    expect(await queryLiquidMaterials(s.renderer, s.resources, [rect], 0)).toBeNull();
    expect(s.gl.uniform1i).not.toHaveBeenCalled();
    expect(s.renderer.resolveMaterialTiles).not.toHaveBeenCalled();
  });
  it.each([
    [], [rect, rect, rect], [{ ...rect, w: 257 }], [{ ...rect, h: 0 }],
    [rect, { ...rect, h: 119 }], [{ ...rect, x0: NaN }], [{ ...rect, y0: 0.5 }],
    [{ x0: 1, y0: 2, h: 10 }], [{ ...rect, x0: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...rect, x0: 2147483647 }], [{ ...rect, y0: -2147483649 }],
  ])("rejects malformed or over-budget rectangles before GL work: %j", (...rects: any[]) => {
    // it.each spreads rows; each entry above is the actual rectangle array.
    const s = setup();
    expect(() => queryLiquidMaterials(s.renderer, s.resources, rects, 0)).toThrow();
    expect(s.calls).toEqual([]);
  });
  it.each([-2, 2, 0.5, NaN])("rejects invalid vertical plane %s", plane => {
    const s = setup();
    expect(() => queryLiquidMaterials(s.renderer, s.resources, [rect], plane as any)).toThrow();
    expect(s.calls).toEqual([]);
  });
  it("admits the maximum two 256px query tiles without widening the batch", async () => {
    const s = setup(), rects = [{ x0: -512, y0: -31744, w: 256, h: 256 }, { x0: 512, y0: -31744, w: 256, h: 256 }];
    const result = queryLiquidMaterials(s.renderer, s.resources, rects, -1);
    expect(s.renderer.resolveMaterialTiles).toHaveBeenCalledWith(rects);
    s.finish([new Uint8Array(256 * 256 * 4), new Uint8Array(256 * 256 * 4)]);
    expect((await result)!.reduce((n, data) => n + data.length, 0)).toBe(512 * 1024);
  });
});

it.skipIf(process.platform !== "linux")("uses native leveled-pool occupancy only for the mask flag, preserving ordinary material output", async () => {
  const root = resolve(import.meta.dirname, ".."), bundle = await mkdtemp(resolve(tmpdir(), "noitamap-liquid-query-"));
  try {
    await build({ configFile: resolve(root, "vite.config.ts"), logLevel: "error", publicDir: false,
      build: { outDir: bundle, rollupOptions: { input: resolve(root, "tests/helpers/liquid-query-native.ts"),
        preserveEntrySignatures: "strict", output: { entryFileNames: "fixture.js", manualChunks: () => undefined } } } });
    const result: any = await new Promise((done, reject) => {
      const worker = new Worker(resolve(root, "tests/helpers/terrain-pan-worker.mjs"), { workerData: { root, bundle }, stdout: true, stderr: true });
      let result: any, logs = "";
      for (const stream of [worker.stdout!, worker.stderr!]) stream.on("data", data => logs = (logs + data).slice(-12000));
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error(`Native liquid query timed out\n${logs}`)); }, 90000);
      worker.on("message", data => result = data);
      worker.on("error", error => { clearTimeout(timer); void worker.terminate(); reject(error); });
      worker.on("exit", code => {
        clearTimeout(timer);
        if (code || result?.error || !result) reject(new Error((result?.error || `Exit ${code}`) + "\n" + logs));
        else done(result);
      });
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.samples).toHaveLength(5);
    for (const sample of result.samples) {
      expect(sample.mismatches, JSON.stringify(sample)).toBe(0);
      expect(sample.ordinaryDifferences, JSON.stringify(sample)).toBe(0);
      expect(sample.resetDifferences, JSON.stringify(sample)).toBe(0);
      if (sample.plane === 0) {
        expect(sample.changes).toBeGreaterThan(100);
        for (const point of sample.boundary) expect(point).toMatchObject({ above: 0, belowLiquid: true });
      }
    }
    expect(result.fallback).toMatchObject({ biome: "lava_90percent", mode: 2, ordinaryMaterial: -1 });
    const staticIndex = new LiquidMaskIndex(decodeLiquidMask(gunzipSync(
      await readFile(resolve(root, "src/liquids/assets/static-mask.bin.gz")))));
    // The native polygon excludes the 512px chunk's exact left edge. Center
    // x=-3840 is local column256; the actual excluded boundary is x=-4096.
    for (const point of result.fallback.points) {
      const mask = new Uint8Array(1);
      staticIndex.paint(mask, { x: point.x, y: point.y, width: 1, height: 1 });
      point.staticMask = mask[0];
      expect(point.owner).toBe(-1); // Live source preserves the fixed mask here.
      expect(mask[0], JSON.stringify(point)).toBe(point.localX === 0 ? 0 : 255);
    }
    expect(result.fallback.points.map((point: any) => point.x)).toEqual([-4096, -4095, -3840, -3839]);
    console.log("[native liquid mask query]", JSON.stringify(result));
  } finally { await rm(bundle, { recursive: true, force: true }); }
}, 120000);
