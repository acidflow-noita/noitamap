import { isGLTerrainEnabled } from "../renderer_settings";

/** Select one complete fork, not a mixture of generation and rendering tables. */
export function loadTelescopeModules(
  fullPixels = isGLTerrainEnabled(),
): Promise<any> {
  return fullPixels
    ? import("./full-pixel-telescope-exports")
    : import("./telescope-exports");
}
