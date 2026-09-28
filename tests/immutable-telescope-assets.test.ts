import { afterEach, expect, it, vi } from "vitest";
import {
  ImmutableTelescopeAssets,
  revisionedAssetUrl,
} from "../src/telescope/immutable-assets";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("versions stable dev URLs without changing inline bytes or fragments", () => {
  expect(revisionedAssetUrl("/data/atlas.bin", "new content")).toBe(
    "/data/atlas.bin?noitamap_revision=new%20content",
  );
  expect(revisionedAssetUrl("/data/atlas.bin?url#fragment", "v2")).toBe(
    "/data/atlas.bin?url&noitamap_revision=v2#fragment",
  );
  expect(revisionedAssetUrl("data:application/json;base64,e30=", "v2")).toBe(
    "data:application/json;base64,e30=",
  );
});

function disk() {
  const records = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (request: Request) => records.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      records.set(request.url, response.clone());
    }),
  };
  const open = vi.fn(async () => cache);
  vi.stubGlobal("caches", { open });
  return { records, cache, open };
}

it("reuses exact immutable bytes across callers, seeds, and fresh module owners", async () => {
  const { records, cache } = disk();
  const bytes = new Uint8Array([0, 255, 81, 0, 3]);
  const download = vi.fn(
    async () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "gzip",
          "Content-Length": "99",
        },
      }),
  );
  const assets = new ImmutableTelescopeAssets();
  const responses = await Promise.all([
    assets.fetch("material-atlas", "content-1", download),
    assets.fetch("material-atlas", "content-1", download),
  ]);
  for (const response of responses) {
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(response.headers.get("Content-Length")).toBe("5");
  }
  const nextSeed = await assets.fetch("material-atlas", "content-1", download);
  expect(new Uint8Array(await nextSeed.arrayBuffer())).toEqual(bytes);
  const reloaded = await new ImmutableTelescopeAssets().fetch(
    "material-atlas",
    "content-1",
    download,
  );
  expect(new Uint8Array(await reloaded.arrayBuffer())).toEqual(bytes);
  expect(download).toHaveBeenCalledOnce();
  expect(cache.put).toHaveBeenCalledOnce();
  expect(records.size).toBe(1);
});

it('allows a temporary worker to await writes without delaying foreground asset delivery', async () => {
  const { cache } = disk();
  let finish!: () => void;
  cache.put.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const assets = new ImmutableTelescopeAssets();
  const response = await assets.fetch('atlas', 'revision', async () => new Response('usable'));
  expect(await response.text()).toBe('usable');
  const flushed = vi.fn();
  const pending = assets.flushWrites().then(flushed);
  await Promise.resolve();
  expect(flushed).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(flushed).toHaveBeenCalledOnce();
});

it("invalidates changed content and replaces the same persistent slot across deployments", async () => {
  const { records } = disk();
  const old = vi.fn(async () => new Response("old"));
  const changed = vi.fn(async () => new Response("new"));
  expect(
    await (
      await new ImmutableTelescopeAssets().fetch("scenes/full", "old-hash", old)
    ).text(),
  ).toBe("old");
  expect(
    await (
      await new ImmutableTelescopeAssets().fetch(
        "scenes/full",
        "new-hash",
        changed,
      )
    ).text(),
  ).toBe("new");
  expect(
    await (
      await new ImmutableTelescopeAssets().fetch(
        "scenes/full",
        "new-hash",
        changed,
      )
    ).text(),
  ).toBe("new");
  expect(changed).toHaveBeenCalledOnce();
  expect(records.size).toBe(1);
  await expect(
    new ImmutableTelescopeAssets().fetch("scenes/full", "", changed),
  ).rejects.toThrow("revision");
});

it.each(["denied", "read-error", "quota", "sync-quota", "write-stall"])(
  "keeps assets usable when optional storage has %s",
  async (failure) => {
    const { cache, open } = disk();
    if (failure === "denied") open.mockRejectedValue(new Error("Denied"));
    if (failure === "read-error")
      cache.match.mockRejectedValue(new Error("Read failed"));
    if (failure === "quota")
      cache.put.mockRejectedValue(new Error("QuotaExceededError"));
    if (failure === "sync-quota")
      cache.put.mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    if (failure === "write-stall")
      cache.put.mockImplementation(() => new Promise(() => {}));
    const assets = new ImmutableTelescopeAssets(1024, 20);
    const download = vi.fn(async () => new Response("usable"));
    expect(await (await assets.fetch("atlas", "v1", download)).text()).toBe(
      "usable",
    );
    expect(await (await assets.fetch("atlas", "v1", download)).text()).toBe(
      "usable",
    );
    expect(download).toHaveBeenCalledOnce();
  },
);

it("bounds a stalled cache read and uses the download instead", async () => {
  vi.useFakeTimers();
  const { cache } = disk();
  cache.match.mockImplementation(() => new Promise(() => {}));
  const download = vi.fn(async () => new Response("ready"));
  const pending = new ImmutableTelescopeAssets(1024, 50).fetch(
    "atlas",
    "v1",
    download,
  );
  await vi.advanceTimersByTimeAsync(50);
  expect(await (await pending).text()).toBe("ready");
  expect(download).toHaveBeenCalledOnce();
});

it("lets an obsolete caller abort without cancelling another seed's shared download", async () => {
  vi.stubGlobal("caches", undefined);
  let finish!: (response: Response) => void;
  const download = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const assets = new ImmutableTelescopeAssets();
  const obsolete = new AbortController();
  const one = assets.fetch("atlas", "v1", download, obsolete.signal);
  const two = assets.fetch("atlas", "v1", download);
  const rejected = expect(one).rejects.toMatchObject({ name: "AbortError" });
  obsolete.abort();
  await rejected;
  finish(new Response("shared"));
  expect(await (await two).text()).toBe("shared");
  expect(download).toHaveBeenCalledOnce();
});

it("observes an abort occurring synchronously while the shared download starts", async () => {
  vi.stubGlobal("caches", undefined);
  const controller = new AbortController();
  const download = vi.fn(async () => {
    controller.abort();
    return new Response("ready");
  });
  const assets = new ImmutableTelescopeAssets();
  await expect(
    assets.fetch("atlas", "v1", download, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await (await assets.fetch("atlas", "v1", download)).text()).toBe(
    "ready",
  );
  expect(download).toHaveBeenCalledOnce();
});

it("bounds response RAM and never remembers errors or HTML fallbacks", async () => {
  vi.stubGlobal("caches", undefined);
  const assets = new ImmutableTelescopeAssets(4);
  const download = vi.fn(async () => new Response("abc"));
  await assets.fetch("one", "v1", download);
  await assets.fetch("two", "v1", download);
  await assets.fetch("one", "v1", download);
  expect(download).toHaveBeenCalledTimes(3);
  const missing = vi.fn(async () => new Response("missing", { status: 404 }));
  expect((await assets.fetch("missing", "v1", missing)).status).toBe(404);
  await assets.fetch("missing", "v1", missing);
  expect(missing).toHaveBeenCalledTimes(2);
  await expect(
    assets.fetch(
      "bad",
      "v1",
      async () =>
        new Response("fallback", { headers: { "Content-Type": "text/html" } }),
    ),
  ).rejects.toThrow("HTML");
  expect(await (await assets.fetch("bad", "v1", download)).text()).toBe("abc");
});
