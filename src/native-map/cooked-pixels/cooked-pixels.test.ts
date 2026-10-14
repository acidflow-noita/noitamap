import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { reduce2 } from "../../../build_scripts/terrain-pyramid.mjs";
import {
  CookedMapBuilder,
  NORMAL_MAP_MANIFEST,
  SharedPixelStore,
  restoreCookedMap,
  restorePixelStore,
  type CookedMapManifest,
  type PixelBytes,
  type PixelStoreSnapshot,
  type RGBA,
} from "./index";
import { reduceFinalPixels } from "./mip";

const region = { horizontal: 0, vertical: 0 };
const bytesEqual = (actual: PixelBytes, expected: PixelBytes) =>
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);

function pixels(
  width: number,
  height: number,
  color: (x: number, y: number) => RGBA,
): Uint8Array {
  const result = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      result.set(color(x, y), (y * width + x) * 4);
  return result;
}

function manifest(
  pageSize = 8,
  regionColumns = 3,
  regionRows = 5,
): CookedMapManifest {
  return {
    pageSize,
    regionColumns,
    regionRows,
    regions: [region],
    origin: { x: -11, y: 7 },
  };
}

function rect(
  source: PixelBytes,
  stride: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++)
    out.set(
      source.subarray(
        ((y + row) * stride + x) * 4,
        ((y + row) * stride + x + width) * 4,
      ),
      row * width * 4,
    );
  return out;
}

function checkPage(
  store: SharedPixelStore,
  data: PixelBytes,
  page = store.addPage(data),
): void {
  let expected = {
    data: Buffer.from(data),
    width: store.pageSize,
    height: store.pageSize,
  };
  for (let level = 0; ; level++) {
    bytesEqual(
      store.readRect(page, level, 0, 0, expected.width, expected.height),
      expected.data,
    );
    if (expected.width === 1) break;
    expected = reduce2(expected.data, expected.width, expected.height);
  }
}

