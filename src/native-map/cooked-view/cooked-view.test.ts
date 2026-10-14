import { describe, expect, it } from "vitest";
import {
  CookedMapBuilder,
  SharedPixelStore,
  restoreCookedMap,
} from "../cooked-pixels";
import {
  exportPreparedWorld,
  restorePreparedWorld,
} from "../prepared-world/artifact";
import { PreparedWorldCompiler } from "../prepared-world/compiler";
import { CookedTileService } from "./service";
import {
  decodeMapRecord,
  encodeMapRecord,
  type PreparedLibraryRecord,
} from "./records";
import { CookedMapStorage } from "./storage";
import { MemoryIndexedDB } from "./memory-idb.test-helper";

const region = { horizontal: 0, vertical: 0 };
const manifest = {
  pageSize: 8,
  regionColumns: 3,
  regionRows: 2,
  regions: [region],
  origin: { x: -17, y: -23 },
};
const equal = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
function mapFixture(color = 31) {
  const store = new SharedPixelStore({ pageSize: 8 }),
    builder = new CookedMapBuilder(store, manifest);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 3; x++)
      builder.put(region, x, y, store.solidPage([color + x, 51 + y, 71, 193]));
  return builder.seal();
}
async function preparedFixture() {
  const store = new SharedPixelStore({ pageSize: 8 });
  const first = store.solidBlock([17, 31, 53, 255]),
    second = store.solidBlock([91, 73, 59, 127]);
  const compiler = new PreparedWorldCompiler(store.freezePreparation(), {
    revision: "fixture-assets-v1",
    manifest,
    programs: [
      { kind: "prepared", side: 8, pixels: first },
      { kind: "prepared", side: 8, pixels: second },
      { kind: "select", side: 8, selector: 0, choices: [1, 2] },
    ],
    pages: Array.from({ length: 6 }, (_, i) => ({
      region,
      x: i % 3,
      y: Math.floor(i / 3),
      program: 3,
    })),
  });
  const artifact = exportPreparedWorld(compiler);
  const compiled = await compiler.compile(() => ({
    revision: "fixture-assets-v1",
    selectors: new Uint32Array([1]),
    pixels: new Uint32Array(),
  }));
  return { artifact, map: compiled.map };
}

describe("sealed map tile service", () => {
  it("maps every OSD level to exact completed local/global mips including overlap and edge shapes", () => {
    const map = mapFixture(),
      service = new CookedTileService(map, { tileSize: 5, overlap: 2 });
    for (let level = 0; level <= map.maxLevel; level++) {
      const size = map.levelSize(map.maxLevel - level);
      for (let y = 0; y < Math.ceil(size.height / 5); y++)
        for (let x = 0; x < Math.ceil(size.width / 5); x++) {
          const tile = service.read({ level, x, y });
          equal(
            tile.rgba,
            map.readRect(
              map.maxLevel - level,
              tile.left,
              tile.top,
              tile.width,
              tile.height,
            ),
          );
          expect(tile.width).toBeLessThanOrEqual(9);
          expect(tile.height).toBeLessThanOrEqual(9);
        }
    }
    expect(service.read({ level: 0, x: 0, y: 0 })).toMatchObject({
      width: 1,
      height: 1,
      nativeLevel: map.maxLevel,
    });
    expect(service.bounds({ level: map.maxLevel, x: 4, y: 3 })).toMatchObject({
      left: 18,
      top: 13,
      width: 6,
      height: 3,
    });
  });
  it("rejects unfinished maps and invalid addresses, and replies with transferable detached bytes", () => {
    expect(
      () =>
        new CookedTileService(
          new CookedMapBuilder(
            new SharedPixelStore({ pageSize: 8 }),
            manifest,
          ) as never,
        ),
    ).toThrow("sealed complete");
    const service = new CookedTileService(mapFixture());
    expect(service.exists({ level: -1, x: 0, y: 0 })).toBe(false);
    expect(service.exists({ level: 0, x: 1, y: 0 })).toBe(false);
    const reply = service.handleMessage({ id: 7, level: 0, x: 0, y: 0 });
    expect(reply.ok).toBe(true);
    if (!reply.ok) throw new Error(reply.error);
    const received = structuredClone(reply, {
      transfer: [reply.tile.rgba.buffer],
    });
    expect(reply.tile.rgba.byteLength).toBe(0);
    expect(received.tile.rgba.byteLength).toBe(4);
    expect(service.read({ level: 0, x: 0, y: 0 }).rgba.byteLength).toBe(4);
    expect(
      service.handleMessage({ id: 8, level: 999, x: 0, y: 0 }),
    ).toMatchObject({ id: 8, ok: false });
  });
});

describe("completed map records and real prepared-library sharing", () => {
  it("stores shared nodes once without changing completed pixels or recipe metadata", async () => {
    const { artifact, map } = await preparedFixture();
    const library: PreparedLibraryRecord = {
      format: "noitamap-prepared-library",
      version: 1,
      key: "library-v1",
      artifact,
    };
    const encoded = encodeMapRecord("seed-a", map.exportSnapshot(), library);
    expect(encoded.sharedNodes).toBeGreaterThan(0);
    expect(encoded.record.nodes.length).toBeLessThan(
      map.exportSnapshot().pixels.nodes.length,
    );
    expect(
      encoded.record.pages.some((roots) => roots.some((id) => id < 0)),
    ).toBe(true);
    const reopened = restoreCookedMap(decodeMapRecord(encoded.record, library));
    for (let level = 0; level <= map.maxLevel; level++) {
      const { width, height } = map.levelSize(level);
      equal(
        reopened.readRect(level, 0, 0, width, height),
        map.readRect(level, 0, 0, width, height),
      );
    }
    expect(library.artifact.recipe.revision).toBe("fixture-assets-v1");
    expect(() => decodeMapRecord(encoded.record)).toThrow("Missing");
    const invalid = structuredClone(encoded.record) as any;
    invalid.pages[0][0] = -99999;
    expect(() => decodeMapRecord(invalid, library)).toThrow("reference");
  });
});

