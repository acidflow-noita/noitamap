import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addBakedDZIsToOSD,
  probeBakedDZIs,
} from "../src/telescope/baked-dzi-loader";
import { TERRAIN_VERSION } from "../src/telescope/terrain-policy";
afterEach(() => vi.unstubAllGlobals());
describe("baked DZI rendering", () => {
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
    "identifies completed full-pixel bakes regardless of live preference (%s)",
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
  it("rejects coarse or incomplete bakes when full-pixel mode is enabled", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "1" });
    for (const incomplete of [
      {},
      { terrainVersion: TERRAIN_VERSION, complete: false },
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
});
