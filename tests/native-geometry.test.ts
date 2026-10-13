import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  createGeometryGenerator,
  createTerrainTileGenerator,
  type GeometryInputs,
} from "../src/native-map/geometry";
import { decodePngToRgba } from "../src/telescope/png-decode";
import { GENERATOR_CONFIG as lymmBiomes } from "../lib/noita-telescope/js/generator_config.js";
import { GENERATOR_CONFIG as hdBiomes } from "../lib/noita-telescope-vm/js/generator_config.js";
import { BLOCKED_COLORS } from "../lib/noita-telescope/js/pixel_scene_config.js";
import fixtures from "./fixtures/native-geometry-parity.json";

const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
function fingerprint(value: unknown) {
  return hash(
    JSON.stringify(value, (key, item) => {
      if (key === "canvas" || key === "imgElement") return undefined;
      if (ArrayBuffer.isView(item))
        return {
          type: item.constructor.name,
          bytes: item.byteLength,
          sha256: hash(
            new Uint8Array(item.buffer, item.byteOffset, item.byteLength),
          ),
        };
      if (item instanceof ArrayBuffer)
        return { bytes: item.byteLength, sha256: hash(new Uint8Array(item)) };
      if (item instanceof Set) return [...item];
      return item;
    }),
  );
}
async function inputs(fullPixels: boolean): Promise<GeometryInputs> {
  const root = resolve(import.meta.dirname, "../lib/noita-telescope/data");
  const decoded = new Map<string, Awaited<ReturnType<typeof decode>>>();
  async function decode(path: string) {
    const bytes = await readFile(resolve(root, path));
    return decodePngToRgba(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  }
  const biomes = Object.fromEntries(
    await Promise.all(
      Object.entries(fullPixels ? hdBiomes : lymmBiomes).map(
        async ([name, config]: [string, any]) => {
          let wangData;
          if (config.wangFile) {
            const path = config.wangFile.replace(/^\.\.\/data\//, "");
            wangData = decoded.get(path) ?? (await decode(path));
            decoded.set(path, wangData);
          }
          return [name, { ...config, enabled: true, wangData }];
        },
      ),
    ),
  );
  const base = async (name: string) => {
    const image = await decode(`biome_maps/${name}.png`);
    for (let i = 0; i < image.data.length; i += 4)
      if (
        image.data[i] === 0 &&
        image.data[i + 1] === 0 &&
        image.data[i + 2] === 0x40
      )
        image.data[i + 2] = 0x42;
    return image.data;
  };
  return {
    biomes,
    biomeMaps: {
      ng0: await base("biome_map"),
      ngp: await base("biome_map_newgame_plus"),
      nightmare: await base("biome_map_nightmare"),
    },
    minesOverlay: await decode("wang_tiles/extra_layers/coalmine.png"),
    blockedRoomColors: BLOCKED_COLORS,
    fillLayers: fullPixels,
    nightmarePlusPainter: fullPixels,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("owned native geometry", () => {
  it.each([false, true])(
    "preserves pre-extraction geometry with no DOM or fetch (HD=%s)",
    async (fullPixels) => {
      const data = await inputs(fullPixels);
      const generator = createGeometryGenerator(data);
      vi.stubGlobal("document", undefined);
      vi.stubGlobal("Image", undefined);
      vi.stubGlobal("fetch", () => {
        throw new Error("Geometry must use decoded inputs");
      });
      for (const fixture of fixtures.cases.filter(
        (c) => c.fork === (fullPixels ? "vm" : "lymm"),
      )) {
        const biomeData = generator.generateBiome(fixture);
        const width =
          fixture.ngPlus > 0 || fixture.gameMode === "nightmare" ? 64 : 70;
        const layers = await generator.generateTiles({
          ...fixture,
          pixels: biomeData.pixels,
          width,
          height: 48,
        });
        expect(fingerprint({ biomeData, layers }), fixture.name).toBe(
          fixture.geometryHash,
        );
      }
    },
  );

  it("owns its decoded inputs and keeps independent generator workspaces across yields", async () => {
    const data = await inputs(false);
    // Buffer is a valid Uint8Array input, but its slice() method shares storage.
    data.biomeMaps.ng0 = Buffer.from(data.biomeMaps.ng0);
    data.minesOverlay!.data = Buffer.from(data.minesOverlay!.data);
    for (const biome of Object.values(data.biomes))
      if (biome.wangData)
        biome.wangData.data = Buffer.from(biome.wangData.data);
    const a = createGeometryGenerator(data),
      b = createGeometryGenerator(data);
    const fixture = fixtures.cases.find(
      (c) => c.fork === "lymm" && c.name === "normal",
    )!;
    data.biomeMaps.ng0.fill(0);
    data.minesOverlay!.data.fill(0);
    for (const config of Object.values(data.biomes)) {
      config.enabled = false;
      config.wangData?.data.fill(0);
    }
    const generate = async (generator: typeof a) => {
      const biomeData = generator.generateBiome(fixture);
      const layers = await generator.generateTiles({
        ...fixture,
        pixels: biomeData.pixels,
        width: 70,
        height: 48,
        yieldControl: () => Promise.resolve(),
      });
      return fingerprint({ biomeData, layers });
    };
    expect(await Promise.all([generate(a), generate(b)])).toEqual([
      fixture.geometryHash,
      fixture.geometryHash,
    ]);
  });

  it("requires decoded templates/overlay and observes cancellation at a resumed checkpoint", async () => {
    expect(() =>
      createTerrainTileGenerator({
        biomes: {
          mines: { color: 1, enabled: true, wangFile: "coalmine.png" },
        },
        blockedRoomColors: [],
      }),
    ).toThrow("Missing decoded Wang template");
    const data = await inputs(false);
    const noOverlay = createGeometryGenerator({ ...data, minesOverlay: null });
    const fixture = fixtures.cases[0],
      biomeData = noOverlay.generateBiome(fixture);
    await expect(
      noOverlay.generateTiles({
        ...fixture,
        pixels: biomeData.pixels,
        width: 70,
        height: 48,
      }),
    ).rejects.toThrow("Decoded Mines overlay");
    const controller = new AbortController(),
      generator = createGeometryGenerator(data);
    await expect(
      generator.generateTiles({
        ...fixture,
        pixels: biomeData.pixels,
        width: 70,
        height: 48,
        signal: controller.signal,
        yieldControl: async () => {
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      (
        await generator.generateTiles({
          ...fixture,
          pixels: biomeData.pixels,
          width: 70,
          height: 48,
        })
      ).length,
    ).toBeGreaterThan(0);
  });

  it("honors a synchronous abort at the only checkpoint of a fill-only map", async () => {
    const controller = new AbortController();
    const generate = createTerrainTileGenerator({
      biomes: {
        fill: { color: 1, enabled: true, fillMaterial: "rock_static" },
      },
      blockedRoomColors: [],
      fillLayers: true,
    });
    await expect(
      generate({
        pixels: new Uint32Array([1]),
        width: 1,
        height: 1,
        seed: 1,
        signal: controller.signal,
        yieldControl: () => {
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