describe("shared final-pixel nodes", () => {
  it("round trips solids, palette leaves, literal leaves, child branches and arbitrary rectangles", () => {
    const store = new SharedPixelStore({ pageSize: 32, leafSize: 8 });
    const data = pixels(32, 32, (x, y) =>
      x < 16 && y < 16
        ? [8, 9, 10, 255]
        : x >= 16 && y < 16
          ? [x % 2 ? 17 : 19, 30, 40, 173]
          : [(x * 19 + y * 3) & 255, x, y, (x * 7 + y * 13) & 255],
    );
    const id = store.addPage(data);
    checkPage(store, data, id);
    bytesEqual(
      store.readRect(id, 0, 5, 7, 23, 19),
      rect(data, 32, 5, 7, 23, 19),
    );
    expect(store.stats()).toMatchObject({ pages: 1 });
    expect(store.stats().solids).toBeGreaterThan(0);
    expect(store.stats().palettes).toBeGreaterThan(0);
    expect(store.stats().literals).toBeGreaterThan(0);
    expect(store.stats().branches).toBeGreaterThan(0);
  });

  it("interns exact finished content across pages and independently sealed maps", () => {
    const store = new SharedPixelStore({ pageSize: 16 });
    const data = pixels(16, 16, (x, y) => [
      x & 1 ? 7 : 11,
      y & 1 ? 13 : 17,
      0,
      255,
    ]);
    const page = store.addPage(data),
      before = store.stats();
    expect(store.addPage(new Uint8Array(data))).toBe(page);
    const make = () =>
      new CookedMapBuilder(store, manifest(16, 1, 1))
        .put(region, 0, 0, page)
        .seal();
    const first = make(),
      second = make();
    expect(first.page(region, 0, 0)).toBe(second.page(region, 0, 0));
    expect(store.stats()).toEqual(before);
  });

  it("does not merge distinct literal blocks when their 32-bit content hashes collide", () => {
    // Two independently found FNV-1a collisions; equality must still compare RGBA.
    const a = Buffer.from("c941de3e4705fc47d36cd5fc65113116", "hex");
    const b = Buffer.from("cde18d218a5fa360f84fa8f4532313d4", "hex");
    const store = new SharedPixelStore({ pageSize: 2 });
    const idA = store.addPage(a),
      idB = store.addPage(b);
    expect(idA).not.toBe(idB);
    checkPage(store, a, idA);
    checkPage(store, b, idB);
    expect(store.addPage(a)).toBe(idA);
    expect(store.addPage(b)).toBe(idB);
  });

  it("keeps native hidden RGB and applies reference transparent-alpha mip semantics", () => {
    const store = new SharedPixelStore();
    const id = store.solidPage([23, 61, 47, 0]);
    expect([...store.readRect(id, 0, 211, 19, 1, 1)]).toEqual([23, 61, 47, 0]);
    for (let level = 1; level <= 9; level++)
      expect([...store.readRect(id, level, 0, 0, 1, 1)]).toEqual([0, 0, 0, 0]);
    expect(store.stats()).toMatchObject({
      nodes: 2,
      solids: 2,
      literals: 0,
      palettes: 0,
      branches: 0,
      nodePayloadBytes: 8,
    });
  });

  it("commits explicit solid pages without native RGBA allocation", () => {
    const store = new SharedPixelStore();
    const id = store.solidPage([31, 51, 71, 93]);
    expect(store.stats()).toMatchObject({
      nodes: 1,
      nodePayloadBytes: 4,
      pages: 1,
    });
    for (let level = 0; level <= 9; level++)
      expect([...store.readRect(id, level, 0, 0, 1, 1)]).toEqual([
        31, 51, 71, 93,
      ]);
    expect(store.solidPage([31, 51, 71, 93])).toBe(id);
  });

  it("commits a prepared fragment hierarchy and shares it with equivalent finished bytes", () => {
    const store = new SharedPixelStore();
    const tile = pixels(8, 8, (x, y) => [(x & 1) * 40, (y & 1) * 60, 91, 127]);
    let root = store.addBlock(tile, 8);
    for (let side = 16; side <= 512; side *= 2)
      root = store.joinBlocks(side, [root, root, root, root]);
    const page = store.commitPage(root),
      before = store.stats();
    expect(before.nodePayloadBytes).toBeLessThan(2000);
    const expected = pixels(512, 512, (x, y) => [
      (x & 1) * 40,
      (y & 1) * 60,
      91,
      127,
    ]);
    expect(store.addPage(expected)).toBe(page);
    expect(store.stats()).toEqual(before);
    checkPage(store, expected, page);
  });

  it("canonicalizes small joined leaves and handles one-pixel leaves", () => {
    for (const leafSize of [1, 2, 8]) {
      const store = new SharedPixelStore({ pageSize: 8, leafSize });
      const colors: RGBA[] = [
        [10, 20, 30, 255],
        [21, 31, 41, 0],
        [45, 55, 65, 17],
        [81, 91, 101, 223],
      ];
      const roots = colors.map((c) => store.solidBlock(c)) as [
        number,
        number,
        number,
        number,
      ];
      const quad = store.joinBlocks(2, roots);
      const full = pixels(8, 8, (x, y) => colors[(y % 2) * 2 + (x % 2)]);
      const next = store.joinBlocks(4, [quad, quad, quad, quad]);
      const page = store.commitPage(
        store.joinBlocks(8, [next, next, next, next]),
      );
      expect(store.addPage(full)).toBe(page);
      checkPage(store, full, page);
    }
  });

  it("owns input, inspection and read buffers while retaining exact immutable pixels", () => {
    const store = new SharedPixelStore({ pageSize: 8 });
    const input = pixels(8, 8, (x, y) => [x, y, 23, 255]),
      expected = input.slice();
    const page = store.addPage(input),
      root = store.decoder().pageRoot(page);
    input.fill(0);
    const description = store.inspectNode(root, 8);
    if (description.kind === "literal") description.bytes.fill(0);
    if (description.kind === "palette") {
      description.colors.fill(0);
      description.indices.fill(0);
    }
    store.readRect(page, 0, 0, 0, 8, 8).fill(0);
    bytesEqual(store.readRect(page, 0, 0, 0, 8, 8), expected);
    const solid = store.inspectNode(store.solidBlock([1, 2, 3, 4]), 8);
    expect(solid.kind === "solid" && solid.rgba).toEqual([1, 2, 3, 4]);
  });

  it("rejects absent references, incomplete RGBA, invalid node sizes and invalid rectangles", () => {
    const store = new SharedPixelStore({ pageSize: 8 });
    const page = store.solidPage([0, 0, 0, 0]);
    expect(() => store.readRect(0, 0, 0, 0, 1, 1)).toThrow("Missing");
    expect(() => store.readRect(page, 4, 0, 0, 1, 1)).toThrow("mip level");
    expect(() => store.readRect(page, 0, 7, 0, 2, 1)).toThrow("outside");
    expect(() => store.addPage(new Uint8Array(16))).toThrow("complete RGBA");
    expect(() => store.solidPage([1, 2, 3, 256])).toThrow("RGBA");
    expect(() =>
      store.commitPage(
        store.addBlock(
          pixels(2, 2, (x) => [x, 0, 0, 255]),
          2,
        ),
      ),
    ).toThrow("dimensions");
    expect(() => new SharedPixelStore({ pageSize: 7 })).toThrow("power of two");
    expect(store.readRect(page, 0, 8, 8, 0, 0)).toHaveLength(0);
  });
});

