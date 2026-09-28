import { expect, it } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkerRetentionCodec } from "../src/telescope/retained-terrain-codec";

it("runs the production retention codec in an isolated worker with real transferable buffers", async () => {
  const root = resolve(import.meta.dirname, ".."),
    directory = await mkdtemp(resolve(tmpdir(), "noitamap-retained-codec-"));
  let codec: WorkerRetentionCodec | undefined,
    stopped: Promise<number> | undefined;
  try {
    await build({
      configFile: false,
      logLevel: "error",
      publicDir: false,
      build: {
        outDir: directory,
        rollupOptions: {
          input: resolve(
            root,
            "src/telescope/retained-terrain-codec-worker.ts",
          ),
          output: { entryFileNames: "codec.js", manualChunks: () => undefined },
        },
      },
    });
    const worker = new Worker(
      resolve(root, "tests/helpers/retained-terrain-codec-worker.mjs"),
      {
        workerData: { entry: resolve(directory, "codec.js") },
      },
    );
    const adapter = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage(message: unknown, transfer: Transferable[]) {
        worker.postMessage(message, transfer as any);
      },
      terminate() {
        stopped = worker.terminate();
      },
    };
    worker.on("message", (data) =>
      adapter.onmessage?.({ data } as MessageEvent),
    );
    worker.on("error", (error) =>
      adapter.onerror?.({
        message: error instanceof Error ? error.message : String(error),
      } as ErrorEvent),
    );
    codec = new WorkerRetentionCodec(() => adapter);
    const pixels = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < pixels.length; i++)
      pixels[i] = (i * 37 + (i >> 10)) & 255;
    const input = {
      width: 256,
      height: 256,
      pixels,
      columns: 1,
      rows: 1,
      coverage: new Uint8Array([1]),
    };
    const expected = pixels.slice();
    const encoded = await codec.encode([input]);
    expect(encoded[0].encoding).toBe("png-rgba-v1");
    expect(encoded[0].data.byteLength).toBeLessThan(pixels.byteLength);
    const decoded = await codec.decode(encoded[0]);
    expect(decoded.pixels).toEqual(expected);
    expect(input.pixels).toEqual(expected);
    expect(encoded[0].data.byteLength).toBeGreaterThan(0);
  } finally {
    codec?.dispose();
    await stopped;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
