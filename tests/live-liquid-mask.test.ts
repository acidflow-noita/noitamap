import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
const mocks = vi.hoisted(() => ({ clipping: vi.fn(), materials: vi.fn(), liquidIds: vi.fn() }));
vi.mock("../src/telescope/instant-terrain-backend", () => ({
  getInstantLiquidClipping: mocks.clipping, resolveInstantLiquidMaterials: mocks.materials,
}));
vi.mock("../src/telescope/liquid-surfaces", () => ({ loadLiquidMaterialIds: mocks.liquidIds }));
vi.mock("noita-telescope-full-pixels/engine_resolve/engine_data.js", async () => import("../lib/noita-telescope-vm/js/engine_resolve/engine_data.js"));
vi.mock("noita-telescope-full-pixels/engine_resolve/band_select.js", async () => import("../lib/noita-telescope-vm/js/engine_resolve/band_select.js"));
vi.mock("noita-telescope-full-pixels/generator_config.js", async () => import("../lib/noita-telescope-vm/js/generator_config.js"));

import { createLiveLiquidSource } from "../src/liquids/live-source";
import { liquidMaterialIds } from "../src/liquids/materials";
import { MATERIAL_NAMES_BY_ID, WANG_COLOR_TO_ID } from "../lib/noita-telescope-vm/js/engine_resolve/engine_data.js";
import { createPlaneOwnership, WORLD_HEIGHT, WORLD_TOP } from "../src/telescope/terrain-policy";
import { GENERATOR_CONFIG } from "../lib/noita-telescope-vm/js/generator_config.js";
const material = (name: string) => MATERIAL_NAMES_BY_ID.indexOf(name);
const water = material("water"), lava = material("lava"), blood = material("blood"), rock = material("rock_static_wet");
const B = 256, bounds = { x: -1024, y: WORLD_TOP, width: B, height: B };
let clip: any;
function bytes(fill: number, values: Record<number, number> = {}) {
  const out = new Uint8Array(B * B * 4);
  for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
    const id = values[y * B + x] ?? fill, at = ((B - y - 1) * B + x) * 4, code = id + 1;
    out[at] = code & 255; out[at + 1] = code >>> 8;
    // Display alpha is deliberately irrelevant to this ID-only readback.
  }
  return out;
}
function sceneBytes(ids: (number | null)[]) {
  return new Uint8Array(ids.flatMap(id => {
    if (id === null) return [0, 0, 0, 0];
    const rgb = id === 0 ? 66 : WANG_COLOR_TO_ID.find((entry: number[]) => entry[1] === id)![0];
    return [(rgb >>> 16) & 255, (rgb >>> 8) & 255, rgb & 255, 255];
  }));
}
const scene = (key: string, x: number, y: number, width: number) => ({ key, name: key, x, y, width, height: 1 });
const signal = () => new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => resolve = done);
  return { promise, resolve };
}
beforeAll(async () => {
  const zip = await JSZip.loadAsync(await readFile(new URL("../public/data.zip", import.meta.url)));
  const ids = liquidMaterialIds(await zip.file("data/materials.xml")!.async("string"), MATERIAL_NAMES_BY_ID);
  mocks.liquidIds.mockResolvedValue(ids);
});
beforeEach(() => {
  mocks.clipping.mockReset(); mocks.materials.mockReset();
  clip = { center: 2, owners: [-1, 0, 1].map(() => ({ width: 4, owners: new Int16Array(4 * 48) })), masks: [] };
  mocks.clipping.mockImplementation(async () => clip);
  mocks.materials.mockImplementation(async () => [bytes(0)]);
});

