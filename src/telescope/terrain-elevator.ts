import type { GLTerrainGeneration } from "./gl-terrain-tile-source";
import type { TerrainOwnership } from "./terrain-policy";

/** The NG0 map has a one-cell Power Plant stub on its last row. Its clamped
 * column continues below the map; unlike sky/hell, it is not a recoloring of
 * the main world's separated biome regions. Detect the source claim rather
 * than hardcoding its NG0 x coordinate or extending every bottom-row biome. */
export function bottomElevatorStubs(
  layers: any[],
  pixels: Uint32Array,
  width: number,
): any[] {
  return layers.filter((layer) => {
    if (
      layer.biomeName !== "robobase" ||
      !layer.buffer ||
      layer.isFill ||
      layer.validChunks?.size !== 1
    )
      return false;
    const [claim] = layer.validChunks as Set<string>;
    const [x, y] = claim.split(",").map(Number);
    return (
      y === 47 &&
      x >= 0 &&
      x < width &&
      (pixels[y * width + x] & 0xffffff) === 0x4e5267
    );
  });
}

/** Generate a single continuous narrow Wang region, including its original
 * start chunk so the generator's 1/10 lattice remains anchored there. Only the
 * lower-plane renderer consumes the continuation. All original layers remain
 * read-only and all other columns retain the existing plane/source policy. */
export async function prepareElevatorShafts(
  gen: GLTerrainGeneration,
): Promise<any[]> {
  if (gen.elevatorShafts) return gen.elevatorShafts;
  const pixels = (gen.sourceBiomeData ?? gen.biomeData).pixels;
  const width = pixels.length / 48;
  const stubs = bottomElevatorStubs(gen.tileLayers, pixels, width);
  if (!stubs.length) return [];
  const [{ generateBiomeTiles }, { GENERATOR_CONFIG }, { loadPNG }] =
    await Promise.all([
      import("noita-telescope-full-pixels/tile_generator.js"),
      import("noita-telescope-full-pixels/generator_config.js"),
      import("noita-telescope-full-pixels/png_sanitizer.js"),
    ]);
  const conf = GENERATOR_CONFIG.robobase;
  const config = {
    robobase: {
      ...conf,
      enabled: true,
      wangData: conf.wangData ?? (await loadPNG(conf.wangFile)),
    },
  };
  const out: any[] = [];
  for (const stub of stubs) {
    const [claim] = stub.validChunks as Set<string>;
    const [x] = claim.split(",").map(Number);
    const extended = new Uint32Array(width * 96);
    for (let y = 47; y < 96; y++) extended[y * width + x] = conf.color;
    const layers = await generateBiomeTiles(
      extended,
      width,
      96,
      config,
      gen.seed,
      gen.ngPlus ?? 0,
      0,
      gen.gameMode ?? "normal",
    );
    if (
      layers.length !== 1 ||
      !layers[0].buffer ||
      layers[0].validChunks?.size !== 49
    )
      throw new Error(`Incomplete elevator shaft at biome-map column ${x}`);
    out.push(layers[0]);
  }
  return out;
}

/** Add precisely the continued stub's column, never its surrounding rock or
 * another biome's bounding rectangle. Heaven/main ownership is unchanged. */
export function includeElevatorOwnership(
  ownership: TerrainOwnership,
  shafts: any[] | undefined,
  plane = 0,
): TerrainOwnership {
  if (plane !== 1 || !shafts?.length) return ownership;
  let id = ownership.names.indexOf("robobase");
  if (id < 0) {
    id = ownership.names.length;
    ownership.names.push("robobase");
  }
  for (const shaft of shafts) {
    const x = shaft.minX;
    if (
      shaft.biomeName !== "robobase" ||
      !shaft.buffer ||
      !Number.isInteger(x) ||
      x < 0 ||
      x >= ownership.width
    )
      throw new Error("Invalid elevator shaft ownership");
    for (let y = 0; y < 48; y++) ownership.owners[y * ownership.width + x] = id;
  }
  return ownership;
}

/** A continued shaft replaces the false lower-world endpoint copy of the stub.
 * Keep all other biome spawns and all main/heaven scans unchanged. */
export function withoutElevatorEndpointSpawns<
  T extends { sourceBiome: string; x: number; y: number },
>(spawns: T[], columns: number[], mapWidth: number): T[] {
  if (!columns.length) return spawns;
  return spawns.filter(
    (spawn) =>
      !(
        spawn.sourceBiome === "robobase" &&
        spawn.y >= 33 * 512 - 10 &&
        columns.includes(Math.floor((spawn.x + mapWidth * 256) / 512))
      ),
  );
}