describe("exact final-pixel mip reduction", () => {
  it("matches the premultiplied reference with odd edges, fractional alpha and hidden colors", () => {
    for (const [width, height] of [
      [1, 1],
      [1, 9],
      [9, 1],
      [7, 5],
      [8, 8],
      [33, 17],
    ]) {
      const input = pixels(width, height, (x, y) => [
        (x * 29 + y * 19) & 255,
        (x * 71) & 255,
        (y * 53) & 255,
        [0, 1, 17, 128, 254, 255][(x + 2 * y) % 6],
      ]);
      const actual = reduceFinalPixels(input, width, height),
        expected = reduce2(input, width, height);
      expect([actual.width, actual.height]).toEqual([
        expected.width,
        expected.height,
      ]);
      bytesEqual(actual.data, expected.data);
    }
    const opaque = Uint8Array.from([
      0, 0, 0, 255, 1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255,
    ]);
    expect([...reduceFinalPixels(opaque, 2, 2).data]).toEqual([2, 2, 2, 255]);
  });

  it("round trips three real captured 512-square page cores at every local mip", async () => {
    const store = new SharedPixelStore();
    for (const name of ["left", "middle", "right"]) {
      const path = fileURLToPath(
        new URL(
          `../../../tests/fixtures/captured-gold/${name}.webp`,
          import.meta.url,
        ),
      );
      const data = await sharp(path)
        .extract({ left: 2, top: 2, width: 512, height: 512 })
        .ensureAlpha()
        .raw()
        .toBuffer();
      checkPage(store, data);
    }
    expect(store.stats().pages).toBeGreaterThan(0);
  });
});