describe("atomic completed map IndexedDB storage", () => {
  it("saves/reopens a complete map and the versioned prepared recipe across connections", async () => {
    const backend = new MemoryIndexedDB(),
      first = new CookedMapStorage({
        indexedDB: backend.factory(),
        name: "roundtrip",
      });
    const { artifact, map } = await preparedFixture();
    await first.saveLibrary("assets-v1", artifact);
    const accounting = await first.saveMap("seed-a", map, {
      libraryKey: "assets-v1",
    });
    expect(accounting.sharedNodes).toBeGreaterThan(0);
    first.close();
    const second = new CookedMapStorage({
      indexedDB: backend.factory(),
      name: "roundtrip",
    });
    const reopened = await second.openMap("seed-a");
    expect(reopened?.ready).toBe(true);
    equal(reopened!.readRect(0, 0, 0, 24, 16), map.readRect(0, 0, 0, 24, 16));
    const library = await second.openLibrary("assets-v1");
    expect(library).toEqual(artifact);
    const compiler = restorePreparedWorld(library!, "fixture-assets-v1");
    const cooked = await compiler.compile(() => ({
      revision: "fixture-assets-v1",
      selectors: new Uint32Array([0]),
      pixels: new Uint32Array(),
    }));
    expect([...cooked.map.readRect(0, 0, 0, 1, 1)]).toEqual([17, 31, 53, 255]);
    await second.saveMap("seed-b", cooked.map, { libraryKey: "assets-v1" });
    expect(backend.databases.get("roundtrip")!.get("libraries")!.size).toBe(1);
    expect(backend.databases.get("roundtrip")!.get("maps")!.size).toBe(2);
    expect(backend.durability).toContain("strict");
    expect(await second.openMap("absent")).toBeNull();
    await second.deleteMap("seed-a");
    expect(await second.openMap("seed-a")).toBeNull();
    second.close();
  });
  it("snapshots mutable caller artifacts before awaiting storage and bounds a stalled open", async () => {
    const backend = new MemoryIndexedDB(),
      storage = new CookedMapStorage({
        indexedDB: backend.factory(),
        name: "owned-input",
      });
    const { artifact } = await preparedFixture();
    const saving = storage.saveLibrary("assets-v1", artifact);
    (artifact.recipe as { revision: string }).revision =
      "changed-after-save-started";
    await saving;
    expect((await storage.openLibrary("assets-v1"))!.recipe.revision).toBe(
      "fixture-assets-v1",
    );
    storage.close();
    const stalled = new CookedMapStorage({
      indexedDB: { open: () => ({}) } as unknown as IDBFactory,
      timeoutMs: 5,
    });
    await expect(stalled.openMap("map")).rejects.toMatchObject({
      code: "timeout",
    });
    stalled.close();
  });
  it("waits for commit and preserves the previous complete map on quota failure", async () => {
    const backend = new MemoryIndexedDB(),
      storage = new CookedMapStorage({
        indexedDB: backend.factory(),
        name: "atomic",
      });
    const before = mapFixture(10),
      after = mapFixture(90);
    await storage.saveMap("same-key", before);
    backend.failNextCommit = "QuotaExceededError";
    await expect(storage.saveMap("same-key", after)).rejects.toMatchObject({
      code: "quota",
    });
    const actual = await storage.openMap("same-key");
    equal(actual!.readRect(0, 0, 0, 24, 16), before.readRect(0, 0, 0, 24, 16));
    await storage.saveMap("same-key", after);
    equal(
      (await storage.openMap("same-key"))!.readRect(0, 0, 0, 24, 16),
      after.readRect(0, 0, 0, 24, 16),
    );
    storage.close();
  });
  it("reports unavailable/blocked storage, missing libraries, immutable key conflicts and corrupt snapshots", async () => {
    const unavailable = new CookedMapStorage();
    await expect(unavailable.openMap("a")).rejects.toMatchObject({
      code: "unavailable",
    });
    const backend = new MemoryIndexedDB();
    backend.blocked = true;
    const blocked = new CookedMapStorage({
      indexedDB: backend.factory(),
      name: "blocked",
    });
    await expect(blocked.openMap("a")).rejects.toMatchObject({
      code: "blocked",
    });
    blocked.close();
    backend.blocked = false;
    const storage = new CookedMapStorage({
        indexedDB: backend.factory(),
        name: "failures",
      }),
      { artifact, map } = await preparedFixture();
    await expect(
      storage.saveMap("a", map, { libraryKey: "unknown" }),
    ).rejects.toMatchObject({ code: "missing-library" });
    await storage.saveLibrary("assets", artifact);
    await expect(storage.saveLibrary("assets", artifact)).rejects.toMatchObject(
      { code: "conflict" },
    );
    await storage.saveMap("a", map, { libraryKey: "assets" });
    const tables = backend.databases.get("failures")!;
    (tables.get("maps")!.get("a") as any).pageRefs[0] = 0;
    await expect(storage.openMap("a")).rejects.toMatchObject({
      code: "corrupt",
    });
    await storage.saveMap("a", map, { libraryKey: "assets" });
    tables.get("libraries")!.delete("assets");
    await expect(storage.openMap("a")).rejects.toMatchObject({
      code: "missing-library",
    });
    storage.close();
    await expect(storage.openMap("a")).rejects.toMatchObject({
      code: "closed",
    });
  });
});
