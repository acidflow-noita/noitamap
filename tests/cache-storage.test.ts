import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {CacheUnavailableError, OptionalCacheDatabase, warnCacheFailure} from "../src/telescope/cache-storage";

// The real blocked-upgrade case is also exercised with two browser tabs.
// These event-driven fakes cover failures that browsers cannot reliably induce
// on demand (storage hangs, forced closes and abort without a request error).
function database() {
  return {close: vi.fn(), onversionchange: null, onclose: null} as any;
}
function request(result: unknown = undefined) {
  return {result, error: null, transaction: {abort: vi.fn()}, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null} as any;
}
function transaction() {
  return {abort: vi.fn(), error: null, oncomplete: null, onerror: null, onabort: null} as any;
}

describe("optional generation cache storage", () => {
  let db: ReturnType<typeof database>;
  let opening: ReturnType<typeof request>;
  let open: ReturnType<typeof vi.fn>;
  let upgrade: ReturnType<typeof vi.fn>;
  let storage: OptionalCacheDatabase;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db = database();
    opening = request(db);
    open = vi.fn(() => opening);
    upgrade = vi.fn();
    vi.stubGlobal("indexedDB", {open});
    storage = new OptionalCacheDatabase("noitamap-test-cache", 12, upgrade, 50);
  });
  afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

  async function ready() {
    const promise = storage.open();
    opening.onsuccess();
    return promise;
  }

  it("coalesces initial opens and reuses one owned connection", async () => {
    const a = storage.open(), b = storage.open();
    expect(a).toBe(b);
    opening.onupgradeneeded({oldVersion: 11});
    expect(upgrade).toHaveBeenCalledWith(db, opening.transaction, 11);
    opening.onsuccess();
    expect(await a).toBe(db);
    expect(await storage.open()).toBe(db);
    expect(open).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("immediately rejects a blocked upgrade instead of waiting for the old tab", async () => {
    const promise = storage.open();
    const rejection = expect(promise).rejects.toMatchObject({reason: "blocked"});
    opening.onblocked();
    await rejection;
    for (let i = 0; i < 10; i++) await expect(storage.open()).rejects.toBeInstanceOf(CacheUnavailableError);
    expect(open).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes an abandoned open after unblocking and allows the upgraded cache to recover", async () => {
    const promise = storage.open();
    const rejection = expect(promise).rejects.toMatchObject({reason: "blocked"});
    opening.onblocked();
    await rejection;
    opening.onupgradeneeded({oldVersion: 11});
    opening.onsuccess();
    expect(db.close).toHaveBeenCalledTimes(1);
    db = database(); opening = request(db);
    expect(await ready()).toBe(db);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("closes on versionchange so this page does not block a newer deployment", async () => {
    await ready();
    db.onversionchange();
    expect(db.close).toHaveBeenCalledTimes(1);
    db = database(); opening = request(db);
    await ready();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("reopens after the browser forcibly closes the connection", async () => {
    await ready();
    db.onclose();
    db = database(); opening = request(db);
    await ready();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("settles open errors and warns once, not once per requested bitmap", async () => {
    const promise = storage.open();
    const rejection = expect(promise).rejects.toMatchObject({reason: "unavailable"});
    opening.error = new Error("storage denied");
    opening.onerror();
    await rejection;
    await expect(storage.open()).rejects.toBeInstanceOf(CacheUnavailableError);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an unresponsive open and closes any late connection", async () => {
    const rejection = expect(storage.open()).rejects.toMatchObject({reason: "timeout"});
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    opening.onsuccess();
    expect(db.close).toHaveBeenCalledTimes(1);
    await expect(storage.open()).rejects.toMatchObject({reason: "timeout"});
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("handles storage being absent or throwing synchronously", async () => {
    open.mockImplementation(() => {throw new Error("SecurityError");});
    await expect(storage.open()).rejects.toMatchObject({reason: "unavailable"});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a successful cache read without disabling the cache", async () => {
    await ready();
    const req = request({seed: 1});
    const promise = storage.read(req);
    req.onsuccess();
    expect(await promise).toEqual({seed: 1});
    expect(await storage.open()).toBe(db);
    expect(db.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles request errors instead of leaving a pending lookup", async () => {
    await ready();
    const req = request();
    const rejection = expect(storage.read(req)).rejects.toMatchObject({reason: "unavailable"});
    req.error = new Error("read failed");
    req.onerror();
    await rejection;
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops waiting for a read queued behind an unrelated long-running transaction", async () => {
    await ready();
    const req = request();
    const rejection = expect(storage.read(req)).rejects.toMatchObject({reason: "timeout"});
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(req.transaction.abort).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("waits for a successful write transaction to actually commit", async () => {
    const tx = transaction();
    const done = vi.fn();
    const promise = storage.complete(tx).then(done);
    expect(done).not.toHaveBeenCalled();
    tx.oncomplete();
    await promise;
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects transaction aborts even when no request error fired", async () => {
    const tx = transaction();
    const rejection = expect(storage.complete(tx)).rejects.toMatchObject({reason: "unavailable"});
    tx.onabort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a stuck write or cache-clear transaction instead of reporting success", async () => {
    const tx = transaction();
    const rejection = expect(storage.complete(tx)).rejects.toMatchObject({reason: "timeout"});
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(tx.abort).toHaveBeenCalledOnce();
  });

  it("keeps unrelated cache errors visible", () => {
    warnCacheFailure("unexpected", new Error("bad serialized entry"));
    expect(console.warn).toHaveBeenCalledWith("unexpected", expect.any(Error));
    warnCacheFailure("already reported", new CacheUnavailableError("blocked", "blocked"));
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
