import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import JSZip from "jszip";
import { dataArchivesPlugin } from "../build_scripts/vite-data-archives";

const revisions = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock("virtual:noitamap-data-archives", () => ({
  archiveRevisions: revisions,
}));
const base = "https://maps.test/";
let bytes: Uint8Array<ArrayBuffer>;
let stored: Map<string, Response>;
let cache: {
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
let fetcher: ReturnType<typeof vi.fn>;
const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const response = (data = bytes, revision?: string) =>
  new Response(data, {
    headers: revision ? { "X-Archive-Revision": revision } : {},
  });
async function archive(value: string) {
  return new Uint8Array(
    await new JSZip()
      .file("stable.txt", value)
      .generateAsync({ type: "uint8array" }),
  );
}
beforeEach(async () => {
  vi.resetModules();
  bytes = await archive("current pixels");
  for (const key of ["main", "pixel_scenes", "wang_tiles"])
    revisions[key] = hash(bytes);
  stored = new Map();
  cache = {
    match: vi.fn(async (url: string) => stored.get(url)?.clone()),
    put: vi.fn(async (url: string, value: Response) => {
      stored.set(url, value.clone());
    }),
    delete: vi.fn(async (url: string) => stored.delete(url)),
  };
  fetcher = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("caches", { open: vi.fn(async () => cache) });
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("document", { baseURI: base });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("self", { location: new URL(base + "assets/worker.js") });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reuses the current ZIP on reload without network validation or rewriting its bytes", async () => {
  stored.set(base + "data.zip", response(bytes, revisions.main));
  const { getZip } = await import("../src/data-archive");
  const [a, b] = await Promise.all([getZip(), getZip()]);
  expect(a).toBe(b);
  expect(await a!.file("stable.txt")!.async("string")).toBe("current pixels");
  expect(fetcher).not.toHaveBeenCalled();
  expect(cache.put).not.toHaveBeenCalled();
  expect(cache.match).toHaveBeenCalledOnce();
});

it("upgrades matching legacy CacheStorage bytes locally without redownloading", async () => {
  stored.set(base + "data.zip", response());
  const { getZip } = await import("../src/data-archive");
  expect(await getZip()).not.toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(stored.get(base + "data.zip")!.headers.get("X-Archive-Revision")).toBe(
    revisions.main,
  );
});

it("replaces changed content at the same persistent key and gives workers the current archive", async () => {
  const old = await archive("old pixels");
  stored.set(base + "data.zip", response(old, hash(old)));
  const { getZip } = await import("../src/data-archive");
  expect(await (await getZip())!.file("stable.txt")!.async("string")).toBe(
    "current pixels",
  );
  expect(fetcher).toHaveBeenCalledWith(base + "data.zip?v=" + revisions.main);
  expect(stored.size).toBe(1);
  vi.resetModules();
  vi.stubGlobal("document", undefined);
  fetcher.mockClear();
  const worker = await import("../src/data-archive");
  expect(
    await (await worker.getZip())!.file("stable.txt")!.async("string"),
  ).toBe("current pixels");
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps fresh downloads usable when cache access or writes are denied", async () => {
  vi.mocked(caches.open).mockRejectedValueOnce(new Error("denied"));
  let api = await import("../src/data-archive");
  expect(await api.getZip()).not.toBeNull();
  vi.resetModules();
  cache.put.mockRejectedValueOnce(new Error("quota exceeded"));
  api = await import("../src/data-archive");
  expect(await api.getZip()).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("bounds unavailable cache I/O without treating it as an archive failure", async () => {
  vi.useFakeTimers();
  vi.mocked(caches.open).mockImplementationOnce(() => new Promise(() => {}));
  const api = await import("../src/data-archive");
  const ready = api.getZip();
  await vi.advanceTimersByTimeAsync(1501);
  expect(await ready).not.toBeNull();
});

it("does not wait indefinitely for an archive lock held by another tab", async () => {
  vi.useFakeTimers();
  stored.set(base + "data.zip", response(bytes, revisions.main));
  const request = vi.fn(
    (_name, { signal }: { signal: AbortSignal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  vi.stubGlobal("navigator", { locks: { request } });
  const api = await import("../src/data-archive");
  const ready = api.getZip();
  await vi.advanceTimersByTimeAsync(1501);
  expect(await ready).not.toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();
});

it("refetches a corrupt cached ZIP and does not permanently cache a failed deployment response", async () => {
  stored.set(
    base + "data.zip",
    response(new Uint8Array([1, 2, 3]), revisions.main),
  );
  const api = await import("../src/data-archive");
  expect(await api.getZip()).not.toBeNull();
  expect(cache.delete).toHaveBeenCalledWith(base + "data.zip");
  vi.resetModules();
  stored.clear();
  fetcher.mockResolvedValueOnce(
    response(await archive("incorrect deployed content")),
  );
  const next = await import("../src/data-archive");
  expect(await next.getZip()).toBeNull();
  expect(stored.size).toBe(0);
  expect(await next.getZip()).not.toBeNull();
});

it("hashes shipped ZIP content and invalidates the dev manifest when bytes change", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "noitamap-archive-manifest-"));
  try {
    await mkdir(resolve(root, "public"));
    for (const file of ["data.zip", "pixel_scenes.zip", "wang_tiles.zip"])
      await writeFile(resolve(root, "public", file), bytes);
    const plugin = dataArchivesPlugin(root),
      context = { addWatchFile: vi.fn() };
    const load = plugin.load as Function;
    const first = await load.call(context, "\0virtual:noitamap-data-archives");
    expect(first).toContain(revisions.main);
    const replacement = await archive("updated source ZIP");
    await writeFile(resolve(root, "public/data.zip"), replacement);
    const second = await load.call(context, "\0virtual:noitamap-data-archives");
    expect(second).toContain(`"main":"${hash(replacement)}"`);
    expect(second).not.toBe(first);
    const module = {},
      invalidateModule = vi.fn(),
      send = vi.fn();
    (plugin.handleHotUpdate as Function)({
      file: resolve(root, "public/data.zip"),
      server: {
        moduleGraph: { getModuleById: () => module, invalidateModule },
        ws: { send },
      },
    });
    expect(invalidateModule).toHaveBeenCalledWith(module);
    expect(send).toHaveBeenCalledWith({ type: "full-reload", path: "*" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