describe("complete cooked-map seal", () => {
  it("requires every one of the normal map's 30,240 explicit pages", () => {
    const store = new SharedPixelStore(),
      empty = store.solidPage([0, 0, 0, 0]);
    const builder = new CookedMapBuilder(store);
    expect(builder.expectedPages).toBe(30240);
    const last = { horizontal: 1, vertical: 1 };
    for (const r of NORMAL_MAP_MANIFEST.regions)
      for (let y = 0; y < 48; y++)
        for (let x = 0; x < 70; x++) {
          if (r.horizontal === 1 && r.vertical === 1 && x === 69 && y === 47)
            continue;
          builder.put(r, x, y, empty);
        }
    expect(builder.missingPages).toBe(1);
    expect(() => builder.seal()).toThrow("region (1,1), page (69,47)");
    builder.put(last, 69, 47, empty);
    const map = builder.seal();
    expect(map.ready).toBe(true);
    expect([map.width, map.height, map.pageCount]).toEqual([
      107520, 73728, 30240,
    ]);
    expect(map.manifest.origin).toEqual({ x: -53760, y: -31744 });
    expect(map.pageReferenceBytes).toBe(120960);
    expect(map.mipReferenceBytes).toBe(32);
    expect([...map.readRect(map.maxLevel, 0, 0, 1, 1)]).toEqual([0, 0, 0, 0]);
    expect(builder.seal()).toBe(map);
    expect(() => builder.put(last, 69, 47, empty)).toThrow("already sealed");
  });

  it("does not treat an entirely missing declared region as transparent air", () => {
    const store = new SharedPixelStore({ pageSize: 2 }),
      id = store.solidPage([0, 0, 0, 0]);
    const builder = new CookedMapBuilder(store, {
      ...manifest(2, 1, 1),
      regions: NORMAL_MAP_MANIFEST.regions,
    });
    builder.put(region, 0, 0, id);
    expect(builder.missingPages).toBe(8);
    expect(() => builder.seal()).toThrow("8 missing pages");
  });

  it("matches whole-image reduction at all local and cross-page levels, including odd tail dimensions", () => {
    const store = new SharedPixelStore({ pageSize: 8 }),
      shape = manifest();
    const input = pixels(24, 40, (x, y) => [
      (x * 23 + y * 19) & 255,
      (x * 13) & 255,
      (y * 3) & 255,
      [0, 1, 17, 128, 255][(x + y) % 5],
    ]);
    const builder = new CookedMapBuilder(store, shape);
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++)
        builder.put(
          region,
          x,
          y,
          store.addPage(rect(input, 24, x * 8, y * 8, 8, 8)),
        );
    const map = builder.seal();
    let expected = { data: Buffer.from(input), width: 24, height: 40 };
    for (let level = 0; level <= map.maxLevel; level++) {
      expect(map.levelSize(level)).toEqual({
        width: expected.width,
        height: expected.height,
      });
      bytesEqual(
        map.readRect(level, 0, 0, expected.width, expected.height),
        expected.data,
      );
      expected = reduce2(expected.data, expected.width, expected.height);
    }
    bytesEqual(map.readRect(0, 5, 7, 14, 22), rect(input, 24, 5, 7, 14, 22));
    expect(() => map.readRect(0, 24, 0, 1, 1)).toThrow("outside");
  });

  it("places all nine regions by coordinates, independent of manifest/commit order", () => {
    const store = new SharedPixelStore({ pageSize: 2 });
    const shape = {
      ...manifest(2, 1, 1),
      regions: [...NORMAL_MAP_MANIFEST.regions].reverse(),
    };
    const builder = new CookedMapBuilder(store, shape);
    for (const r of shape.regions)
      builder.put(
        r,
        0,
        0,
        store.solidPage([r.horizontal + 1, r.vertical + 1, 3, 255]),
      );
    const map = builder.seal();
    const expected = pixels(6, 6, (x, y) => [
      Math.floor(x / 2),
      Math.floor(y / 2),
      3,
      255,
    ]);
    bytesEqual(map.readRect(0, 0, 0, 6, 6), expected);
  });

  it("rejects holes, duplicates, out-of-range writes, invalid IDs and conflicting final pages", () => {
    const store = new SharedPixelStore({ pageSize: 8 }),
      id = store.solidPage([0, 0, 0, 0]);
    expect(
      () =>
        new CookedMapBuilder(store, {
          ...manifest(),
          regions: [region, region],
        }),
    ).toThrow("Duplicate");
    expect(
      () =>
        new CookedMapBuilder(store, {
          ...manifest(),
          regions: [region, { horizontal: 2, vertical: 0 }],
        }),
    ).toThrow("missing regions");
    const builder = new CookedMapBuilder(store, manifest(8, 1, 1));
    expect(() => builder.put({ horizontal: 1, vertical: 0 }, 0, 0, id)).toThrow(
      "Region",
    );
    expect(() => builder.put(region, 1, 0, id)).toThrow("Page");
    expect(() => builder.put(region, 0, 0, 0)).toThrow("Missing");
    builder.put(region, 0, 0, id).put(region, 0, 0, id);
    expect(builder.completedPages).toBe(1);
    expect(() =>
      builder.put(region, 0, 0, store.solidPage([1, 0, 0, 0])),
    ).toThrow("already committed");
  });
});

