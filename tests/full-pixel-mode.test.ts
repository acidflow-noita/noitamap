import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isGLTerrainEnabled,
  setFullPixelTerrainForBake,
  shouldUseBakedTerrain,
} from "../src/renderer_settings";
import { telescopeCacheKey } from "../src/telescope/cache-identity";
import {
  serializeTileLayer,
  restoreTileLayer,
} from "../src/telescope/tile-layer-cache";
import { fullPixelDataUrl } from "../src/telescope/full-pixel-data";
import { loadTelescopeModules } from "../src/telescope/load-telescope";
import { loadWorkerTelescopeModules } from "../src/telescope/load-worker-telescope";

vi.mock("../src/telescope/telescope-exports", () => ({ fork: "legacy" }));
vi.mock("../src/telescope/full-pixel-telescope-exports", () => ({
  fork: "full",
}));
vi.mock("../src/telescope/worker-telescope-exports", () => ({
  fork: "legacy-worker",
}));
vi.mock("../src/telescope/full-pixel-worker-exports", () => ({
  fork: "full-worker",
}));
afterEach(() => {
  setFullPixelTerrainForBake(false);
  vi.unstubAllGlobals();
});

describe("full-pixel mode", () => {
  it("defaults off and tolerates unavailable browser storage", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    });
    expect(isGLTerrainEnabled()).toBe(false);
  });
  it.each([
    "?m=dy&ds=1",
    "?m=dy&pds=1",
    "?m=dy&se=42",
    "?m=dy&se=42&nb=1",
    "?m=dy&se=42&u=none",
    "?m=r",
    "?m=n",
    "?m=nm",
  ])(
    "ignores old opt-ins and selects approximate generation for %s",
    async (search) => {
      const getItem = vi.fn(() => "1");
      vi.stubGlobal("localStorage", { getItem });
      vi.stubGlobal("window", {
        location: new URL(`https://noitamap.com/${search}`),
      });
      expect(isGLTerrainEnabled()).toBe(false);
      expect((await loadTelescopeModules()).fork).toBe("legacy");
      expect(telescopeCacheKey("42-all")).toBe("42-all");
      expect(getItem).not.toHaveBeenCalled();
    },
  );
  it("allows the native baker to select the full fork explicitly, without storage", async () => {
    const getItem = vi.fn(() => {
      throw new Error("No browser storage in bake");
    });
    vi.stubGlobal("localStorage", { getItem });
    setFullPixelTerrainForBake(true);
    expect(isGLTerrainEnabled()).toBe(true);
    expect((await loadTelescopeModules()).fork).toBe("full");
    expect(telescopeCacheKey("42-all")).not.toBe("42-all");
    expect(getItem).not.toHaveBeenCalled();
  });
  it("uses baked images independently of live generation, unless explicitly bypassed", () => {
    for (const offline of [false, true]) {
      setFullPixelTerrainForBake(offline);
      expect(shouldUseBakedTerrain("?ds=1")).toBe(true);
      expect(shouldUseBakedTerrain("?pds=1")).toBe(true);
      expect(shouldUseBakedTerrain("?se=42")).toBe(true);
      expect(shouldUseBakedTerrain("?nb=1")).toBe(false);
    }
  });
  it("selects a complete matching main-thread fork", async () => {
    expect((await loadTelescopeModules(false)).fork).toBe("legacy");
    expect((await loadTelescopeModules(true)).fork).toBe("full");
  });
  it("selects the separate worker-safe entries", async () => {
    expect((await loadWorkerTelescopeModules(false)).fork).toBe(
      "legacy-worker",
    );
    expect((await loadWorkerTelescopeModules(true)).fork).toBe("full-worker");
  });
  it("cannot confuse legacy/daily and full-pixel generation or fallback images", () => {
    expect(telescopeCacheKey("42-all", false)).toBe("42-all");
    expect(telescopeCacheKey("42-all", true)).not.toBe(
      telescopeCacheKey("42-all", false),
    );
    expect(telescopeCacheKey("42-all", true)).not.toBe(
      telescopeCacheKey("43-all", true),
    );
  });
  it("bundles and routes all required shader data, including cold loads", () => {
    for (const file of [
      "material_atlas.bin",
      "edge_atlas.bin",
      "material_atlas.json",
      "biome_flags.json",
      "material_data.json",
    ]) {
      expect(fullPixelDataUrl(`../data/${file}`)).toBeTruthy();
      expect(fullPixelDataUrl(`https://example.com/data/${file}?v=1`)).toBe(
        fullPixelDataUrl(`../data/${file}`),
      );
    }
    expect(
      fullPixelDataUrl("../data/biome_maps/biome_map.png"),
    ).toBeUndefined();
    expect(
      fullPixelDataUrl("../data/material_atlas.bin/extra"),
    ).toBeUndefined();
  });
  it("round-trips wang region ownership and copies only the live buffer bytes", () => {
    const backing = new Uint8Array([99, 1, 2, 3, 88]);
    const layer = {
      biomeName: "coalmine",
      buffer: backing.subarray(1, 4),
      validChunks: new Set(["1,2", "2,2"]),
      chunkBasePos: { x: 1, y: 2 },
      minX: 1,
      minY: 2,
      width: 1,
      mapH: 1,
      height: 5,
      w: 512,
      h: 512,
      correctedX: 512,
      correctedY: 1024,
    };
    const stored = serializeTileLayer(layer);
    expect(stored.validChunks).toEqual(["1,2", "2,2"]);
    backing[1] = 77;
    const restored = restoreTileLayer(stored);
    expect([...restored.buffer!]).toEqual([1, 2, 3]);
    expect(restored.validChunks).toEqual(new Set(["1,2", "2,2"]));
    expect(restored.validChunks!.has("1,2")).toBe(true);
    expect(restored.chunkBasePos).toEqual(layer.chunkBasePos);
    expect(restored.minX).toBe(1);
    expect(restored.minY).toBe(2);
  });
  it("preserves fill-biome identity across cached reloads", () => {
    expect(restoreTileLayer(serializeTileLayer({ isFill: true })).isFill).toBe(
      true,
    );
  });
  it("keeps static layers distinct from empty dynamic regions", () => {
    expect(
      restoreTileLayer(serializeTileLayer({})).validChunks,
    ).toBeUndefined();
    expect(
      restoreTileLayer(serializeTileLayer({ validChunks: new Set() }))
        .validChunks,
    ).toEqual(new Set());
  });
});
