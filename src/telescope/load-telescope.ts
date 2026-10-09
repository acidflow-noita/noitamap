import { useRenderPerfGeneration } from "../renderer_settings";

/** Select one complete fork, not a mixture of generation and rendering tables. */
export function loadTelescopeModules(
  fullPixels = useRenderPerfGeneration(),
): Promise<any> {
  return fullPixels
    ? import("./full-pixel-telescope-exports")
    : import("./telescope-exports");
}
