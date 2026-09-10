import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isGLTerrainEnabled,
  setFullPixelTerrainForBake,
} from "../src/renderer_settings";
import { openBakeRenderer, prepareBake } from "../src/telescope/bake-entry";

const { generateDynamicMap, getDataZip } = vi.hoisted(() => ({
  generateDynamicMap: vi.fn(),
  getDataZip: vi.fn(),
}));
vi.mock("../src/telescope/telescope-adapter", () => ({ generateDynamicMap }));
vi.mock("../src/data-archive", () => ({ getDataZip }));
vi.mock("../src/telescope/telescope-dom-shim", () => ({
  installTelescopeShim: vi.fn(),
}));
vi.mock("../src/telescope/telescope-data-bridge", () => ({
  installFetchInterceptor: vi.fn(),
}));

afterEach(() => {
  setFullPixelTerrainForBake(false);
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("native bake explicitly selects final pixels, independently of the public map", () => {
  it("selects the full fork before seed generation, even without a saved opt-in", async () => {
    const getItem = vi.fn(() => null);
    vi.stubGlobal("localStorage", { getItem });
    expect(isGLTerrainEnabled()).toBe(false);
    // Stop at the generation boundary: this checks entrypoint mode selection,
    // not a mocked claim that a whole map rendered successfully.
    const stop = new Error("generation boundary");
    generateDynamicMap.mockImplementation(() => {
      expect(isGLTerrainEnabled()).toBe(true);
      throw stop;
    });
    await expect(prepareBake(786433191)).rejects.toBe(stop);
    expect(generateDynamicMap).toHaveBeenCalledWith({
      seed: 786433191,
      ngPlus: 0,
      dailySeed: true,
      unlocks: null,
      parallelWorlds: [0, -1, 1],
    });
    expect(getItem).not.toHaveBeenCalled();
  });

  it("selects final pixels before initializing a separate render worker", async () => {
    expect(isGLTerrainEnabled()).toBe(false);
    const stop = new Error("asset-loading boundary");
    getDataZip.mockImplementation(() => {
      expect(isGLTerrainEnabled()).toBe(true);
      throw stop;
    });
    await expect(openBakeRenderer({})).rejects.toBe(stop);
    expect(getDataZip).toHaveBeenCalledOnce();
  });
});
