import { reconcileTempleCrystals } from "./temple-crystals";
import type { GenerationResult } from "./telescope-adapter";
import { completeGenerationBossPOIs } from "./boss-pois";
import { normalizeScenePOIs } from "./scene-pois";
import { CAPTURE_X_LIMIT } from "./world-coverage";

type WorldRecords = Pick<GenerationResult, "gameMode" | "worldSize" | "worldCenter" | "biomeData" | "poisByPW" | "pixelScenesByPW"> & Partial<Pick<GenerationResult, "isNGP">>;

/** Repairs can add missing room bosses on live, cached and baked paths. Apply the
 * capture boundary afterwards so a reload cannot reintroduce an off-map POI. */
export function finalizeGeneration<T extends WorldRecords>(input: T): T {
  const result = reconcileTempleCrystals(normalizeScenePOIs(completeGenerationBossPOIs(input)));
  if (!result.isNGP && result.gameMode !== "nightmare") return result;
  const poisByPW = { ...result.poisByPW };
  const pixelScenesByPW = { ...result.pixelScenesByPW };
  for (const [key, pois] of Object.entries(poisByPW)) {
    if (Math.abs(parseInt(key, 10)) >= 2)
      poisByPW[key] = pois.filter(p => p.x >= -CAPTURE_X_LIMIT && p.x < CAPTURE_X_LIMIT);
  }
  for (const [key, scenes] of Object.entries(pixelScenesByPW)) {
    if (Math.abs(parseInt(key, 10)) >= 2)
      pixelScenesByPW[key] = scenes.filter(s => s.x < CAPTURE_X_LIMIT && s.x + Math.max(1, s.width || 1) > -CAPTURE_X_LIMIT);
  }
  return { ...result, poisByPW, pixelScenesByPW };
}
