import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture() {
  const opened: any = {};
  const read: any = {};
  const transaction: any = {
    objectStore: () => ({ get: () => read, put: vi.fn() }),
    abort: vi.fn(),
  };
  read.transaction = transaction;
  const db = { transaction: () => transaction, close: vi.fn() };
  opened.result = db;
  vi.stubGlobal("indexedDB", { open: () => opened });
  const api = await import("../src/telescope/terrain-tile-store");
  return { api, opened, read, transaction, db };
}

it("continues rendering after a blocked cache open and closes a late connection", async () => {
  const { api, opened, db } = await fixture();
  const result = api.readTerrainTile("tile");
  opened.onblocked();
  await expect(result).resolves.toBeNull();
  opened.onsuccess();
  expect(db.close).toHaveBeenCalled();
});

it("bounds a stalled cache read and aborts its transaction", async () => {
  const { api, opened, transaction } = await fixture();
  const result = api.readTerrainTile("tile");
  opened.onsuccess();
  await vi.advanceTimersByTimeAsync(3001);
  await expect(result).resolves.toBeNull();
  expect(transaction.abort).toHaveBeenCalledOnce();
});

it("does not hang when the browser never calls the PNG encoder callback", async () => {
  const { api, opened } = await fixture();
  const canvas = { toBlob: vi.fn() } as unknown as HTMLCanvasElement;
  const result = api.writeTerrainTile("tile", canvas);
  opened.onsuccess();
  await vi.advanceTimersByTimeAsync(3001);
  await expect(result).resolves.toBeUndefined();
  await api.writeTerrainTile("another tile", canvas);
  expect(canvas.toBlob).toHaveBeenCalledOnce();
});

it("releases a bitmap that finishes decoding after its deadline", async () => {
  const { api, opened, read } = await fixture();
  let decode!: (bitmap: any) => void;
  vi.stubGlobal(
    "createImageBitmap",
    () =>
      new Promise((resolve) => {
        decode = resolve;
      }),
  );
  const result = api.readTerrainTile("tile");
  opened.onsuccess();
  await vi.advanceTimersByTimeAsync(0);
  read.result = new Blob(["png"]);
  read.onsuccess();
  await vi.advanceTimersByTimeAsync(3001);
  await expect(result).resolves.toBeNull();
  const close = vi.fn();
  decode({ close });
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
});
