import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { encode } from "fast-png";
import { decodePngToRgba } from "../src/native-map/png";
import { createSceneSourceLoader } from "../src/native-map/composition/scene-source-loader";
import {
  nativeSceneSourceDefinitions,
  type NativeSceneSourceDefinition,
} from "../src/native-map/composition/scene-source-definitions";

it("preserves real scene invisible RGB only on explicit request", async () => {
  const bytes = Uint8Array.from(
    await readFile(
      new URL(
        "../lib/noita-telescope-vm/data/pixel_scenes/general/potion_altar_visual.png",
        import.meta.url,
      ),
    ),
  );
  const original = decodePngToRgba(bytes.buffer, {
    preserveTransparentRGB: true,
  });
  const normalized = decodePngToRgba(bytes.buffer);
  expect(Array.from(original.data.subarray(2052, 2056))).toEqual([
    128, 0, 128, 0,
  ]);
  expect(Array.from(normalized.data.subarray(2052, 2056))).toEqual([
    0, 0, 0, 0,
  ]);
  for (let p = 0; p < original.data.length; p += 4) {
    expect(normalized.data[p + 3]).toBe(original.data[p + 3]);
    if (original.data[p + 3])
      expect(normalized.data.subarray(p, p + 4)).toEqual(
        original.data.subarray(p, p + 4),
      );
  }
});

function fixture(cacheBytes = 1024) {
  const base = Uint8Array.from([
    0, 0, 0, 255, 12, 34, 56, 255, 128, 0, 128, 0, 0, 0, 66, 255,
  ]);
  const art = Uint8Array.from([
    128, 0, 128, 0, 9, 8, 7, 127, 6, 5, 4, 128, 3, 2, 1, 255,
  ]);
  const encodeImage = (data: Uint8Array) =>
    encode({ data, width: 4, height: 1, channels: 4 });
  const metadata = {
    version: 1,
    scenes: {
      "test/source": {
        width: 4,
        height: 1,
        hasAir: true,
        hasBiomeFill: false,
        spawns: [1, 0, 7],
        artMask: [2, 2],
      },
    },
  };
  const paths: Record<string, Uint8Array> = {
    "data/pixel_scene_meta.json": new TextEncoder().encode(
      JSON.stringify(metadata),
    ),
    "data/source.png": encodeImage(base),
    "data/art.png": encodeImage(art),
    "data/background.png": encodeImage(art),
  };
  const reads: string[] = [];
  const definition: NativeSceneSourceDefinition = {
    key: "test/source",
    name: "source",
    sourceBiome: "test",
    directory: "test",
    materialPath: "data/source.png",
    visualPath: "data/art.png",
    backgroundPath: "data/background.png",
    skipEdgeTextures: true,
  };
  const assets = {
    revision: "explicit-test-revision",
    async read(path: string) {
      reads.push(path);
      if (!paths[path]) throw new Error(`Missing ${path}`);
      return paths[path];
    },
  };
  return {
    paths,
    reads,
    metadata,
    loader: () =>
      createSceneSourceLoader(assets, {
        cacheBytes,
        definitions: new Map([[definition.key, definition]]),
      }),
  };
}
it("cleans only material black/spawn cells, retains alpha and metadata masks, and normalizes backgrounds", async () => {
  const f = fixture(),
    loader = await f.loader();
  const [source, same] = await Promise.all([
    loader.load("test/source"),
    loader.load({ key: "test/source" }),
  ]);
  expect(source).toBe(same);
  expect(Array.from(source.data)).toEqual([
    0, 0, 0, 0, 0, 0, 0, 0, 128, 0, 128, 0, 0, 0, 66, 255,
  ]);
  expect(Array.from(source.visualArt!.data.subarray(0, 4))).toEqual([
    128, 0, 128, 0,
  ]);
  expect(Array.from(source.backgroundArt!.data.subarray(0, 4))).toEqual([
    0, 0, 0, 0,
  ]);
  expect(source.metadataArtMask).toEqual(new Uint8Array([0b00110000]));
  expect(source.spawns).toEqual([1, 0, 7]);
  expect(source.skipEdgeTextures).toBe(true);
  expect(f.reads).toHaveLength(4);
  expect(await loader.load("test/source")).toBe(source);
  expect(loader.cacheBytes).toBe(49);
  loader.clear();
  expect(loader.cacheBytes).toBe(0);
});
it("returns oversized sources uncached and rejects stale metadata or missing required art", async () => {
  const f = fixture(4),
    loader = await f.loader();
  const first = await loader.load("test/source");
  expect(loader.cacheBytes).toBe(0);
  expect(await loader.load("test/source")).not.toBe(first);
  await expect(loader.load("missing/source")).rejects.toThrow(
    /Missing scene source definition/,
  );
  delete f.paths["data/art.png"];
  await expect(loader.load("test/source")).rejects.toThrow(/Missing data\/art/);
  const bad = fixture();
  bad.metadata.scenes["test/source"].width = 5;
  bad.paths["data/pixel_scene_meta.json"] = new TextEncoder().encode(
    JSON.stringify(bad.metadata),
  );
  await expect((await bad.loader()).load("test/source")).rejects.toThrow(
    /art coverage/,
  );
});
it("keeps aliases, explicit source directories and first-biome metadata ownership", async () => {
  const definitions = nativeSceneSourceDefinitions();
  expect(definitions.get("pyramid/cathedral")?.materialPath).toBe(
    "data/pixel_scenes/crypt/cathedral.png",
  );
  expect(definitions.get("coalmine_alt/physics_01_alt")?.visualPath).toBe(
    "data/pixel_scenes/coalmine/physics_01_visual.png",
  );
  expect(definitions.get("temple/altar_top_water")?.visualPath).toBe(
    "data/pixel_scenes/temple/altar_top_visual.png",
  );
  expect(definitions.get("general/cauldron")?.visualPath).toBe(
    "data/pixel_scenes/general/cauldron_fg.png",
  );
  const metadata = JSON.parse(
    await readFile(
      new URL(
        "../lib/noita-telescope-vm/data/pixel_scene_meta.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect([...definitions.keys()].sort()).toEqual(
    Object.keys(metadata.scenes).sort(),
  );
});
