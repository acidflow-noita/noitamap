import { afterEach, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  encodeTerrainPages,
  decodeTerrainPage,
} from "../src/telescope/retained-terrain-codec-core";
import {
  WorkerRetentionCodec,
  type EncodedTerrain,
} from "../src/telescope/retained-terrain-codec";
import {
  IndexedTerrainRetentionStore,
  RetainedTerrain,
  type StoredTerrain,
} from "../src/telescope/retained-terrain";

const page = (width = 256, height = 256): StoredTerrain => ({
  width,
  height,
  pixels: new Uint8ClampedArray(width * height * 4),
  columns: 1,
  rows: 1,
  coverage: new Uint8Array([1]),
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("round-trips every RGBA byte, including fractional alpha and hidden RGB, without canvas conversion", () => {
  const input = page();
  for (let i = 0; i < input.pixels.length; i += 4) {
    input.pixels[i] = (i / 4) & 255;
    input.pixels[i + 1] = (i >> 8) & 255;
    input.pixels[i + 2] = (i * 37) & 255;
    input.pixels[i + 3] = (i / 4) % 5 === 0 ? 0 : (i / 4) & 255;
  }
  input.columns = input.rows = 4;
  input.coverage = new Uint8Array([0x33, 0x80]);
  const encoded = encodeTerrainPages([input])[0];
  expect(encoded.encoding).toBe("png-rgba-v1");
  expect(encoded.data.byteLength).toBeLessThan(input.pixels.byteLength);
  expect(decodeTerrainPage(encoded)).toEqual(input);
});

it.each([
  [0, 0, 0, 0],
  [17, 23, 89, 0],
  [60, 70, 80, 255],
])("stores constant RGBA %j exactly in four bytes", (...rgba) => {
  const input = page(143, 91);
  for (let i = 0; i < input.pixels.length; i += 4) input.pixels.set(rgba, i);
  const encoded = encodeTerrainPages([input])[0];
  expect(encoded.encoding).toBe("constant-rgba-v1");
  expect([...encoded.data]).toEqual(rgba);
  expect(decodeTerrainPage(encoded)).toEqual(input);
});

it("rejects oversized batches and corrupt encoded dimensions before allocating decoded pages", async () => {
  expect(() =>
    encodeTerrainPages(Array.from({ length: 17 }, () => page())),
  ).toThrow("4 MiB");
  const input = page();
  input.pixels[0] = 1;
  const encoded = encodeTerrainPages([input])[0];
  new DataView(encoded.data.buffer, encoded.data.byteOffset).setUint32(
    16,
    100000,
  );
  expect(() => decodeTerrainPage(encoded)).toThrow("dimensions changed");
  const factory = vi.fn();
  await expect(
    new WorkerRetentionCodec(factory).encode(
      Array.from({ length: 17 }, () => page()),
    ),
  ).rejects.toThrow("4 MiB");
  expect(factory).not.toHaveBeenCalled();
});

it("serializes worker operations, transfers owned bytes, and closes the codec on disposal", async () => {
  const sent: any[] = [];
  const worker = {
    onmessage: null as any,
    onerror: null as any,
    postMessage: vi.fn((message: any) => sent.push(message)),
    terminate: vi.fn(),
  };
  const codec = new WorkerRetentionCodec(() => worker);
  const input = page(),
    expected = input.pixels.slice();
  const first = codec.encode([input]),
    second = codec.encode([input]);
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  expect(sent[0].pages[0].pixels.buffer).not.toBe(input.pixels.buffer);
  expect(input.pixels).toEqual(expected);
  const encoded = encodeTerrainPages(sent[0].pages);
  worker.onmessage({ data: { id: sent[0].id, pages: encoded } });
  await first;
  await Promise.resolve();
  expect(sent).toHaveLength(2);
  const rejected = expect(second).rejects.toThrow("disposed");
  codec.dispose();
  await rejected;
  expect(worker.terminate).toHaveBeenCalledOnce();
});

function database() {
  const records = new Map<string, StoredTerrain | EncodedTerrain>();
  const db: any = {
    close() {},
    createObjectStore() {},
    transaction() {
      const tx: any = {
        abort() {
          tx.onabort?.();
        },
        objectStore() {
          return {
            get(key: string) {
              const request: any = { transaction: tx };
              queueMicrotask(() => {
                request.result = structuredClone(records.get(key));
                request.onsuccess?.();
              });
              return request;
            },
            put(value: StoredTerrain | EncodedTerrain, key: string) {
              records.set(key, structuredClone(value));
            },
          };
        },
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", {
    open() {
      const request: any = { result: db };
      queueMicrotask(() => {
        request.onupgradeneeded?.({ oldVersion: 0 });
        request.onsuccess?.();
      });
      return request;
    },
  });
  return records;
}

it("writes compressed pages, reads raw v1 records, and checks coverage without decoding or creating canvases", async () => {
  const records = database();
  const codec = {
    encode: vi.fn(async (pages: StoredTerrain[]) => encodeTerrainPages(pages)),
    decode: vi.fn(async (value: EncodedTerrain) => decodeTerrainPage(value)),
  };
  const store = new IndexedTerrainRetentionStore(100, codec);
  const raw = page();
  raw.pixels[0] = 25;
  records.set("old", raw);
  expect(await store.read("old")).toEqual(raw);
  expect(codec.decode).not.toHaveBeenCalled();
  await store.write([{ key: "seed/10/0/0", value: raw }]);
  expect(records.get("seed/10/0/0")).toHaveProperty("encoding", "png-rgba-v1");
  const create = vi.fn(() => createCanvas(1, 1));
  vi.stubGlobal("document", { createElement: create });
  const owner = new RetainedTerrain(store),
    region = owner.region("seed", 1024, 1024);
  expect(await region.contains({ level: 10, x: 0, y: 0 })).toBe(true);
  expect(owner.stats.pages).toBe(0);
  expect(create).not.toHaveBeenCalled();
  expect(codec.decode).not.toHaveBeenCalled();
  expect(await store.read("seed/10/0/0")).toEqual(raw);
  expect(codec.decode).toHaveBeenCalledOnce();
  owner.dispose();
});

it("coalesces coverage checks, distinguishes partial coverage, and stops persistence after a failed check", async () => {
  let finish!: (
    value: Pick<StoredTerrain, "columns" | "rows" | "coverage"> | undefined,
  ) => void;
  const store = {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => {}),
    readCoverage: vi.fn(
      () =>
        new Promise<
          Pick<StoredTerrain, "columns" | "rows" | "coverage"> | undefined
        >((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const owner = new RetainedTerrain(store),
    region = owner.region("seed", 1024, 1024);
  const one = region.contains({ level: 9, x: 0, y: 0 }),
    two = region.contains({ level: 9, x: 0, y: 0 });
  expect(store.readCoverage).toHaveBeenCalledOnce();
  finish({ columns: 2, rows: 2, coverage: new Uint8Array([7]) });
  expect(await one).toBe(false);
  expect(await two).toBe(false);
  const absent = region.contains({ level: 10, x: 3, y: 3 });
  finish(undefined);
  expect(await absent).toBe(false);
  expect(await region.contains({ level: 10, x: 3, y: 3 })).toBe(false);
  expect(store.readCoverage).toHaveBeenCalledTimes(2);
  store.readCoverage.mockRejectedValueOnce(new Error("Storage unavailable"));
  expect(await region.contains({ level: 10, x: 2, y: 2 })).toBe(false);
  expect(owner.stats.persistent).toBe(false);
  expect(store.read).not.toHaveBeenCalled();
  owner.dispose();
});

it("keeps concurrent checks of different cells in one ancestor independent", async () => {
  const finish: ((value: any) => void)[] = [];
  const store = {
    read: vi.fn(async () => undefined), write: vi.fn(async () => {}),
    readCoverage: vi.fn(() => new Promise<any>(resolve => { finish.push(resolve); })),
  };
  const owner = new RetainedTerrain(store), region = owner.region('seed', 1024, 1024);
  const tile = { level: 8, x: 0, y: 0 };
  const left = { x: 0, y: 0, width: 2, height: 2 }, right = { ...left, x: 2 };
  const checks = [region.contains(tile, left), region.contains(tile, right), region.contains(tile, left)];
  expect(store.readCoverage).toHaveBeenCalledTimes(2);
  for (const resolve of finish) resolve({ columns: 4, rows: 4, coverage: new Uint8Array([0x33, 0]) });
  expect(await Promise.all(checks)).toEqual([true, false, true]);
  expect(store.read).not.toHaveBeenCalled();
  expect(owner.stats.pages).toBe(0);
  owner.dispose();
});
