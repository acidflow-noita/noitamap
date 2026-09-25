import { TERRAIN_VERSION } from "./terrain-policy";
import { useRenderPerfGeneration } from "../renderer_settings";

/** Separate raw generations AND fallback biome renders from the legacy fork. */
export function telescopeCacheKey(
  key: string,
  fullPixels = useRenderPerfGeneration(),
): string {
  return fullPixels ? `${TERRAIN_VERSION}|${key}` : key;
}
