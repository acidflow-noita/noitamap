import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  NORMAL_MAP_MANIFEST,
  SharedPixelStore,
  restoreCookedMap,
  type CookedMapManifest,
  type PixelBytes,
} from "../cooked-pixels";
import { reduceFinalPixels } from "../cooked-pixels/mip";
import { reduce2 } from "../../../build_scripts/terrain-pyramid.mjs";
import {
  FragmentComposer,
  PreparedWorldBuilder,
  PreparedWorldCompiler,
  exportPreparedWorld,
  restorePreparedWorld,
  type FragmentOperation,
  type ImageProgram,
} from "./index";

const region = { horizontal: 0, vertical: 0 };
const manifest = (side = 32, columns = 1): CookedMapManifest => ({
  pageSize: side,
  regionColumns: columns,
  regionRows: 1,
  regions: [region],
  origin: { x: -33, y: -7 },
});
const equal = (a: PixelBytes, b: PixelBytes) =>
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
function pattern(side: number, shift = 0) {
  return Uint8Array.from({ length: side * side * 4 }, (_, i) =>
    i % 4 === 3
      ? [0, 1, 127, 254, 255][(Math.floor(i / 4) + shift) % 5]
      : (i * 13 + shift * 29) % 256,
  );
}
function reference(
  back: PixelBytes,
  side: number,
  front: PixelBytes,
  srcSide: number,
  x: number,
  y: number,
  operation: FragmentOperation,
  mask?: PixelBytes,
): Uint8Array {
  const out = new Uint8Array(back);
  for (let sy = 0; sy < srcSide; sy++)
    for (let sx = 0; sx < srcSide; sx++) {
      const dx = sx + x,
        dy = sy + y;
      if (dx < 0 || dy < 0 || dx >= side || dy >= side) continue;
      const s = (sy * srcSide + sx) * 4,
        d = (dy * side + dx) * 4;
      if (mask && mask[s + 3] === 0) continue;
      const a = front[s + 3],
        b = out[d + 3];
      if (operation.endsWith("replace") || a === 255 || b === 0) {
        out.set(front.subarray(s, s + 4), d);
        continue;
      }
      if (a === 0) continue;
      const contribution = b * (255 - a),
        alpha = a * 255 + contribution;
      for (let c = 0; c < 3; c++)
        out[d + c] = Math.round(
          (front[s + c] * a * 255 + out[d + c] * contribution) / alpha,
        );
      out[d + 3] = Math.round(alpha / 255);
    }
  return out;
}

