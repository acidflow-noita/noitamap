/** Shared by live rendering and the daily baker. Static areas are never
 * procedural fill targets merely because engine_data contains a material. */
export const STATIC_TERRAIN_BIOMES = new Set([
  "temple_altar",
  "dragoncave",
  "snowcastle_hourglass_chamber",
  "snowcastle_cavern",
  "snowcave_secret_chamber",
  "excavationsite_cube_chamber",
  "secret_lab",
  "lavalake",
  "biome_watchtower",
  "biome_potion_mimics",
  "biome_darkness",
  "biome_boss_sky",
  "biome_barren",
  "lake_deep",
]);

export const BIOME_BACKGROUND_MAP: Record<string, string> = {
  coalmine: "data/weather_gfx/background_coalmine.png",
  coalmine_alt: "data/weather_gfx/background_coalmine.png",
  excavationsite: "data/weather_gfx/background_excavationsite.png",
  excavationsite_cube_chamber: "data/weather_gfx/background_cave_04_alt3.png",
  snowcave: "data/weather_gfx/background_snowcave.png",
  snowcave_secret_chamber: "data/weather_gfx/background_snowcave.png",
  snowcastle: "data/weather_gfx/background_snowcastle.png",
  snowcastle_cavern: "data/weather_gfx/background_cave_02.png",
  snowcastle_hourglass_chamber: "data/weather_gfx/background_cave_04_alt3.png",
  fungicave: "data/weather_gfx/background_fungicave_01.png",
  fungiforest: "data/weather_gfx/background_fungiforest_01.png",
  rainforest: "data/weather_gfx/background_rainforest.png",
  rainforest_open: "data/weather_gfx/background_rainforest.png",
  rainforest_dark: "data/weather_gfx/background_rainforest_dark.png",
  vault: "data/weather_gfx/background_vault.png",
  vault_frozen: "data/weather_gfx/background_vault_frozen.png",
  crypt: "data/weather_gfx/background_crypt.png",
  wandcave: "data/weather_gfx/background_wandcave.png",
  wizardcave: "data/weather_gfx/background_wizardcave.png",
  robobase: "data/weather_gfx/background_robobase.png",
  the_end: "data/weather_gfx/background_the_end.png",
  meat: "data/weather_gfx/background_the_end.png",
  pyramid: "data/weather_gfx/background_pyramid.png",
  liquidcave: "data/weather_gfx/background_cave_04_alt.png",
  sandcave: "data/weather_gfx/background_cave_09.png",
  dragoncave: "data/weather_gfx/background_cave_02.png",
  lavalake: "data/weather_gfx/background_cave_04_alt.png",
  temple_altar: "data/weather_gfx/background_cave_02.png",
  secret_lab: "data/weather_gfx/background_snowcave.png",
  winter_caves: "data/weather_gfx/background_snowcave.png",
  // Tower floors (top to bottom = main biomes in reverse)
  solid_wall_tower_9: "data/weather_gfx/background_the_end.png",
  solid_wall_tower_8: "data/weather_gfx/background_crypt.png",
  solid_wall_tower_7: "data/weather_gfx/background_vault.png",
  solid_wall_tower_6: "data/weather_gfx/background_rainforest.png",
  solid_wall_tower_5: "data/weather_gfx/background_fungicave_01.png",
  solid_wall_tower_4: "data/weather_gfx/background_snowcastle.png",
  solid_wall_tower_3: "data/weather_gfx/background_snowcave.png",
  solid_wall_tower_2: "data/weather_gfx/background_excavationsite.png",
  solid_wall_tower_1: "data/weather_gfx/background_coalmine.png",
  solid_wall_tower_10: "data/weather_gfx/background_crypt.png",
};

export const TERRAIN_VERSION = "full-pixel-v7";
export const WORLD_HEIGHT = 48 * 512;
export const WORLD_TOP = -14 * 512;
export type VerticalPlane = -1 | 0 | 1;
export interface TerrainOwnership {
  width: number;
  owners: Int16Array;
  names: string[];
  at: (worldX: number, localY: number) => number;
}

/** A biome must own a real generated layer AND the actual biome-map cell.
 * This guards engine topology-0/fill paths, which don't consult layer buffers.
 * Merely removing a skipped layer from a GPU atlas is not sufficient. */
