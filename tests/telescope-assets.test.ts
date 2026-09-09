import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
const archives = vi.hoisted(() => new Map<string, any>());
vi.mock("../src/data-archive", () => ({
  getZip: async (name: string) => archives.get(name),
  getDataZip: async () => archives.get("main"),
}));
vi.mock("../src/renderer_settings", () => ({ isGLTerrainEnabled: () => true }));
import { getFromZipFirst } from "../src/telescope/zip-extraction-shim";
import { installFetchInterceptor } from "../src/telescope/telescope-data-bridge";

afterEach(() => {
  archives.clear();
  vi.unstubAllGlobals();
});
describe("engine artwork archive paths", () => {
  for (const viaFetch of [false, true]) {
    it(`loads real scene color art instead of a 1x1 placeholder (${viaFetch ? "fetch" : "direct zip"})`, async () => {
      const zip = new JSZip();
      zip.file(
        "data/biome_impl/coalmine/coalpit01_visual.png",
        new Uint8Array([1, 2, 3]),
      );
      zip.file(
        "data/biome_impl/wand_altar_visual.png",
        new Uint8Array([4, 5, 6]),
      );
      zip.file(
        "data/weather_gfx/background_the_end.png",
        new Uint8Array([7, 8, 9]),
      );
      archives.set("main", zip);
      const fetchOriginal = vi.fn(() => {
        throw new Error("Unexpected network fallback");
      });
      vi.stubGlobal("window", { fetch: fetchOriginal });
      if (viaFetch) installFetchInterceptor(true);
      const read = async (path: string) =>
        new Uint8Array(
          await (
            await (viaFetch ? window.fetch(path) : getFromZipFirst(path))
          ).arrayBuffer(),
        );
      expect(
        await read("../data/pixel_scenes/coalmine/coalpit01_visual.png"),
      ).toEqual(new Uint8Array([1, 2, 3]));
      expect(
        await read("../data/pixel_scenes/general/wand_altar_visual.png"),
      ).toEqual(new Uint8Array([4, 5, 6]));
      expect(
        await read("../data/backgrounds/weather_gfx/background_the_end.png"),
      ).toEqual(new Uint8Array([7, 8, 9]));
      expect(fetchOriginal).not.toHaveBeenCalled();
    });
  }
  it("does not replace the generator's specialized base material PNG with a differently prepared main-archive copy", async () => {
    const main = new JSZip(),
      scenes = new JSZip();
    main.file("data/biome_impl/coalmine/coalpit01.png", new Uint8Array([1]));
    scenes.file("coalmine/coalpit01.png", new Uint8Array([2]));
    archives.set("main", main);
    archives.set("pixel_scenes", scenes);
    expect(
      new Uint8Array(
        await (
          await getFromZipFirst("../data/pixel_scenes/coalmine/coalpit01.png")
        ).arrayBuffer(),
      ),
    ).toEqual(new Uint8Array([2]));
  });
});