describe("final fragment composition", () => {
  it("preserves exact alpha and hidden RGB through quadrant-crossing/clipped ordered placements", () => {
    const store = new SharedPixelStore({ pageSize: 64 }),
      composer = new FragmentComposer(store);
    const back = pattern(64),
      front = pattern(32, 3),
      mask = new Uint8Array(32 * 32 * 4);
    for (let i = 3; i < mask.length; i += 4) mask[i] = (i >> 2) % 3 ? 255 : 0;
    const b = store.addBlock(back, 64),
      f = store.addBlock(front, 32),
      m = store.addBlock(mask, 32);
    for (const op of [
      "replace",
      "over",
      "masked-replace",
      "masked-over",
    ] as const) {
      for (const [x, y] of [
        [0, 0],
        [17, 19],
        [-7, 53],
        [-31, -31],
        [64, 64],
      ]) {
        const masked = op.startsWith("masked-");
        const root = composer.place(
          b,
          64,
          f,
          32,
          x,
          y,
          op,
          masked ? m : undefined,
        );
        equal(
          store.readBlock(root, 64),
          reference(back, 64, front, 32, x, y, op, masked ? mask : undefined),
        );
      }
    }
    const once = composer.place(b, 64, f, 32, 17, 19, "over");
    const twice = composer.place(once, 64, f, 32, 20, 15, "over");
    equal(
      store.readBlock(twice, 64),
      reference(
        reference(back, 64, front, 32, 17, 19, "over"),
        64,
        front,
        32,
        20,
        15,
        "over",
      ),
    );
  });

  it("composes actual material atlas bytes without changing raw transparent colors", () => {
    const base = new URL("../../../", import.meta.url);
    const layout = JSON.parse(
      readFileSync(
        new URL("lib/noita-telescope-vm/data/material_atlas.json", base),
        "utf8",
      ),
    );
    const atlas = readFileSync(
      new URL("lib/noita-telescope-vm/data/material_atlas.bin", base),
    );
    const data = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++)
      data.set(
        atlas.subarray(y * layout.width * 4, (y * layout.width + 64) * 4),
        y * 64 * 4,
      );
    const store = new SharedPixelStore({ pageSize: 64 }),
      composer = new FragmentComposer(store);
    const front = store.addBlock(data, 64),
      back = store.solidBlock([17, 31, 41, 67]);
    const output = composer.combine(back, front, 64, "over");
    equal(
      store.readBlock(output, 64),
      reference(store.readBlock(back, 64), 64, data, 64, 0, 0, "over"),
    );
  });

  it("reuses opaque subtrees and only evaluates intersected small leaves", () => {
    const store = new SharedPixelStore(),
      composer = new FragmentComposer(store);
    const b = store.solidBlock([7, 13, 17, 255]),
      f = store.solidBlock([19, 23, 29, 255]);
    const out = composer.place(b, 512, f, 8, 8, 8, "over");
    expect(composer.stats.leafPixels).toBe(0);
    equal(store.readBlock(out, 512, 8, 8, 8, 8), store.readBlock(f, 8));
    expect(store.stats().nodes).toBeLessThan(10);
    expect(composer.place(b, 512, f, 8, 8, 8, "over")).toBe(out);
  });

  it("accounts for alpha scans and avoids reading background alpha behind opaque pixels", () => {
    const store = new SharedPixelStore({ pageSize: 16, leafSize: 16 });
    const composer = new FragmentComposer(store);
    const front = pattern(16, 3),
      back = pattern(16, 7);
    for (let i = 3; i < front.length; i += 4) front[i] = 255;
    const f = store.addBlock(front, 16),
      b = store.addBlock(back, 16);
    expect(store.inspectNode(f, 16).kind).not.toBe("solid");
    expect(store.inspectNode(b, 16).kind).not.toBe("solid");
    const output = composer.combine(b, f, 16, "over");
    expect(output).toBe(f);
    expect(composer.stats.alphaPixels).toBe(256);
    expect(composer.stats.leafPixels).toBe(0);
    equal(store.readBlock(output, 16), front);
    // The front's cached summary is reusable with a different destination.
    const other = store.addBlock(pattern(16, 11), 16);
    expect(composer.combine(other, f, 16, "over")).toBe(f);
    expect(composer.stats.alphaPixels).toBe(256);
  });

  it("counts alpha-only work while preserving transparent colored source words", () => {
    const store = new SharedPixelStore({ pageSize: 16, leafSize: 16 });
    const composer = new FragmentComposer(store);
    const front = pattern(16, 3),
      back = pattern(16, 7);
    for (let i = 3; i < back.length; i += 4) back[i] = 0;
    const f = store.addBlock(front, 16),
      b = store.addBlock(back, 16);
    const output = composer.combine(b, f, 16, "over");
    expect(output).toBe(f);
    expect(composer.stats.alphaPixels).toBe(512);
    expect(composer.stats.leafPixels).toBe(0);
    equal(
      store.readBlock(output, 16),
      reference(back, 16, front, 16, 0, 0, "over"),
    );
  });

  it("rejects unresolved masks, fractional placement and invalid operations", () => {
    const s = new SharedPixelStore({ pageSize: 16 }),
      c = new FragmentComposer(s);
    const b = s.solidBlock([0, 0, 0, 255]),
      f = s.solidBlock([1, 2, 3, 128]);
    expect(() => c.combine(b, f, 16, "masked-replace", f)).toThrow(
      /fractional/,
    );
    expect(() => c.place(b, 16, f, 16, 0.5, 0, "over")).toThrow(/integer/);
    expect(() => c.combine(b, f, 16, "add" as FragmentOperation)).toThrow(
      /operation/,
    );
    const binary = pattern(8);
    for (let i = 3; i < binary.length; i += 4)
      binary[i] = (i >> 2) % 2 ? 0 : 255;
    const small = s.addBlock(binary, 8);
    c.combine(b, f, 8, "masked-over", small);
    expect(() => c.combine(b, f, 16, "masked-over", small)).toThrow(
      /dimensions/,
    );
  });
});

