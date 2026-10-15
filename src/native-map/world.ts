import { createGeometryGenerator, createTerrainTileGenerator } from "./geometry";
import { installNativeAssets, readPng, releaseDecodedInputImages, type NativeAssets } from "./asset-host";

export interface WorldRequest {
  seed: number;
  ngPlus?: number;
  gameMode?: "normal" | "nightmare";
  unlocks?: string[] | null;
  dailySeed?: boolean;
  /** Seasonal spawn rules are an explicit input, captured once per request. */
  calendar?: { month: number; day: number };
  parallelWorlds?: number[];
}

export interface WorldRegion {
  horizontal: number;
  vertical: -1 | 0 | 1;
  pois: any[];
  scenes: any[];
}

/** Complete generation decisions, not completed image pixels. */
export interface NativeWorldDescription {
  kind: "native-world-description";
  revision: string;
  seed: number;
  ngPlus: number;
  gameMode: "normal" | "nightmare";
  calendar: { month: number; day: number };
  worldSize: number;
  worldCenter: number;
  biomeData: any;
  tileLayers: any[];
  elevatorShafts: any[];
  regions: WorldRegion[];
  timings: { geometryMs: number; placementsMs: number; totalMs: number; workers?: number };
}

/** Side workers return decisions only; the primary worker owns the shared geometry. */
export type NativeRegionDescription = Omit<NativeWorldDescription, "biomeData" | "tileLayers" | "elevatorShafts">;
export type NativeTerrainDescription = Pick<NativeWorldDescription,
  "seed" | "ngPlus" | "gameMode" | "worldSize" | "worldCenter" | "biomeData" | "tileLayers" | "elevatorShafts">;

let installed = false;