describe("finished-pixel persistence boundary", () => {
  it("preserves original node/page/image IDs when valid snapshot tables use a different root traversal order", () => {
    const red = pixels(2, 2, () => [31, 0, 0, 255]);
    const input: PixelStoreSnapshot = {
      format: "noitamap-final-pixels",
      version: 1,
      pageSize: 2,
      leafSize: 2,
      nodes: [
        { kind: "solid", color: 0xff00001f },
        { kind: "solid", color: 0xff470000 },
        { kind: "literal", side: 2, bytes: red },
      ],
      pages: [
        [2, 2],
        [3, 1],
      ],
      images: [
        { width: 4, height: 4, root: 2 },
        { width: 8, height: 8, root: 1 },
      ],
    };
    const reader = restorePixelStore(input),
      copied = reader.copySnapshot();
    expect(copied.pages).toEqual(input.pages);
    expect(copied.images).toEqual(input.images);
    expect(copied.nodes).toEqual(input.nodes);
    const store = SharedPixelStore.fromSnapshot(input);
    expect(store.decoder().pageRoot(1)).toBe(2);
    expect(store.decoder().pageRoot(2)).toBe(3);
    expect(store.imageBlock(1)).toEqual({ root: 2, side: 4 });
    expect(store.imageBlock(2)).toEqual({ root: 1, side: 8 });
    expect([...store.readBlock(1, 8, 0, 0, 1, 1)]).toEqual([31, 0, 0, 255]);
    expect([...store.readBlock(2, 4, 0, 0, 1, 1)]).toEqual([0, 0, 71, 255]);
    bytesEqual(store.readRect(2, 0, 0, 0, 2, 2), red);
    (
      copied.nodes[2] as Extract<
        (typeof copied.nodes)[number],
        { kind: "literal" }
      >
    ).bytes.fill(0);
    bytesEqual(reader.decoder.readRect(2, 0, 0, 0, 2, 2), red);
    bytesEqual(store.readRect(2, 0, 0, 0, 2, 2), red);
  });
  it("exports only reachable nodes and restores detached, reusable final pixels", () => {
    const store = new SharedPixelStore({ pageSize: 16 });
    const used = pixels(16, 16, (x, y) => [x & 1, y & 1, 33, 192]);
    const page = store.addPage(used);
    store.addPage(pixels(16, 16, (x, y) => [x * 13, y * 11, 109, 231]));
    const map = new CookedMapBuilder(store, manifest(16, 1, 1))
      .put(region, 0, 0, page)
      .seal();
    const snapshot = map.exportSnapshot();
    expect(snapshot.pixels.pages).toHaveLength(1);
    expect(snapshot.pixels.nodes.length).toBeLessThan(store.stats().nodes);
    const restored = restoreCookedMap(structuredClone(snapshot));
    checkPage(restored.store, used, restored.page(region, 0, 0));
    const before = restored.store.stats();
    expect(restored.store.addPage(used)).toBe(restored.page(region, 0, 0));
    expect(restored.store.stats()).toEqual(before);
    for (const node of snapshot.pixels.nodes)
      if (node.kind === "palette") node.colors.fill(0);
    snapshot.pageRefs.fill(0);
    bytesEqual(map.readRect(0, 0, 0, 16, 16), used);
    bytesEqual(restored.readRect(0, 0, 0, 16, 16), used);
  });

  it("restores a multi-page map including every independently retained global mip", () => {
    const store = new SharedPixelStore({ pageSize: 4 });
    const builder = new CookedMapBuilder(store, manifest(4, 3, 5));
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++)
        builder.put(
          region,
          x,
          y,
          store.solidPage([x * 23, y * 29, 111, (x * 51 + y * 19) & 255]),
        );
    const map = builder.seal(),
      restored = restoreCookedMap(structuredClone(map.exportSnapshot()));
    for (let level = 0; level <= map.maxLevel; level++) {
      const { width, height } = map.levelSize(level);
      bytesEqual(
        restored.readRect(level, 0, 0, width, height),
        map.readRect(level, 0, 0, width, height),
      );
    }
    const snapshot = map.exportSnapshot();
    expect(() =>
      restoreCookedMap({
        ...snapshot,
        upperMipRefs: snapshot.upperMipRefs.slice(1),
      }),
    ).toThrow("Incomplete");
    snapshot.pageRefs[0] = 0;
    expect(() => restoreCookedMap(snapshot)).toThrow("Missing");
  });

  it("validates node payloads, complete mip lists, dimensions and forward/missing references", () => {
    const store = new SharedPixelStore({ pageSize: 16 });
    const page = store.addPage(pixels(16, 16, (x, y) => [x, y, x + y, 255]));
    const original = store.exportSnapshot([page]).store;
    const mutate = (change: (value: any) => void) => {
      const snapshot = structuredClone(original);
      change(snapshot);
      expect(() => restorePixelStore(snapshot)).toThrow();
    };
    mutate((s) => {
      s.version = 99;
    });
    mutate((s) => {
      s.pages[0].pop();
    });
    mutate((s) => {
      s.pages[0][0] = 0;
    });
    mutate((s) => {
      s.pages[0][0] = s.pages[0].at(-1);
    });
    mutate((s) => {
      const n = s.nodes.find((v: any) => v.kind === "branch");
      n.children[0] = s.nodes.length + 1;
    });
    mutate((s) => {
      const n = s.nodes.find((v: any) => v.kind === "literal");
      n.bytes = n.bytes.slice(1);
    });
    mutate((s) => {
      s.nodes.push({ kind: "solid", color: 7 });
    });
    const badPalette: PixelStoreSnapshot = {
      format: "noitamap-final-pixels",
      version: 1,
      pageSize: 2,
      leafSize: 2,
      nodes: [
        {
          kind: "palette",
          side: 2,
          bits: 2,
          colors: new Uint32Array([0, 1]),
          indices: new Uint8Array([255]),
        },
        { kind: "solid", color: 0 },
      ],
      pages: [[1, 2]],
      images: [],
    };
    expect(() => restorePixelStore(badPalette)).toThrow("index out of bounds");
  });

  it("keeps decoding independent of preparation, reduction, persistence and generation modules", () => {
    const code = readFileSync(new URL("./decoder.ts", import.meta.url), "utf8");
    const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(["./format"]);
    const store = new SharedPixelStore({ pageSize: 8 });
    const page = store.solidPage([19, 29, 39, 49]);
    const selection = store.exportSnapshot([page]);
    const restored = restorePixelStore(selection.store);
    expect([
      ...restored.decoder.readRect(selection.pageRefs[0], 3, 0, 0, 1, 1),
    ]).toEqual([19, 29, 39, 49]);
  });
});

