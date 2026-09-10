import Flatbush from "flatbush";
import type { GLTerrainGeneration } from "./gl-terrain-tile-source";
import {
  createPlaneOwnership,
  createBackgroundOwnership,
  WORLD_HEIGHT,
  WORLD_TOP,
} from "./terrain-policy";
import { includeElevatorOwnership } from "./terrain-elevator";

/** Exact known-empty regions can be skipped at ANY pyramid level. This never
 * discards detail: it avoids traversing thousands of transparent leaf tiles.
 * Scene backgrounds may extend beyond material-image dimensions. */
export function createTerrainFootprint(
  gen: GLTerrainGeneration,
  config: Record<string, any>,
  width: number,
) {
  const owners = createPlaneOwnership(
    gen.tileLayers,
    (gen.sourceBiomeData ?? gen.biomeData).pixels,
    gen.biomeData.pixels,
    config,
    width,
  );
  includeElevatorOwnership(owners, gen.elevatorShafts, gen.plane);
  const backgrounds = createBackgroundOwnership(
    owners,
    gen.biomeData.pixels,
    config,
    gen.plane ?? 0,
  );
  const y0 = WORLD_TOP + (gen.plane ?? 0) * WORLD_HEIGHT;
  const scenes = gen.sceneData?.scenes ?? [];
  const index = scenes.length ? new Flatbush(scenes.length) : null;
  for (const s of scenes) {
    const bg = gen.sceneData!.sources[s.key]?.backgroundArt;
    index!.add(
      s.x,
      s.y,
      s.x + Math.max(s.width, bg?.width ?? 0),
      s.y + Math.max(s.height, bg?.height ?? 0),
    );
  }
  index?.finish();
  return (x: number, y: number, w: number, h: number) => {
    if (index?.search(x, y, x + w, y + h).length) return true;
    // Wobbling borders may enter the neighboring chunk by up to 42px. Keep
    // this conservative; a false nonempty only costs work, false empty loses art.
    const pad = 42;
    const cy0 = Math.max(0, Math.floor((y - y0 - pad) / 512));
    const cy1 = Math.min(47, Math.floor((y + h - 1 - y0 + pad) / 512));
    for (let cy = cy0; cy <= cy1; cy++)
      for (
        let cx = Math.floor((x + width * 256 - pad) / 512);
        cx <= Math.floor((x + w - 1 + width * 256 + pad) / 512);
        cx++
      ) {
        const i = cy * width + (((cx % width) + width) % width);
        if (owners.owners[i] >= 0 || backgrounds.owners[i] >= 0) return true;
      }
    return false;
  };
}