/** Exactly one rules instance per worker; its mutable PRNG/unlocks never cross workers. */
export async function createNativeWorldGenerator(assets: NativeAssets, yieldControl: () => Promise<void> = () => Promise.resolve()) {
  if (installed) throw new Error("Create each native generator in its own worker");
  installed = true;
  installNativeAssets(assets);
  const rules = await import("./rules");
  const config = rules.config.GENERATOR_CONFIG as Record<string, any>;
  rules.settings.updateSettings({
    clearSpawnPixels: true, recolorMaterials: true, enableEdgeNoise: true,
    fixHolyMountainEdgeNoise: true, enableStaticPixelScenes: "all",
    skipCosmeticScenes: false, excludeTaikasauva: false,
    excludeEdgeCases: false, showEnemies: true,
  });
  await rules.colors.initBiomeColors();
  const names = ["biome_map", "biome_map_newgame_plus", "biome_map_nightmare"];
  const maps = await Promise.all(names.map(async name => {
    const source = await readPng(`data/biome_maps/${name}.png`);
    const data = Uint8Array.from(source.data);
    for (let i = 0; i < data.length; i += 4)
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0x40) data[i + 2] = 0x42;
    return data;
  }));
  const [, overlay] = await Promise.all([
    Promise.all(Object.values(config).map(async biome => {
      biome.enabled = true;
      if (biome.wangFile) biome.wangData = await readPng(biome.wangFile);
    })),
    readPng("data/wang_tiles/extra_layers/coalmine.png"),
    rules.scenes.loadPixelSceneData(),
  ]);
  const geometry = createGeometryGenerator({
    biomeMaps: { ng0: maps[0], ngp: maps[1], nightmare: maps[2] },
    biomes: config, minesOverlay: overlay, blockedRoomColors: rules.sceneConfig.BLOCKED_COLORS,
    fillLayers: true, nightmarePlusPainter: true,
  });
  const shaftGenerator = createTerrainTileGenerator({
    biomes: { robobase: config.robobase }, blockedRoomColors: [], fillLayers: true,
  });
  // Geometry owns immutable template copies. Rules only need descriptors afterward.
  for (const biome of Object.values(config)) delete biome.wangData;
  releaseDecodedInputImages();
  let queue: Promise<unknown> = Promise.resolve();

  async function generate(request: WorldRequest, signal?: AbortSignal,
    onTerrainReady?: (terrain: NativeTerrainDescription) => void): Promise<NativeWorldDescription> {
    signal?.throwIfAborted();
    if (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff)
      throw new Error("Seed must be an unsigned 32-bit integer");
    const ngPlus = request.ngPlus ?? 0, gameMode = request.gameMode ?? "normal";
    if (!Number.isSafeInteger(ngPlus) || ngPlus < 0 || !["normal", "nightmare"].includes(gameMode))
      throw new Error("Invalid world mode");
    const horizontalWorlds = request.parallelWorlds ?? [-1, 0, 1];
    if (!horizontalWorlds.length || horizontalWorlds.some(pw => !Number.isSafeInteger(pw)) ||
      new Set(horizontalWorlds).size !== horizontalWorlds.length) throw new Error("Invalid parallel worlds");
    const calendar = request.calendar!;
    if (!Number.isInteger(calendar.month) || calendar.month < 1 || calendar.month > 12 ||
      !Number.isInteger(calendar.day) || calendar.day < 1 || calendar.day > 31)
      throw new Error("Invalid seasonal calendar");
    const start = performance.now();
    rules.settings.updateSettings({ gameMode, date: calendar });
    rules.unlocks.setUnlocks(request.dailySeed || request.unlocks == null
      ? Object.keys(rules.unlocks.UNLOCKABLES) : [...request.unlocks]);
    rules.scenes.clearPixelSceneBitmapCache();
    for (const scene of Object.values(rules.scenes.PIXEL_SCENE_DATA) as any[]) scene.variants = {};
    const options = { seed: request.seed, ngPlus, gameMode, signal };
    const biomeData = geometry.generateBiome(options);
    for (let i = 0; i < biomeData.pixels.length; i++) biomeData.pixels[i] |= 0xff000000;
    const width = biomeData.pixels.length / 48;
    const tileLayers = await geometry.generateTiles({ ...options, pixels: biomeData.pixels, width, height: 48 });
    const elevatorShafts: any[] = [], columns: number[] = [];
    for (const layer of tileLayers) {
      if (layer.biomeName !== "robobase" || !layer.buffer || layer.validChunks?.size !== 1) continue;
      const [claim] = layer.validChunks as Set<string>;
      const [x, y] = claim.split(",").map(Number);
      if (y !== 47 || (biomeData.pixels[y * width + x] & 0xffffff) !== 0x4e5267) continue;
      const pixels = new Uint32Array(width * 96);
      for (let sy = 47; sy < 96; sy++) pixels[sy * width + x] = config.robobase.color;
      const shafts = await shaftGenerator({ ...options, pixels, width, height: 96 });
      if (shafts.length !== 1 || shafts[0].validChunks?.size !== 49) throw new Error("Incomplete elevator");
      columns.push(x); elevatorShafts.push(shafts[0]);
    }
    const geometryMs = performance.now() - start;
    const spawns = rules.spawns.prescanSpawnFunctions(tileLayers, ngPlus > 0, gameMode);
    const lowerSpawns = columns.length ? spawns.filter((spawn: any) => !(
      spawn.sourceBiome === "robobase" && spawn.y >= 33 * 512 - 10 &&
      columns.includes(Math.floor((spawn.x + width * 256) / 512)))) : spawns;
    const shaftSpawns = rules.spawns.prescanSpawnFunctions(elevatorShafts, ngPlus > 0, gameMode)
      .filter((spawn: any) => spawn.y >= 34 * 512 && spawn.y < 82 * 512);
    const worldSize = rules.coordinates.getWorldSize(ngPlus > 0, gameMode),
      worldCenter = rules.coordinates.getWorldCenter(ngPlus > 0, gameMode);
    // Every later placement uses the prescan records and biome map, never the
    // layer buffers. The worker can now transfer those buffers exactly once.
    onTerrainReady?.({ seed: request.seed, ngPlus, gameMode, worldSize, worldCenter, biomeData, tileLayers, elevatorShafts });
    const regions: WorldRegion[] = [];
    for (const horizontal of horizontalWorlds) for (const vertical of [0, -1, 1] as const) {
      await yieldControl();
      signal?.throwIfAborted();
      let special: any[] = vertical === 0 ? [] : rules.spawns.getSpecialPoIs(biomeData, request.seed, ngPlus, horizontal, vertical, {}, gameMode);
      const scan = rules.spawns.scanSpawnFunctions(biomeData, vertical === 1 ? lowerSpawns : spawns,
        request.seed, ngPlus, horizontal, vertical, false, {}, gameMode);
      if (vertical === 0) special = rules.spawns.getSpecialPoIs(biomeData, request.seed, ngPlus, horizontal, vertical, {}, gameMode);
      // Match Noitamap's paint/marker order: shaft scenes precede lower static scenes.
      const pois = vertical === 0 ? [...scan.generatedSpawns, ...special] : [...special, ...scan.generatedSpawns];
      const scenes = [...scan.finalPixelScenes];
      if (vertical === 1 && shaftSpawns.length) {
        const shaft = rules.spawns.scanSpawnFunctions(biomeData, shaftSpawns,
          request.seed, ngPlus, horizontal, 0, false, {}, gameMode);
        pois.push(...shaft.generatedSpawns); scenes.push(...shaft.finalPixelScenes);
      }
      const fixed = rules.statics.addStaticPixelScenes(request.seed, ngPlus, horizontal, vertical,
        biomeData, false, {}, request.dailySeed ?? false, gameMode);
      pois.push(...(fixed?.pois ?? []));
      scenes.push(...(fixed?.pixelScenes ?? []));
      regions.push({ horizontal, vertical, pois,
        scenes: scenes.map(({ imgElement: _pixels, ...scene }: any) => scene) });
    }
    signal?.throwIfAborted();
    const totalMs = performance.now() - start;
    return { kind: "native-world-description", revision: assets.revision, seed: request.seed,
      ngPlus, gameMode, calendar, worldSize, worldCenter, biomeData,
      tileLayers, elevatorShafts, regions, timings: { geometryMs, placementsMs: totalMs - geometryMs, totalMs } };
  }
  return {
    generate(request: WorldRequest, signal?: AbortSignal, onTerrainReady?: (terrain: NativeTerrainDescription) => void) {
      const now = new Date();
      const snapshot = { ...request, unlocks: request.unlocks?.slice() ?? request.unlocks,
        parallelWorlds: request.parallelWorlds?.slice(),
        calendar: request.calendar ? { ...request.calendar } : { month: now.getMonth() + 1, day: now.getDate() } };
      const pending = queue.then(() => generate(snapshot, signal, onTerrainReady));
      queue = pending.catch(() => {});
      return pending;
    },
  };
}
