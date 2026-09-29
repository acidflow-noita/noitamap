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
  const progress = new Set<() => void>();
  return {
    abort: vi.fn(), error: null, oncomplete: null, onerror: null, onabort: null,
    addEventListener: vi.fn((type: string, listener: () => void, capture: boolean) => {
      if (type === "success" && capture) progress.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void, capture: boolean) => {
      if (type === "success" && capture) progress.delete(listener);
    }),
    succeedRequest() { for (const listener of progress) listener(); },
    progressListeners: progress,
  } as any;
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
    storage = new OptionalCacheDatabase("noitamap-test-cache", 12, upgrade, 50, { idleMs: 50, maxMs: 200 });
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

  it("closes an owner's connection once and rejects future opens without warnings", async () => {
    await ready();
    storage.close();
    storage.close();
    expect(db.close).toHaveBeenCalledOnce();
    await expect(storage.open()).rejects.toMatchObject({message: "Cache owner was disposed"});
    expect(open).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a disposed pending open and closes its late connection without reopening", async () => {
    const rejection = expect(storage.open()).rejects.toMatchObject({message: "Cache owner was disposed"});
    storage.close();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    opening.onupgradeneeded({oldVersion: 11});
    expect(opening.transaction.abort).toHaveBeenCalledOnce();
    expect(upgrade).not.toHaveBeenCalled();
    opening.onsuccess();
    expect(db.close).toHaveBeenCalledOnce();
    await expect(storage.open()).rejects.toMatchObject({message: "Cache owner was disposed"});
    expect(open).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
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
    expect(tx.progressListeners.size).toBe(0);
  });

  it("allows a retained-page batch to commit after the old 1.5-second lookup deadline", async () => {
    const retained = new OptionalCacheDatabase("noitamap-retained-hd", 1, upgrade, 1500);
    const openingPromise = retained.open(); opening.onsuccess(); await openingPromise;
    const tx = transaction(), done = vi.fn();
    const result = retained.complete(tx).then(done);
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).not.toHaveBeenCalled();
    expect(tx.abort).not.toHaveBeenCalled();
    tx.oncomplete(); await result;
    expect(done).toHaveBeenCalledOnce();
    expect(await retained.open()).toBe(db);
    expect(console.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renews the idle deadline on request progress and still waits for commit", async () => {
    await ready();
    const tx = transaction(), done = vi.fn();
    const result = storage.complete(tx).then(done);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(40);
      tx.succeedRequest();
    }
    expect(tx.addEventListener).toHaveBeenCalledWith("success", expect.any(Function), true);
    expect(tx.abort).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    tx.oncomplete(); await result;
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a transaction that stalls after its last successful request", async () => {
    const tx = transaction();
    const rejected = expect(storage.complete(tx)).rejects.toMatchObject({ reason: "timeout", message: "Cache transaction stopped making progress" });
    await vi.advanceTimersByTimeAsync(40);
    tx.succeedRequest();
    await vi.advanceTimersByTimeAsync(49);
    expect(tx.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(tx.abort).toHaveBeenCalledOnce();
    expect(tx.progressListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let continuing request progress extend the absolute write bound", async () => {
    const tx = transaction();
    const rejected = expect(storage.complete(tx)).rejects.toMatchObject({ reason: "timeout", message: "Cache transaction exceeded its write deadline" });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(40);
      tx.succeedRequest();
    }
    await vi.advanceTimersByTimeAsync(40); await rejected;
    expect(tx.abort).toHaveBeenCalledOnce();
    expect(tx.progressListeners.size).toBe(0);
    tx.oncomplete(); tx.succeedRequest();
    expect(vi.getTimerCount()).toBe(0);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("noitamap-test-cache"), expect.anything());
  });

  it("gives a read queued behind this owner's healthy write time to run", async () => {
    await ready();
    const tx = transaction(), req = request("saved pixels");
    const write = storage.complete(tx), read = storage.read(req);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(40);
      tx.succeedRequest();
    }
    expect(db.close).not.toHaveBeenCalled();
    expect(req.transaction.abort).not.toHaveBeenCalled();
    tx.oncomplete(); await write;
    req.onsuccess(); expect(await read).toBe("saved pixels");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps read waits bounded even if new writes continue arriving", async () => {
    const req = request();
    const read = expect(storage.read(req)).rejects.toMatchObject({ reason: "timeout" });
    for (let i = 0; i < 5; i++) {
      const tx = transaction();
      const done = storage.complete(tx);
      await vi.advanceTimersByTimeAsync(40); tx.oncomplete(); await done;
    }
    await read;
    expect(req.transaction.abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a new seed's read wait for the previous owner's final write", async () => {
    await ready();
    const tx = transaction();
    const write = storage.complete(tx);
    storage.close();
    const next = new OptionalCacheDatabase("noitamap-test-cache", 12, upgrade, 50, { idleMs: 50, maxMs: 200 });
    const req = request("reusable native pixels"), read = next.read(req);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(40);
      tx.succeedRequest();
    }
    expect(req.transaction.abort).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    tx.oncomplete(); await write;
    req.onsuccess(); expect(await read).toBe("reusable native pixels");
    // Removing the settled write restores the ordinary short read deadline.
    const stalled = request();
    const rejected = expect(next.read(stalled)).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(50); await rejected;
    expect(stalled.transaction.abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend an unrelated database's read deadline", async () => {
    const tx = transaction(), write = storage.complete(tx);
    const unrelated = new OptionalCacheDatabase("other-cache", 12, upgrade, 50, { idleMs: 50, maxMs: 200 });
    const req = request();
    const rejected = expect(unrelated.read(req)).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(40); tx.succeedRequest();
    await vi.advanceTimersByTimeAsync(10); await rejected;
    tx.oncomplete(); await write;
    expect(req.transaction.abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects quota failures immediately and removes every progress timer", async () => {
    const tx = transaction();
    const rejected = expect(storage.complete(tx)).rejects.toMatchObject({ reason: "unavailable", cause: { name: "QuotaExceededError" } });
    tx.error = new DOMException("Disk quota exceeded", "QuotaExceededError");
    tx.onerror(); await rejected;
    tx.onabort(); tx.succeedRequest();
    expect(vi.getTimerCount()).toBe(0);
    expect(tx.progressListeners.size).toBe(0);
    expect(console.warn).toHaveBeenCalledOnce();
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

/** Exercise the real tile-cache upgrade through its public read/write API.
 * Reads cannot observe stale pixels before a library-version check runs. */
describe("derived terrain cache schema migration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function legacyDatabase(oldVersion: number) {
    const sceneKey = "general/watercave";
    const stale = {
      key: sceneKey, width: 512, height: 512,
      blob: new Blob(["old raw scene"]), timestamp: Date.now(),
    };
    const records = new Map<string, Map<string, any>>([
      ["generations", new Map([["seed", { pixelScenesByPW: { "0,0": [{ height: 512 }] } }]])],
      ["unrelated", new Map([["keep", "unrelated data"]])],
    ]);
    if (oldVersion >= 5) {
      records.set("biome_renders", new Map([["seed|0,0", { blob: new Blob(["old map render"]) }]]));
      records.set("pixel_scene_bitmaps", new Map([[sceneKey, stale]]));
    }
    let version = oldVersion;
    const read = (value: unknown) => {
      const req: any = { result: value };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    };
    const store = (name: string, tx?: any) => {
      const entries = records.get(name);
      if (!entries) throw new Error(`Missing object store ${name}`);
      return {
        clear: () => entries.clear(),
        createIndex: vi.fn(),
        get: (key: string) => read(entries.get(key)),
        put: (entry: any) => {
          entries.set(entry.key, entry);
          queueMicrotask(() => tx?.oncomplete?.());
        },
      };
    };
    const db: any = {
      close: vi.fn(),
      objectStoreNames: { contains: (name: string) => records.has(name) },
      deleteObjectStore: (name: string) => records.delete(name),
      createObjectStore(name: string) {
        if (records.has(name)) throw new Error(`Duplicate object store ${name}`);
        records.set(name, new Map());
        return store(name);
      },
      transaction(name: string) {
        const tx: any = { objectStore: () => store(name, tx) };
        return tx;
      },
    };
    const open = vi.fn((_name: string, requested: number) => {
      const req: any = { result: db, transaction: { objectStore: (name: string) => store(name) } };
      queueMicrotask(() => {
        if (requested > version) {
          req.onupgradeneeded?.({ oldVersion: version });
          version = requested;
        }
        req.onsuccess?.();
      });
      return req;
    });
    vi.stubGlobal("indexedDB", { open });
    return { records, open, stale, sceneKey };
  }

  it.each([4, 8, 11, 12, 13])("removes all stale derived entries when upgrading v%s, then retains corrected scene pixels", async oldVersion => {
    vi.resetModules();
    const fixture = legacyDatabase(oldVersion);
    const { getCachedSceneBitmap, cacheSceneBitmap } = await import("../src/telescope/tile-cache");
    expect(await getCachedSceneBitmap(fixture.sceneKey)).toBeNull();
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith("noitamap-telescope", 15);
    for (const name of ["generations", "biome_renders", "pixel_scene_bitmaps"])
      expect(fixture.records.get(name)?.size, name).toBe(0);
    expect(fixture.records.get("unrelated")?.get("keep")).toBe("unrelated data");

    const pixels = new Blob(["complete spliced scene"]);
    await cacheSceneBitmap(fixture.sceneKey, pixels, 512, 1139);
    expect(await getCachedSceneBitmap(fixture.sceneKey)).toMatchObject({
      blob: pixels, width: 512, height: 1139,
    });
    expect(fixture.open).toHaveBeenCalledOnce();
  });

  it("invalidates raw artwork composites from v14 without discarding generated geometry", async () => {
    vi.resetModules();
    const fixture = legacyDatabase(14);
    const { getCachedSceneBitmap } = await import("../src/telescope/tile-cache");
    expect(await getCachedSceneBitmap(fixture.sceneKey)).toBeNull();
    expect(fixture.records.get("generations")?.size).toBe(1);
    expect(fixture.records.get("biome_renders")?.size).toBe(1);
    expect(fixture.records.get("unrelated")?.get("keep")).toBe("unrelated data");
  });

  it("keeps valid data when opening an already current database", async () => {
    vi.resetModules();
    const fixture = legacyDatabase(15);
    fixture.stale.height = 1139;
    const { getCachedSceneBitmap } = await import("../src/telescope/tile-cache");
    expect(await getCachedSceneBitmap(fixture.sceneKey)).toBe(fixture.stale);
    expect(fixture.records.get("generations")?.size).toBe(1);
    expect(fixture.records.get("biome_renders")?.size).toBe(1);
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith("noitamap-telescope", 15);
  });
});