describe("prepared world compiler", () => {
  it("moves shared-selector composition and all its mip chains into one-time preparation", async () => {
    const s = new SharedPixelStore({ pageSize: 32 }),
      b = new PreparedWorldBuilder(s, "source-v1", manifest());
    const a = pattern(32),
      z = pattern(32, 4);
    const background = s.solidBlock([20, 30, 40, 125]);
    const back = b.prepared(background, 32);
    const choices = [a, z].map((p) => b.prepared(s.addBlock(p, 32), 32));
    const out = b.combine(back, b.select(0, choices), "over");
    b.page(region, 0, 0, out);
    const compiler = b.finish();
    expect(b.stats.lifted).toBe(1);
    for (const selection of [0, 1, 0]) {
      const result = await compiler.compile({
        revision: "source-v1",
        selectors: Uint32Array.of(selection),
        pixels: new Uint32Array(),
      });
      expect(result.composition.leafPixels).toBe(0);
      expect(result.map.store.stats().ownedPages).toBe(0);
      let expected: { data: Uint8Array; width: number; height: number } = {
        data: reference(
          s.readBlock(background, 32),
          32,
          [a, z][selection],
          32,
          0,
          0,
          "over",
        ),
        width: 32,
        height: 32,
      };
      for (let level = 0; level <= 5; level++) {
        equal(
          result.map.readRect(level, 0, 0, expected.width, expected.height),
          expected.data,
        );
        if (level !== 5)
          expected = reduceFinalPixels(
            expected.data,
            expected.width,
            expected.height,
          );
      }
    }
  });

  it("does not multiply independent selector spaces and isolates concurrent seed fragments", async () => {
    const s = new SharedPixelStore({ pageSize: 32 }),
      b = new PreparedWorldBuilder(s, "v1", manifest());
    const a = b.prepared(s.solidBlock([1, 2, 3, 255]), 32),
      z = b.prepared(s.solidBlock([7, 8, 9, 255]), 32);
    const bg = b.select(0, [a, z]),
      fg = b.select(1, [a, z]);
    const chosen = b.combine(bg, fg, "over");
    b.page(region, 0, 0, b.place(chosen, b.bound(0, 8), 5, 6, "over"));
    const compiler = b.finish(),
      before = compiler.baseline.stats();
    const results = await Promise.all(
      [17, 99].map((red) =>
        compiler.compile(async (store) => {
          const fragment = store.solidBlock([red, 55, 61, 255]);
          await Promise.resolve();
          return {
            revision: "v1",
            selectors: Uint32Array.of(0, 1),
            pixels: Uint32Array.of(fragment),
          };
        }),
      ),
    );
    expect(b.stats.deferred).toBe(2);
    expect(compiler.baseline.stats()).toEqual(before);
    expect([...results[0].map.readRect(0, 5, 6, 1, 1)]).toEqual([
      17, 55, 61, 255,
    ]);
    expect([...results[1].map.readRect(0, 5, 6, 1, 1)]).toEqual([
      99, 55, 61, 255,
    ]);
    const reopened = restoreCookedMap(results[0].map.exportSnapshot());
    equal(
      reopened.readRect(0, 0, 0, 32, 32),
      results[0].map.readRect(0, 0, 0, 32, 32),
    );
  });

  it("requires explicit all-nine completion and closes global mips before returning", async () => {
    const s = new SharedPixelStore(),
      b = new PreparedWorldBuilder(s, "all9-fixture", NORMAL_MAP_MANIFEST);
    const color = s.solidBlock([11, 22, 33, 255]),
      p = b.prepared(color, 512);
    for (const r of NORMAL_MAP_MANIFEST.regions)
      for (let y = 0; y < 48; y++)
        for (let x = 0; x < 70; x++) b.page(r, x, y, p);
    const result = await b.finish().compile({
      revision: "all9-fixture",
      selectors: new Uint32Array(),
      pixels: new Uint32Array(),
    });
    expect(result.pages).toBe(30240);
    expect(result.map.ready).toBe(true);
    expect(result.composition.leafPixels).toBe(0);
    expect(result.map.width).toBe(107520);
    const pageGrid = Buffer.alloc(210 * 144 * 4);
    for (let i = 0; i < pageGrid.length; i += 4)
      pageGrid.set([11, 22, 33, 255], i);
    let coarse = { data: pageGrid, width: 210, height: 144 };
    while (coarse.width > 1 || coarse.height > 1)
      coarse = reduce2(coarse.data, coarse.width, coarse.height);
    equal(result.map.readRect(result.map.maxLevel, 0, 0, 1, 1), coarse.data);
  });

  it("reopens the reusable library with completed alternatives and mips, pruning abandoned preparation", async () => {
    const s = new SharedPixelStore({ pageSize: 32 }),
      b = new PreparedWorldBuilder(s, "asset-revision", manifest());
    b.prepared(s.addBlock(pattern(32, 17), 32), 32); // unreachable experiment
    const back = b.prepared(s.solidBlock([47, 31, 17, 255]), 32);
    const choices = [1, 3].map((shift) =>
      b.prepared(s.addBlock(pattern(32, shift), 32), 32),
    );
    b.page(region, 0, 0, b.combine(back, b.select(0, choices), "over"));
    const compiler = b.finish(),
      artifact = exportPreparedWorld(compiler);
    expect(artifact.recipe.programs.length).toBeLessThan(
      compiler.exportRecipe().programs.length,
    );
    const reopened = restorePreparedWorld(
      structuredClone(artifact),
      "asset-revision",
    );
    const decisions = {
      revision: "asset-revision",
      selectors: Uint32Array.of(1),
      pixels: new Uint32Array(),
    };
    const original = await compiler.compile(decisions),
      restored = await reopened.compile(decisions);
    for (let level = 0; level <= 5; level++) {
      const side = 32 >> level;
      equal(
        restored.map.readRect(level, 0, 0, side, side),
        original.map.readRect(level, 0, 0, side, side),
      );
    }
    expect(restored.map.store.stats().ownedPages).toBe(0);
    expect(restored.composition.leafPixels).toBe(0);
    expect(() => restorePreparedWorld(artifact, "old-source")).toThrow(
      /revision/,
    );
  });

  it("fails missing pages/choices/bindings and cancellation without exposing a partial map", async () => {
    const s = new SharedPixelStore({ pageSize: 32 }),
      b = new PreparedWorldBuilder(s, "v1", manifest());
    b.page(region, 0, 0, b.select(0, [b.bound(0, 32)]));
    const c = b.finish(),
      empty = {
        revision: "v1",
        selectors: new Uint32Array(),
        pixels: new Uint32Array(),
      };
    await expect(c.compile(empty)).rejects.toThrow(/selector/);
    await expect(
      c.compile({ ...empty, selectors: Uint32Array.of(0) }),
    ).rejects.toThrow(/pixel binding/);
    await expect(
      c.compile({ ...empty, selectors: [0] as unknown as Uint32Array }),
    ).rejects.toThrow(/Uint32Arrays/);
    await expect(c.compile({ ...empty, revision: "v2" })).rejects.toThrow(
      /revision/,
    );
    const control = new AbortController();
    control.abort();
    await expect(
      c.compile(empty, { signal: control.signal }),
    ).rejects.toThrow();
    const incomplete = new PreparedWorldBuilder(
      new SharedPixelStore({ pageSize: 32 }),
      "v1",
      manifest(32, 2),
    );
    expect(() => incomplete.finish()).toThrow(/omits/);
  });

  it("evaluates thousands of ordered writes without a recursive program stack", async () => {
    const s = new SharedPixelStore({ pageSize: 8 }),
      root = s.solidBlock([31, 47, 61, 255]);
    const programs: ImageProgram[] = [
      { kind: "prepared", side: 8, pixels: root },
    ];
    for (let i = 0; i < 12000; i++)
      programs.push({
        kind: "combine",
        side: 8,
        back: programs.length,
        front: 1,
        operation: "over",
      });
    const c = new PreparedWorldCompiler(s.freezePreparation(), {
      revision: "deep",
      manifest: manifest(8),
      programs,
      pages: [{ region, x: 0, y: 0, program: programs.length }],
    });
    const { map, selectedPrograms } = await c.compile({
      revision: "deep",
      selectors: new Uint32Array(),
      pixels: new Uint32Array(),
    });
    expect(selectedPrograms).toBe(12001);
    expect([...map.readRect(0, 0, 0, 1, 1)]).toEqual([31, 47, 61, 255]);
  });

  it("lets an external abort arrive during a prepared-only compile", async () => {
    const store = new SharedPixelStore({ pageSize: 8 });
    const builder = new PreparedWorldBuilder(store, "cancel", manifest(8));
    builder.page(
      region,
      0,
      0,
      builder.prepared(store.solidBlock([7, 9, 11, 255]), 8),
    );
    const compiler = builder.finish(),
      controller = new AbortController();
    let time = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => (time += 9));
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await expect(
        compiler.compile(
          {
            revision: "cancel",
            selectors: new Uint32Array(),
            pixels: new Uint32Array(),
          },
          { signal: controller.signal },
        ),
      ).rejects.toThrow();
    } finally {
      clearTimeout(timer);
      clock.mockRestore();
    }
  });
});