describe("live liquid occupancy from real scene material grids", () => {
  it("flips raw GL rows, decodes both material bytes, and recognizes lava and blood independent of alpha", async () => {
    const high = material("void_liquid");
    expect(high).toBeGreaterThan(255);
    mocks.materials.mockResolvedValue([bytes(0, { 0: lava, 1: rock, 2: blood, 3: -1, 4: high, [B * (B - 1)]: water })]);
    const source = await createLiveLiquidSource({ seed: 55, scenes: [], loadScene: async () => null });
    const mask = new Uint8Array(B * B);
    expect(await source!.paint(bounds, mask, signal())).toBe(true);
    expect([...mask.slice(0, 5)]).toEqual([255, 0, 255, 0, 255]);
    expect(mask[B * (B - 1)]).toBe(255);
    expect(mask.reduce((sum, p) => sum + (p ? 1 : 0), 0)).toBe(4);
    expect(mocks.materials).toHaveBeenCalledWith(55, [{ x0: bounds.x, y0: bounds.y, w: B, h: B }], 0, expect.any(AbortSignal));
  });

  it("clips authored scenes in world coordinates, honoring FORCE AIR, opaque solids and later overrides", async () => {
    mocks.materials.mockResolvedValue([bytes(water)]);
    const sources: Record<string, any> = {
      "general/base": { width: 6, height: 1, imgElement: sceneBytes([rock, rock, 0, rock, lava, null]) },
      "general/later": { width: 2, height: 1, imgElement: new Uint8ClampedArray(sceneBytes([blood, 0])) },
    };
    const loadScene = vi.fn(async (key: string) => sources[key]);
    const source = await createLiveLiquidSource({ seed: 55, scenes: [
      scene("general/base", bounds.x - 2, bounds.y, 6),
      scene("general/later", bounds.x + 1, bounds.y, 2),
      scene("static_tile/captured", bounds.x, bounds.y, 5),
    ], loadScene });
    const mask = new Uint8Array(B * B);
    await source!.paint(bounds, mask, signal());
    expect([...mask.slice(0, 5)]).toEqual([0, 255, 0, 255, 255]);
    expect(loadScene.mock.calls.map(call => call[0])).toEqual(["general/base", "general/later"]);
  });

  it("preserves captured static bits and air reservations from GPU writes, then lets renderable scene materials paint", async () => {
    clip.masks = [{ ...bounds, width: 4, height: 1, bits: new Uint8Array([5]), airBits: new Uint8Array([2]) }];
    mocks.materials.mockResolvedValue([bytes(0)]);
    const source = await createLiveLiquidSource({ seed: 55,
      scenes: [scene("general/rendered", bounds.x + 2, bounds.y, 2)],
      loadScene: async () => ({ width: 2, height: 1, imgElement: sceneBytes([lava, 0]) }) });
    const mask = new Uint8Array(B * B); mask[0] = 255; mask[3] = 255;
    await source!.paint(bounds, mask, signal());
    expect([...mask.slice(0, 4)]).toEqual([255, 0, 255, 0]);
  });

  it("uses the right vertical owner and wraps ownership across horizontal parallel worlds", async () => {
    clip.owners.forEach((owner: any) => owner.owners.fill(-1));
    for (let plane = -1; plane <= 1; plane++) clip.owners[plane + 1].owners[plane + 1] = 0;
    mocks.materials.mockResolvedValue([bytes(lava)]);
    const source = await createLiveLiquidSource({ seed: 55, scenes: [], loadScene: async () => null });
    for (const plane of [-1, 0, 1]) for (const pw of [-1, 0, 1]) {
      const region = { ...bounds, x: -1024 + (plane + 1) * 512 + pw * 2048, y: WORLD_TOP + plane * WORLD_HEIGHT };
      const mask = new Uint8Array(B * B);
      await source!.paint(region, mask, signal());
      expect(mask.every(p => p === 255)).toBe(true);
      expect(mocks.materials.mock.calls.at(-1)!.slice(0, 3)).toEqual([55,
        [{ x0: region.x, y0: region.y, w: B, h: B }], plane]);
    }
    const captured = new Uint8Array(B * B).fill(255), calls = mocks.materials.mock.calls.length;
    await source!.paint({ ...bounds, x: 512 }, captured, signal());
    expect(mocks.materials).toHaveBeenCalledTimes(calls);
    expect(captured.every(p => p === 255)).toBe(true);
  });

  it("does not overwrite captured masks when the backend is absent or unavailable", async () => {
    clip = null;
    expect(await createLiveLiquidSource({ seed: 55, scenes: [], loadScene: async () => null })).toBeNull();
    expect(mocks.materials).not.toHaveBeenCalled();
    clip = { center: 2, owners: [-1, 0, 1].map(() => ({ width: 4, owners: new Int16Array(192) })), masks: [] };
    mocks.materials.mockResolvedValue(null);
    const source = await createLiveLiquidSource({ seed: 55, scenes: [], loadScene: async () => null });
    const captured = new Uint8Array(B * B).fill(255);
    expect(await source!.paint(bounds, captured, signal())).toBe(false);
    expect(captured.every(p => p === 255)).toBe(true);
  });

  it("uses actual terrain ownership to preserve authored fallback lava while querying a real Wang claim", async () => {
    const pixels = new Uint32Array(4 * 48);
    pixels[0] = GENERATOR_CONFIG.coalmine.color;
    pixels[1] = GENERATOR_CONFIG.lava_90percent.color;
    const layers = [
      { biomeName: "coalmine", buffer: new Uint8Array(1), validChunks: new Set(["0,0"]) },
      { biomeName: "lava_90percent", isFill: true, buffer: new Uint8Array(1), validChunks: new Set(["1,0"]) },
    ];
    const owner = createPlaneOwnership(layers, pixels, pixels, GENERATOR_CONFIG, 4);
    expect([...owner.owners.slice(0, 2)]).toEqual([0, -1]);
    clip.owners = [owner, owner, owner];
    mocks.materials.mockResolvedValue([bytes(lava)]);
    const source = await createLiveLiquidSource({ seed: 55, scenes: [], loadScene: async () => null });
    const generated = new Uint8Array(B * B);
    await source!.paint(bounds, generated, signal());
    expect(generated.every(value => value === 255)).toBe(true);
    // Authored lava's exact polygon boundary, already established separately:
    // integer chunk columns >0 and rows >=11. The live query must preserve it.
    const captured = new Uint8Array(B * B);
    for (let row = 11; row < B; row++) captured.fill(255, row * B + 1, (row + 1) * B);
    const before = captured.slice();
    await source!.paint({ ...bounds, x: bounds.x + 512 }, captured, signal());
    expect(captured).toEqual(before);
    expect(mocks.materials).toHaveBeenCalledOnce();
  });

  it("rejects stale GPU replies and never applies them after abort", async () => {
    const reply = deferred<Uint8Array[]>(); mocks.materials.mockReturnValue(reply.promise);
    const source = await createLiveLiquidSource({ seed: 55, scenes: [], loadScene: async () => null });
    const controller = new AbortController(), mask = new Uint8Array(B * B).fill(255);
    const work = source!.paint(bounds, mask, controller.signal);
    const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); reply.resolve([bytes(0)]); await rejected;
    expect(mask.every(p => p === 255)).toBe(true);
    mocks.materials.mockClear();
    await expect(source!.paint(bounds, mask, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.materials).not.toHaveBeenCalled();
  });

  it("does not apply a scene that finishes loading after abort", async () => {
    const reply = deferred<any>(), loadScene = vi.fn(() => reply.promise);
    const source = await createLiveLiquidSource({ seed: 55, scenes: [scene("general/late", bounds.x, bounds.y, 2)], loadScene });
    const controller = new AbortController(), mask = new Uint8Array(B * B);
    const work = source!.paint(bounds, mask, controller.signal);
    const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(loadScene).toHaveBeenCalled());
    controller.abort(); reply.resolve({ width: 2, height: 1, imgElement: sceneBytes([lava, blood]) });
    await rejected; expect(mask.every(p => p === 0)).toBe(true);
  });

  it("rejects unaligned blocks and wrong mask lengths before a GPU query", async () => {
    const source = await createLiveLiquidSource({ seed: 55, scenes: [], loadScene: async () => null });
    for (const [region, size] of [[{ ...bounds, x: bounds.x + 1 }, B * B], [bounds, B * B - 1],
      [{ ...bounds, width: 512 }, 512 * B]] as const)
      await expect(source!.paint(region, new Uint8Array(size), signal())).rejects.toThrow();
    expect(mocks.materials).not.toHaveBeenCalled();
  });
});
