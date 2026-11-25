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

// Main-world temples belong to the static map. Their heaven/hell repeats
// instead need the generated Wang geometry shaded with the vertical material.
const REPEATED_TEMPLE_BIOMES = new Set([
  "biome_potion_mimics",
  "biome_darkness",
]);

// These seed-dependent rooms carve air into the existing static-map rock.
// Their backdrop belongs only inside the scene, never across the whole biome.
export const CARVED_ROOM_BIOMES = new Set([
  "friend_1", "friend_2", "friend_3", "friend_4", "friend_5", "friend_6",
  "solid_wall_hidden_cavern",
]);

/** Telescope stores these material maps under general instead of their biome. */
export function carvedRoomBiome(key: string): string | undefined {
  if (key === "general/solid_wall_hidden_cavern") return "solid_wall_hidden_cavern";
  return key === "general/friendroom" || key === "general/cavern" ? "friend_1" : undefined;
}

/** Coarse temple templates are only needed by the approximate renderer. */
export function isRepeatedTempleTemplate(scene: { key: string }): boolean {
  return scene.key === "static_tile/temples-assets/potion_mimics" ||
    scene.key === "static_tile/temples-assets/darkness";
}

export function isWaterCaveLayout(key: string): boolean {
  return /^general\/watercave_layout_[1-5]$/.test(key);
}

// The underground room chunks painted by biome_map_newgame_plus.lua have no Wang tile.
// Each orbroom XML selects its own backdrop beneath the shared LoadPixelScene artwork.
export const NG_PLUS_ORB_BACKGROUNDS: Record<string, string> = {
  orbroom_02: "data/weather_gfx/background_crypt.png",
  orbroom_03: "data/weather_gfx/background_crypt.png",
  orbroom_04: "data/weather_gfx/background_cave_09.png",
  orbroom_05: "data/weather_gfx/background_wandcave.png",
  orbroom_06: "data/weather_gfx/background_cave_07.png",
  orbroom_07: "data/weather_gfx/background_cave_04_alt.png",
  orbroom_08: "data/weather_gfx/background_the_end.png",
  orbroom_09: "data/weather_gfx/background_cave_04_alt.png",
  orbroom_10: "data/weather_gfx/background_crypt.png",
};

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
  winter_caves: "data/weather_gfx/background_cave_04_alt.png",
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
  // Carved room interiors reveal this backdrop through their force-air pixels.
  friend_1: "data/weather_gfx/background_cave_02.png",
  friend_2: "data/weather_gfx/background_cave_02.png",
  friend_3: "data/weather_gfx/background_cave_02.png",
  friend_4: "data/weather_gfx/background_cave_02.png",
  friend_5: "data/weather_gfx/background_cave_02.png",
  friend_6: "data/weather_gfx/background_cave_02.png",
  solid_wall_hidden_cavern: "data/weather_gfx/background_cave_02.png",
};

/** Biome names a scene instance was placed for (its variant `biome=` override,
 * then its key's biome), so fill biomes without a terrain layer can still
 * supply the backdrop the game shows inside the carved room. */
export function sceneBiomeNames(scene: { key: string; variantKey?: string }): string[] {
  const names: string[] = [];
  const room = carvedRoomBiome(scene.key);
  if (room) names.push(room);
  for (const part of (scene.variantKey ?? "").split("&"))
    if (part.startsWith("biome=")) names.push(...part.slice(6).split("@"));
  names.push(scene.key.split("/")[0]);
  return names;
}

export const TERRAIN_VERSION = "full-pixel-v21-instant-gold-cavern";
// Local pixel caches include artwork changes even while a compatible older DZI is published.
export const TERRAIN_PIXEL_REVISION = "wang-ownership-628d14c-orb-rooms-v2";
export const WORLD_HEIGHT = 48 * 512;
export const WORLD_TOP = -14 * 512;
/** The legacy scene record only names its shared "general" folder. Its biome-map
 * cell selects the material bands, including for seeds restored from IndexedDB. */
