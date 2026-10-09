import { describe, expect, it, vi } from "vitest";
import { encodeScenePack, decodeScenePack } from "../src/telescope/scene-pack";
import type { WorkerScenes } from "../src/telescope/worker-scenes";
import { loadSceneInputsOffThread } from "../src/telescope/scene-input-loader";

function fixture(): WorkerScenes {
  const flat = new Uint8Array(4096);
  new Uint32Array(flat.buffer).fill(0x004200ff);
  const noisy = Uint8Array.from(
    { length: 1024 },
    (_, i) => (i * 131 + Math.floor(i / 4)) & 255,
  );
  return {
    version: 1,
    fullPixels: true,
    data: {
      a: {
        imgElement: flat,
        width: 32,
        height: 32,
        variants: {},
        artMask: new Uint8Array([1, 3, 5]),
      },
      b: { imgElement: flat.slice(), width: 32, height: 32, variants: {} },
      c: {
        imgElement: noisy,
        width: 16,
        height: 16,
        variants: {},
        alpha: new Uint8ClampedArray([5, 6, 7, 0]),
      },
    },
    spawns: {
      a: [{ x: 2, y: 3, sourceBiome: "coalmine", spawnFunctionIndex: 4 }],
      b: [],
      c: [],
    },
  };
}

describe("prepared seed-independent scene format", () => {
  it("preserves every RGBA byte/type, metadata and spawn while reducing flat masks and sharing duplicates", () => {
    const original = fixture(),
      packed = encodeScenePack(original, "revision");
    const decoded = decodeScenePack(packed.buffer as ArrayBuffer, "revision");
    expect(decoded).toEqual(original);
    expect(decoded.data.a.imgElement).toBe(decoded.data.b.imgElement);
    expect(decoded.data.c.alpha).toBeInstanceOf(Uint8ClampedArray);
    expect(packed.length).toBeLessThan(4000);
  });

  it("rejects a stale source revision, damaged header and truncated pack", () => {
    const packed = encodeScenePack(fixture(), "revision");
    expect(() =>
      decodeScenePack(packed.buffer as ArrayBuffer, "older"),
    ).toThrow("provenance");
    expect(() =>
      decodeScenePack(packed.slice(0, -1).buffer, "revision"),
    ).toThrow("header");
    packed[0] ^= 1;
    expect(() =>
      decodeScenePack(packed.buffer as ArrayBuffer, "revision"),
    ).toThrow("header");
  });

  it("rejects corrupt RLE counts instead of returning partially initialized pixels", () => {
    const packed = encodeScenePack(fixture(), "revision"),
      header = new DataView(packed.buffer);
    const offset = 12 + header.getUint32(4, true);
    header.setUint32(offset, 0xffffffff, true);
    expect(() =>
      decodeScenePack(packed.buffer as ArrayBuffer, "revision"),
    ).toThrow("exceeds");
  });

  it("preserves exact scenes when Worker construction is denied", async () => {
    const original = fixture(),
      pack = encodeScenePack(original, "revision");
    const decoded = await loadSceneInputsOffThread(
      pack.buffer as ArrayBuffer,
      pack.byteLength,
      "revision",
      () => {
        throw new Error("Worker denied");
      },
    );
    expect(decoded).toEqual(original);
  });

  it("terminates failed workers once and keeps source bytes intact for fallback", async () => {
    const original = fixture(),
      pack = encodeScenePack(original, "revision"),
      saved = pack.slice();
    const worker: any = {
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
      postMessage(data: any, transfers: any[]) {
        expect(data.compressed).not.toBe(pack.buffer);
        expect(transfers).toEqual([data.compressed]);
        queueMicrotask(() => {
          worker.onmessage({ data: { error: "worker crashed" } });
          worker.onerror({ message: "duplicate error", preventDefault() {} });
        });
      },
    };
    expect(
      await loadSceneInputsOffThread(
        pack.buffer as ArrayBuffer,
        pack.byteLength,
        "revision",
        () => worker,
      ),
    ).toEqual(original);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pack).toEqual(saved);
  });

  it("falls back when a worker response cannot be deserialized", async () => {
    const original = fixture(),
      pack = encodeScenePack(original, "revision");
    const worker: any = {
      terminate: vi.fn(),
      postMessage() {
        queueMicrotask(() => worker.onmessageerror({}));
      },
    };
    expect(
      await loadSceneInputsOffThread(
        pack.buffer as ArrayBuffer,
        pack.byteLength,
        "revision",
        () => worker,
      ),
    ).toEqual(original);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