describe("immutable preparation baselines", () => {
  it("releases seed-only indexes after complete sealing while preserving old maps and shared preparation", () => {
    const prepared = new SharedPixelStore({ pageSize: 8 });
    prepared.solidPage([0, 0, 0, 0]);
    const baseline = prepared.freezePreparation(),
      sharedBefore = baseline.stats();
    const fork = baseline.fork(),
      page = fork.solidPage([31, 51, 71, 193]);
    const builder = new CookedMapBuilder(fork, manifest(8, 2, 1));
    builder.put(region, 0, 0, page);
    expect(() => builder.seal()).toThrow("missing pages");
    expect(fork.stats().ownedInternEntries).toBeGreaterThan(0);
    builder.put(region, 1, 0, page);
    const map = builder.seal();
    expect(fork.stats().ownedInternEntries).toBe(0);
    expect(() => fork.solidBlock([1, 2, 3, 4])).toThrow(
      "display pixels are immutable",
    );
    expect(() => fork.freezePreparation()).toThrow("Display pixels");
    expect(() => prepared.freezeForDisplay()).toThrow("shared indexes");
    expect(baseline.stats()).toEqual(sharedBefore);
    const restored = restoreCookedMap(map.exportSnapshot());
    restored.store.freezeForDisplay();
    bytesEqual(restored.readRect(0, 0, 0, 16, 8), map.readRect(0, 0, 0, 16, 8));
    expect(restored.store.stats().ownedInternEntries).toBe(0);
    const next = baseline.fork();
    expect(next.solidPage([0, 0, 0, 0])).toBe(1);
    expect(next.stats().ownedNodes).toBe(0);
  });
  it("exports prepared fragment roots and explicitly committed page mips together", () => {
    const store = new SharedPixelStore({ pageSize: 8 });
    const data = pixels(8, 8, (x, y) => [x * 21, y * 31, 59, (x + y) * 17]);
    const root = store.addBlock(data, 8),
      page = store.commitPage(root);
    store.solidPage([11, 13, 17, 19]);
    const baseline = store.freezePreparation();
    const exported = baseline.exportBlocks([{ root, side: 8 }], [page, page]);
    expect(exported.store.pages).toHaveLength(1);
    expect([...exported.pageRefs]).toEqual([1, 1]);
    const restored = SharedPixelStore.fromSnapshot(exported.store);
    const block = restored.imageBlock(exported.imageRefs[0]);
    expect(block.root).toBe(restored.decoder().pageRoot(exported.pageRefs[0]));
    const before = restored.stats();
    expect(restored.commitPage(block.root)).toBe(exported.pageRefs[0]);
    expect(restored.stats()).toEqual(before);
    checkPage(restored, data, exported.pageRefs[0]);
  });
  it("shares prepared nodes, pages, images and interning indexes without copying them into a fork", () => {
    const prepared = new SharedPixelStore({ pageSize: 16 });
    const input = pixels(16, 16, (x, y) => [x * 13, y * 11, 23, 193]);
    const page = prepared.addPage(input);
    const image = prepared.addImage(rect(input, 16, 0, 0, 7, 9), 7, 9);
    const root = prepared.decoder().pageRoot(page);
    const baseline = prepared.freezePreparation(),
      before = baseline.stats();
    expect(prepared.freezePreparation()).toBe(baseline);
    const fork = baseline.fork();
    expect(fork.stats()).toMatchObject({
      sharedNodes: before.nodes,
      sharedPages: before.pages,
      sharedImages: before.images,
      sharedNodePayloadBytes: before.nodePayloadBytes,
      sharedPageReferenceBytes: before.pageReferenceBytes,
      ownedNodes: 0,
      ownedPages: 0,
      ownedImages: 0,
      ownedNodePayloadBytes: 0,
      ownedPageReferenceBytes: 0,
      ownedInternEntries: 0,
    });
    expect(fork.addBlock(input, 16)).toBe(root);
    expect(fork.addPage(input)).toBe(page);
    expect(fork.addImage(rect(input, 16, 0, 0, 7, 9), 7, 9)).toBe(image);
    expect(fork.stats().ownedInternEntries).toBe(0);
    expect(fork.stats().ownedNodePayloadBytes).toBe(0);
    bytesEqual(fork.readRect(page, 0, 0, 0, 16, 16), input);
    expect(baseline.stats()).toEqual(before);
  });

  it("bounds private seed content across repeated cooks and keeps older maps valid", () => {
    const prepared = new SharedPixelStore();
    prepared.solidPage([0, 0, 0, 0]);
    const baseline = prepared.freezePreparation(),
      before = baseline.stats();
    let first: ReturnType<CookedMapBuilder["seal"]> | undefined;
    let latest: ReturnType<CookedMapBuilder["seal"]> | undefined;
    for (let seed = 1; seed <= 64; seed++) {
      const fork = baseline.fork();
      const page = fork.solidPage([seed, 71, 93, 255]);
      const map = new CookedMapBuilder(fork, manifest(512, 1, 1))
        .put(region, 0, 0, page)
        .seal();
      first ??= map;
      latest = map;
      expect(fork.stats()).toMatchObject({
        ownedNodes: 1,
        ownedPages: 1,
        ownedImages: 0,
        ownedNodePayloadBytes: 4,
        ownedPageReferenceBytes: 40,
        ownedInternEntries: 0,
      });
      expect(baseline.stats()).toEqual(before);
    }
    expect([...first!.readRect(0, 0, 0, 1, 1)]).toEqual([1, 71, 93, 255]);
    expect([...latest!.readRect(0, 0, 0, 1, 1)]).toEqual([64, 71, 93, 255]);
    expect(first!.store).not.toBe(latest!.store);
    // The API never accumulates forks under the baseline. Retaining a map keeps
    // only that map's private store plus the one shared baseline alive.
    expect(baseline.fork().stats().ownedNodes).toBe(0);
  });

  it("forbids changing a baseline or building a chain of previous seed stores", () => {
    const prepared = new SharedPixelStore({ pageSize: 8 });
    const id = prepared.solidPage([0, 0, 0, 0]);
    const root = prepared.decoder().pageRoot(id),
      baseline = prepared.freezePreparation();
    expect(() => prepared.solidPage([0, 0, 0, 0])).toThrow(
      "baseline is immutable",
    );
    expect(() => prepared.addBlock(new Uint8Array(4), 1)).toThrow(
      "baseline is immutable",
    );
    expect(() => prepared.joinBlocks(8, [root, root, root, root])).toThrow(
      "baseline is immutable",
    );
    expect(() => prepared.commitPage(root)).toThrow("baseline is immutable");
    expect(() => prepared.addImage(new Uint8Array(4), 1, 1)).toThrow(
      "baseline is immutable",
    );
    expect(() => baseline.fork().freezePreparation()).toThrow(
      "seed fork cannot",
    );
    expect(() => new SharedPixelStore({}, new SharedPixelStore())).toThrow(
      "immutable preparation baseline",
    );
    expect([...prepared.readRect(id, 0, 0, 0, 1, 1)]).toEqual([0, 0, 0, 0]);
  });

  it("exports a fork's reachable shared/private content and restores its complete map", () => {
    const prepared = new SharedPixelStore({ pageSize: 8 });
    const shared = prepared.addBlock(
      pixels(8, 8, (x, y) => [x, y, 51, 133]),
      8,
    );
    prepared.addBlock(
      pixels(8, 8, (x, y) => [x * 29, y * 31, 97, 255]),
      8,
    );
    const fork = prepared.freezePreparation().fork();
    const builder = new CookedMapBuilder(fork, manifest(8, 3, 1));
    builder.put(region, 0, 0, fork.commitPage(shared));
    builder.put(region, 1, 0, fork.solidPage([19, 29, 39, 127]));
    builder.put(region, 2, 0, fork.commitPage(shared));
    const map = builder.seal(),
      snapshot = map.exportSnapshot(),
      restored = restoreCookedMap(snapshot);
    expect(snapshot.pixels.nodes.length).toBeLessThan(fork.stats().nodes);
    for (let level = 0; level <= map.maxLevel; level++) {
      const { width, height } = map.levelSize(level);
      bytesEqual(
        restored.readRect(level, 0, 0, width, height),
        map.readRect(level, 0, 0, width, height),
      );
    }
  });

  it("exports arbitrary prepared roots without inventing pages or retaining unused fragments", () => {
    const prepared = new SharedPixelStore({ pageSize: 16 });
    const input = pixels(4, 4, (x, y) => [x * 11, y * 13, 59, 173]);
    const small = prepared.addBlock(input, 4);
    let large = small;
    for (let side = 8; side <= 32; side *= 2)
      large = prepared.joinBlocks(side, [large, large, large, large]);
    prepared.solidBlock([83, 89, 97, 101]);
    const baseline = prepared.freezePreparation(),
      before = baseline.stats();
    const exported = baseline.exportBlocks([
      { root: small, side: 4 },
      { root: large, side: 32 },
      { root: small, side: 4 },
    ]);
    expect(exported.store.pages).toHaveLength(0);
    expect(exported.store.images).toHaveLength(2);
    expect([...exported.imageRefs]).toEqual([1, 2, 1]);
    expect(exported.store.nodes.length).toBeLessThan(before.nodes);
    expect(baseline.stats()).toEqual(before);
    const restored = SharedPixelStore.fromSnapshot(exported.store);
    const block = restored.imageBlock(exported.imageRefs[0]);
    expect(block.side).toBe(4);
    bytesEqual(restored.readBlock(block.root, block.side), input);
    const big = restored.imageBlock(exported.imageRefs[1]);
    bytesEqual(
      restored.readBlock(big.root, big.side),
      prepared.readBlock(large, 32),
    );
    const seed = restored.freezePreparation().fork();
    expect(seed.addBlock(input, 4)).toBe(block.root);
    expect(seed.stats().ownedNodes).toBe(0);
  });
});