export function withOrbRoomBiome<T extends { key: string; x: number; y: number; variantKey?: string }>(
  scene: T, pixels: Uint32Array, worldSize: number, worldCenter: number,
): T {
  if (scene.key !== "general/orbroom") return scene;
  const column = ((Math.floor(scene.x / 512) + worldCenter) % worldSize + worldSize) % worldSize;
  const lastRow = Math.floor(pixels.length / worldSize) - 1;
  const row = Math.min(Math.floor((scene.y - WORLD_TOP) / 512), lastRow);
  const color = pixels[row * worldSize + column] & 0xffffff;
  const biome = `orbroom_${(color & 0xff).toString(16).padStart(2, "0")}`;
  if (color >>> 8 !== 0xffd1 || !Object.hasOwn(NG_PLUS_ORB_BACKGROUNDS, biome)) return scene;
  const part = `biome=general@${biome}`;
  const parts = (scene.variantKey ?? "").split("&").filter(Boolean);
  if (parts.includes(part)) return scene;
  return { ...scene, variantKey: [...parts.filter(p => !p.startsWith("biome=")), part].join("&") };
}

/** Only orb rooms on the last biome row repeat into the captured Hell plane. */
export function repeatBottomOrbRooms<T extends { key: string; x: number; y: number }>(scenes: T[]): T[] {
  const hellTop = WORLD_TOP + WORLD_HEIGHT;
  const rooms = scenes.filter(scene => scene.key === "general/orbroom");
  const bottomRooms = rooms.filter(scene => scene.y === hellTop - 512);
  if (!bottomRooms.length) return scenes;
  const positions = new Set(rooms.map(scene => `${scene.x},${scene.y}`));
  const result = [...scenes];
  for (const room of bottomRooms) {
    for (let y = hellTop; y < hellTop + WORLD_HEIGHT; y += 512) {
      const position = `${room.x},${y}`;
      if (positions.has(position)) continue;
      result.push({ ...room, y });
      positions.add(position);
    }
  }
  return result;
}

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
  includeRepeatedTemples = false,
): TerrainOwnership {
  const owners = new Int16Array(width * 48).fill(-1);
  const names: string[] = [];
  const ids = new Map<string, number>();
  for (const layer of layers) {
    const name = layer.biomeName;
    const conf = config[name];
    if (!layer.buffer || layer.isFill || !conf?.wangFile || (STATIC_TERRAIN_BIOMES.has(name) &&
      !(includeRepeatedTemples && REPEATED_TEMPLE_BIOMES.has(name))))
      continue;
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
 * sky/hell material band. Only repeated temple Wang layers are exempt from
 * main-world static-art exclusions; other authored rooms stay excluded. */
export function createPlaneOwnership(
  layers: any[],
  sourcePixels: Uint32Array,
  paintPixels: Uint32Array,
  config: Record<string, any>,
  width: number,
): TerrainOwnership {
  const source = createTerrainOwnership(layers, sourcePixels, config, width,
    sourcePixels !== paintPixels);
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
  isNGP = false,
): TerrainOwnership {
  if (plane === 0 && !isNGP) return terrain;
  const names = plane === 0 ? [...terrain.names] : [],
    ids = new Map<number, number>();
  for (const [name, conf] of Object.entries(config)) {
    if (plane === 0) {
      if (!NG_PLUS_ORB_BACKGROUNDS[name]) continue;
    } else if (!(plane === 1 && isNGP && NG_PLUS_ORB_BACKGROUNDS[name]) &&
      (!conf.wangFile || STATIC_TERRAIN_BIOMES.has(name) || !BIOME_BACKGROUND_MAP[name])) continue;
    ids.set(conf.color & 0xffffff, names.length);
    names.push(name);
  }
  const owners = plane === 0 ? terrain.owners.slice() : new Int16Array(pixels.length).fill(-1);
  for (let i = 0; i < pixels.length; i++) {
    const id = ids.get(pixels[i] & 0xffffff);
    if (id !== undefined) owners[i] = id;
  }
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