export function createTerrainOwnership(
  layers: any[],
  pixels: Uint32Array,
  config: Record<string, any>,
  width: number,
): TerrainOwnership {
  const owners = new Int16Array(width * 48).fill(-1);
  const names: string[] = [];
  const ids = new Map<string, number>();
  for (const layer of layers) {
    const name = layer.biomeName;
    if (!layer.buffer || layer.isFill || STATIC_TERRAIN_BIOMES.has(name))
      continue;
    const conf = config[name];
    if (!conf?.wangFile) continue;
    let id = ids.get(name);
    if (id === undefined) {
      id = names.length;
      ids.set(name, id);
      names.push(name);
    }
    const own = (x: number, y: number) => {
      if (
        x >= 0 &&
        y >= 0 &&
        x < width &&
        y < 48 &&
        (pixels[y * width + x] & 0xffffff) === (conf.color & 0xffffff)
      )
        owners[y * width + x] = id!;
    };
    if (layer.validChunks)
      for (const key of layer.validChunks) {
        const [x, y] = key.split(",").map(Number);
        own(x, y);
      }
    else {
      const x0 = layer.chunkBasePos?.x ?? layer.minX,
        y0 = layer.chunkBasePos?.y ?? layer.minY;
      for (let y = y0; y < y0 + Math.ceil(layer.h / 512); y++)
        for (let x = x0; x < x0 + Math.ceil(layer.w / 512); x++) own(x, y);
    }
  }
  return {
    width,
    owners,
    names,
    at(worldX, localY) {
      const x =
        ((Math.floor((worldX + width * 256) / 512) % width) + width) % width;
      const y = Math.floor((localY - WORLD_TOP) / 512);
      return y < 0 || y >= 48 ? -1 : owners[y * width + x];
    },
  };
}

/** Vertical-world paint is restricted to original source claims as well as the
 * sky/hell material band. Source exclusions still apply before remapping names. */
export function createPlaneOwnership(
  layers: any[],
  sourcePixels: Uint32Array,
  paintPixels: Uint32Array,
  config: Record<string, any>,
  width: number,
): TerrainOwnership {
  const source = createTerrainOwnership(layers, sourcePixels, config, width);
  if (sourcePixels === paintPixels) return source;
  const nameByColor = new Map<number, string>();
  for (const [name, cfg] of Object.entries(config))
    if (cfg.wangFile && !STATIC_TERRAIN_BIOMES.has(name))
      nameByColor.set(cfg.color & 0xffffff, name);
  const names: string[] = [],
    ids = new Map<string, number>();
  for (let i = 0; i < source.owners.length; i++) {
    if (source.owners[i] < 0) continue;
    const name = nameByColor.get(paintPixels[i] & 0xffffff);
    if (!name) {
      source.owners[i] = -1;
      continue;
    }
    let id = ids.get(name);
    if (id === undefined) {
      id = names.length;
      ids.set(name, id);
      names.push(name);
    }
    source.owners[i] = id;
  }
  return { ...source, names };
}

/** Terrain geometry and background sprites have different footprints in the
 * engine. Hell's authored backdrop spans its material band INCLUDING the empty
 * gaps between repeated Wang regions; it must not create solid terrain there. */
export function createBackgroundOwnership(
  terrain: TerrainOwnership,
  pixels: Uint32Array,
  config: Record<string, any>,
  plane: VerticalPlane,
): TerrainOwnership {
  if (plane === 0) return terrain;
  const names: string[] = [],
    ids = new Map<number, number>();
  for (const [name, conf] of Object.entries(config)) {
    if (
      !conf.wangFile ||
      STATIC_TERRAIN_BIOMES.has(name) ||
      !BIOME_BACKGROUND_MAP[name]
    )
      continue;
    ids.set(conf.color & 0xffffff, names.length);
    names.push(name);
  }
  const owners = new Int16Array(pixels.length).fill(-1);
  for (let i = 0; i < pixels.length; i++)
    owners[i] = ids.get(pixels[i] & 0xffffff) ?? -1;
  const width = terrain.width;
  return {
    width,
    names,
    owners,
    at(worldX: number, localY: number) {
      const cx =
        ((Math.floor((worldX + width * 256) / 512) % width) + width) % width;
      const cy = Math.floor((localY - WORLD_TOP) / 512);
      return cy < 0 || cy >= 48 ? -1 : owners[cy * width + cx];
    },
  };
}
