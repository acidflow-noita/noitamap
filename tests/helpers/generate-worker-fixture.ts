import { installTelescopeShim } from "../../src/telescope/telescope-dom-shim";
import { installFetchInterceptor } from "../../src/telescope/telescope-data-bridge";

/** Generate real worker inputs from shipped PNGs/archives, not mocked POIs. */
export async function generateFixture(
  fullPixels: boolean,
  seed: number,
  includeTerrain = false,
) {
  installTelescopeShim();
  installFetchInterceptor(fullPixels);
  const { biome, tiles, config, png, scanner, settings, scenes, unlocks } =
    fullPixels
      ? await import("./full-pixel-generation-exports")
      : await import("./legacy-generation-exports");
  unlocks.setUnlocks(Object.keys(unlocks.UNLOCKABLES));
  settings.updateSettings({
    gameMode: "normal",
    clearSpawnPixels: true,
    recolorMaterials: true,
    enableEdgeNoise: true,
    fixHolyMountainEdgeNoise: true,
    enableStaticPixelScenes: "all",
    skipCosmeticScenes: false,
    excludeTaikasauva: false,
    excludeEdgeCases: false,
    showEnemies: true,
  });
  const base = await png.loadPNG("./data/biome_maps/biome_map.png");
  for (let i = 0; i < base.data.length; i += 4) {
    if (
      base.data[i] === 0 &&
      base.data[i + 1] === 0 &&
      base.data[i + 2] === 0x40
    )
      base.data[i + 2] = 0x42;
  }
  for (const entry of Object.values(config.GENERATOR_CONFIG) as any[]) {
    entry.enabled = true;
    if (entry.wangFile && !entry.wangData)
      entry.wangData = await png.loadPNG(entry.wangFile);
  }
  await scenes.loadPixelSceneData();
  const w = biome.BIOME_CONFIG.W_NG0,
    h = biome.BIOME_CONFIG.H_NG0;
  const biomeData = biome.generateBiomeData(seed, 0, "normal", base.data, w, h);
  for (let i = 0; i < biomeData.pixels.length; i++)
    biomeData.pixels[i] = (biomeData.pixels[i] | 0xff000000) >>> 0;
  const layers = await tiles.generateBiomeTiles(
    biomeData.pixels,
    w,
    h,
    config.GENERATOR_CONFIG,
    seed,
    0,
    0,
    "normal",
  );
  const tileSpawns = scanner.prescanSpawnFunctions(layers, false, "normal");
  return {
    ...(includeTerrain
      ? { tileLayers: layers, generatorConfig: config.GENERATOR_CONFIG }
      : {}),
    biomeData,
    tileSpawns,
    seed,
    ngPlus: 0,
    gameMode: "normal",
    fullPixels,
    perks: {},
    skipCosmeticScenes: false,
    unlocks: null,
    dailySeed: false,
  };
}
