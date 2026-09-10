import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { decodePngToRgba } from "../src/telescope/png-decode";
import { clearTelescopeAssetCache } from "../src/telescope/telescope-assets";
import { normalizeTelescopePath } from "../src/telescope/telescope-asset-paths";
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
  clearTelescopeAssetCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const repairedPaths = [
  [
    "snowcave/altar_snowcave_capsule.png",
    "pixel_scenes",
    "temple/altar_snowcave_capsule.png",
  ],
  [
    "snowcastle/altar_snowcastle_capsule.png",
    "pixel_scenes",
    "temple/altar_snowcastle_capsule.png",
  ],
  [
    "vault/altar_vault_capsule.png",
    "pixel_scenes",
    "temple/altar_vault_capsule.png",
  ],
  [
    "snowcave/acidtank_visual.png",
    "main",
    "data/biome_impl/acidtank_visual.png",
  ],
  [
    "snowcave/acidtank_2_visual.png",
    "main",
    "data/biome_impl/acidtank_2_visual.png",
  ],
  ["general/scale.png", "pixel_scenes", "overworld/scale.png"],
  ["general/scale_old.png", "pixel_scenes", "overworld/scale_old.png"],
] as const;
let realArchives: Promise<Map<string, JSZip>> | undefined;
const loadRealArchives = () =>
  (realArchives ??= Promise.all(
    ["main", "pixel_scenes", "wang_tiles"].map(
      async (key) =>
        [
          key,
          await JSZip.loadAsync(
            await readFile(
              new URL(
                `../public/${key === "main" ? "data" : key}.zip`,
                import.meta.url,
              ),
            ),
          ),
        ] as const,
    ),
  ).then((entries) => new Map(entries)));

describe("repaired asset paths use real authored pixels", () => {
  it.each(repairedPaths)(
    "resolves %s to its canonical archive entry",
    async (path, archive, canonical) => {
      for (const [key, zip] of await loadRealArchives()) archives.set(key, zip);
      const expected = await archives
        .get(archive)
        .file(canonical)
        .async("uint8array");
      const blob = await getFromZipFirst(
        `../data/pixel_scenes/${path}?v=123#ignored`,
      );
      const bytes = await blob.arrayBuffer();
      expect(new Uint8Array(bytes)).toEqual(expected);
      const image = decodePngToRgba(bytes);
      expect(image.width * image.height).toBeGreaterThan(1);
    },
  );

  it.each([
    "biome_maps/biome_map_nightmare.png",
    "pixel_scenes/general/cauldron.png",
  ])(
    "loads the bundled %s without recursive interception or blank fallback",
    async (path) => {
      const original = vi.fn(
        async (url: string) => new Response(await readFile(new URL(url))),
      );
      vi.stubGlobal("fetch", original);
      vi.stubGlobal("window", globalThis);
      installFetchInterceptor(false);
      const [direct, viaFetch] = await Promise.all([
        getFromZipFirst(`./data/${path}`),
        window.fetch(`./data/${path}`),
      ]);
      const bytes = await direct.arrayBuffer();
      expect(new Uint8Array(await viaFetch.arrayBuffer())).toEqual(
        new Uint8Array(bytes),
      );
      expect(decodePngToRgba(bytes).width).toBeGreaterThan(1);
      expect(original).toHaveBeenCalledTimes(1);
      // These are explicitly shared between the two pinned forks, not a guess
      // that their authored assets are interchangeable.
      expect(
        await readFile(
          new URL(`../lib/noita-telescope/data/${path}`, import.meta.url),
        ),
      ).toEqual(
        await readFile(
          new URL(`../lib/noita-telescope-vm/data/${path}`, import.meta.url),
        ),
      );
    },
  );

  it("normalizes URL queries and escaped file names, not arbitrary query text", () => {
    expect(
      normalizeTelescopePath(
        "https://example.test/data/pixel_scenes/general/%73cale.png?v=1#x",
      ),
    ).toBe("data/pixel_scenes/general/scale.png");
    expect(
      normalizeTelescopePath("https://example.test/?path=data/missing.png"),
    ).toBeNull();
  });
});

describe("asset extraction and failure handling", () => {
  it("coalesces simultaneous reads and keeps only one successful extraction", async () => {
    const zip = new JSZip().file("data/test.png", new Uint8Array([1, 2, 3]));
    archives.set("main", zip);
    const extract = vi.spyOn(zip.file("data/test.png")!, "async");
    const blobs = await Promise.all(
      Array.from({ length: 10 }, () => getFromZipFirst("./data/test.png")),
    );
    expect(extract).toHaveBeenCalledTimes(1);
    expect(new Set(blobs).size).toBe(1);
    await getFromZipFirst("./data/test.png");
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("does not cache a missing PNG as a successful transparent pixel", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(getFromZipFirst("./data/missing.png")).rejects.toThrow(
      "Missing telescope PNG",
    );
    expect(fetch).not.toHaveBeenCalled();
    archives.set(
      "main",
      new JSZip().file("data/missing.png", new Uint8Array([1])),
    );
    expect((await getFromZipFirst("./data/missing.png")).size).toBe(1);
  });

  it("surfaces archive corruption, evicts the broken archive, and permits retry", async () => {
    const zip = new JSZip().file("data/test.png", new Uint8Array([1]));
    archives.set("main", zip);
    const extract = vi
      .spyOn(zip.file("data/test.png")!, "async")
      .mockRejectedValueOnce(new Error("corrupt compressed data"));
    const remove = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { delete: remove });
    await expect(getFromZipFirst("./data/test.png")).rejects.toThrow(
      "archive cache cleared",
    );
    expect(remove).toHaveBeenCalledWith("noitamap-archive-main-v2");
    expect((await getFromZipFirst("./data/test.png")).size).toBe(1);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("bounds retained PNG entries and evicts old extractions", async () => {
    const zip = new JSZip();
    for (let i = 0; i < 65; i++) zip.file(`data/${i}.png`, new Uint8Array([i]));
    archives.set("main", zip);
    const extract = vi.spyOn(zip.file("data/0.png")!, "async");
    for (let i = 0; i < 65; i++) await getFromZipFirst(`./data/${i}.png`);
    await getFromZipFirst("./data/0.png");
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("does not stack fetch wrappers and keeps HEAD/abort behavior", async () => {
    archives.set(
      "main",
      new JSZip().file("data/test.png", new Uint8Array([1, 2])),
    );
    const original = vi.fn();
    vi.stubGlobal("window", { fetch: original });
    installFetchInterceptor(false);
    const wrapped = window.fetch;
    installFetchInterceptor(true);
    expect(window.fetch).toBe(wrapped);
    const head = await window.fetch("./data/test.png", { method: "HEAD" });
    expect(await head.text()).toBe("");
    expect(head.headers.get("Content-Length")).toBe("2");
    await expect(
      window.fetch("./data/test.png", { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(original).not.toHaveBeenCalled();
  });
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
