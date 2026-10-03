import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addBakedDZIsToOSD,
  probeBakedDZIs,
} from "../src/telescope/baked-dzi-loader";
import { TERRAIN_VERSION } from "../src/telescope/terrain-policy";
import {
  isGLTerrainEnabled,
  isInstantTerrainEnabled,
  setFullPixelTerrainForBake,
} from "../src/renderer_settings";
afterEach(() => {
  setFullPixelTerrainForBake(false);
  vi.unstubAllGlobals();
});
describe("baked DZI rendering", () => {
  it.each(["daily", "previous-daily"] as const)(
    "loads published %s bakes independently of the live GPU cache revision",
    async (prefix) => {
      vi.stubGlobal("window", {
        location: { hostname: "localhost", search: "?terrain=gpu" },
      });
      // The deployed CPU baker currently publishes v9. A newer live renderer
      // revision must not turn an available daily bake into local generation.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const world = url.match(/-(left|middle|right)\./)![1];
          const pw = { left: -1, middle: 0, right: 1 }[world]!;
          return {
            ok: true,
            json: async () => ({
              seed: 239365546,
              world,
              terrainVersion: "full-pixel-v9",
              complete: true,
              baked: true,
              generatedAt: "2026-09-28T00:07:46.454Z",
              regions: [{
                pw,
                dzi: "map.dzi",
                minX: -17920 + pw * 35840,
                minY: -31744,
                fullW: 35840,
                fullH: 73728,
              }],
            }),
          };
        }),
      );
      expect(isInstantTerrainEnabled()).toBe(true);
      expect(isGLTerrainEnabled()).toBe(false);
      const result = await probeBakedDZIs(prefix, 239365546);
      expect(result.baked).toBe(true);
      if (result.baked) {
        expect(result.decorationsBaked).toBe(true);
        expect(result.placements.map(p => p.pw)).toEqual([-1, 0, 1]);
        expect(result.placements.map(p => p.dziUrl)).toEqual(
          ["left", "middle", "right"].map(world =>
            `https://${prefix}-${world}.acidflow.stream/map.dzi`),
        );
        // This flag certifies the current renderer's pixels, not whether the
        // independently published daily map is usable.
        expect(result.fullPixelsBaked).toBe(false);
      }
    },
  );

  it("preserves alpha and all mip levels on the baked overlay", () => {
    const source: Record<string, any> = { minLevel: 0 };
    addBakedDZIsToOSD(
      {
        addTiledImage(options: any) {
          options.success({ item: { source } });
        },
      },
      [
        {
          pw: 0,
          dziUrl: "https://daily-middle.acidflow.stream/map.dzi",
          x: 0,
          y: 0,
          width: 35840,
          bust: "today",
        },
      ],
    );
    expect(source.hasTransparency()).toBe(true);
    expect(source.minLevel).toBe(0);
    expect(source.__bakedDzi).toBe(true);
    expect(source.queryParams).toBe("?v=today");
  });
  it.each(["0", "1"])(
    "uses completed full-pixel bakes with live rendering disabled, ignoring old preference (%s)",
    async (preference) => {
      vi.stubGlobal("localStorage", { getItem: () => preference });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            seed: 123,
            terrainVersion: TERRAIN_VERSION,
            complete: true,
            baked: true,
            regions: [
              {
                pw: 0,
                dzi: "map.dzi",
                minX: 0,
                minY: 0,
                fullW: 35840,
                fullH: 73728,
              },
            ],
          }),
        })),
      );
      const result = await probeBakedDZIs("daily", 123);
      expect(result.baked).toBe(true);
      expect(isGLTerrainEnabled()).toBe(false);
      if (result.baked) {
        expect(result.decorationsBaked).toBe(true);
        expect(result.fullPixelsBaked).toBe(true);
      }
    },
  );
  it("does not label legacy or mixed daily worlds as already full-pixel", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "0" });
    for (const legacy of [
      {},
      { complete: false, terrainVersion: TERRAIN_VERSION },
      { complete: true, terrainVersion: "obsolete-renderer" },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => ({
          ok: true,
          json: async () => ({
            seed: 123,
            baked: true,
            regions: [{ pw: 0, dzi: "map.dzi" }],
            ...(url.includes("-left.")
              ? legacy
              : { complete: true, terrainVersion: TERRAIN_VERSION }),
          }),
        })),
      );
      const result = await probeBakedDZIs("previous-daily", 123);
      expect(result.baked).toBe(true);
      if (result.baked) expect(result.fullPixelsBaked).toBe(false);
    }
  });
  it("marks a completed previous-daily map full-pixel as well", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "0" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          seed: 123,
          baked: true,
          complete: true,
          terrainVersion: TERRAIN_VERSION,
          regions: [{ pw: 0, dzi: "map.dzi" }],
        }),
      })),
    );
    const result = await probeBakedDZIs("previous-daily", 123);
    expect(result.baked && result.fullPixelsBaked).toBe(true);
  });
  it("rejects coarse or incomplete bakes in explicit offline full-pixel mode", async () => {
    setFullPixelTerrainForBake(true);
    for (const incomplete of [
      {},
      { terrainVersion: TERRAIN_VERSION, complete: false },
      { terrainVersion: "full-pixel-v9", complete: true },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            seed: 123,
            ...incomplete,
            regions: [{ dzi: "map.dzi" }],
          }),
        })),
      );
      expect((await probeBakedDZIs("daily", 123)).baked).toBe(false);
    }
  });
  it.each(["missing", "wrong-seed"])(
    "leaves approximate generation selected when a daily world is %s",
    async (failure) => {
      vi.stubGlobal("localStorage", { getItem: () => "1" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => ({
          ok: !(failure === "missing" && url.includes("-right.")),
          json: async () => ({
            seed:
              failure === "wrong-seed" && url.includes("-right.") ? 456 : 123,
            baked: true,
            complete: true,
            terrainVersion: TERRAIN_VERSION,
            regions: [{ pw: 0, dzi: "map.dzi" }],
          }),
        })),
      );
      expect((await probeBakedDZIs("daily", 123)).baked).toBe(false);
      expect(isGLTerrainEnabled()).toBe(false);
    },
  );
});
