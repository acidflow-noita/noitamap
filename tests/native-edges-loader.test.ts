import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
const wasm = await readFile(
  new URL("../src/native-map/edges/core.wasm", import.meta.url),
);
const atlas = await readFile(
  new URL("../lib/noita-telescope-vm/data/edge_atlas.bin", import.meta.url),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it("bounds optional readiness and reuses a module delivered later", async () => {
  let deliver!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    deliver = resolve;
  });
  const fetcher = vi.fn((url: string) =>
    String(url).includes("core.wasm")
      ? pending
      : Promise.resolve(new Response(atlas)),
  );
  vi.stubGlobal("fetch", fetcher);
  const { readyNativeEdges } = await import("../src/native-map/edges");
  const start = performance.now();
  expect(await readyNativeEdges()).toBeNull();
  expect(performance.now() - start).toBeLessThan(500);
  deliver(new Response(wasm));
  let native: Awaited<ReturnType<typeof readyNativeEdges>> = null;
  await vi.waitFor(
    async () => {
      native = await readyNativeEdges();
      expect(native?.enabled).toBe(true);
    },
    { timeout: 2000 },
  );
  expect(await readyNativeEdges()).toBe(native);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(native!.memoryBytes).toBe(16 * 1024 * 1024);
});

it("keeps native allocation failure optional and does not retry each terrain", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(String(url).includes("core.wasm") ? wasm : atlas),
    ),
  );
  const instantiate = vi
    .spyOn(WebAssembly, "instantiate")
    .mockRejectedValue(new RangeError("injected memory allocation failure"));
  const { readyNativeEdges } = await import("../src/native-map/edges");
  expect(await readyNativeEdges()).toBeNull();
  expect(await readyNativeEdges()).toBeNull();
  expect(instantiate).toHaveBeenCalledTimes(1);
});

it("keeps missing WASM support and failed delivery on the original path", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("WebAssembly", undefined);
  expect(
    await (await import("../src/native-map/edges")).readyNativeEdges(),
  ).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  expect(
    await (await import("../src/native-map/edges")).readyNativeEdges(),
  ).toBeNull();
});
